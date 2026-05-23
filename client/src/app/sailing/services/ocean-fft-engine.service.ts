/**
 * OceanFFTEngine — GPU-side FFT ocean compute pipeline (WebGPU / WGSL).
 *
 * Runs three frequency cascades on the GPU each frame:
 *   Cascade 0 — 1000 m domain  (swell, λ > 40 m)
 *   Cascade 1 —  200 m domain  (waves, λ 8–200 m)
 *   Cascade 2 —   25 m domain  (chop,  λ 1–25 m)
 *
 * Each cascade runs the same 4-stage pipeline:
 *   1. spectrum_init  — JONSWAP h₀(k), runs once / weather change
 *   2. time_evolve    — h̃(k,t) = h₀·e^(iωt) + h₀*(-k)·e^(-iωt), every frame
 *   3. fft_butterfly  — radix-2 Cooley–Tukey, 8 horizontal then 8 vertical passes
 *   4. fft_postprocess— permutation, pack displacement RGBA32F + normals RG16F
 *
 * CPU physics (buoyancy) stays in WaveEngine (Gerstner) — this service is
 * purely visual.  getHeightAt() delegates to WaveEngine for physics queries.
 *
 * Requires WebGPUEngine (BabylonJS 7.x).
 */

import { Injectable, inject } from '@angular/core';
import {
  WebGPUEngine, Scene, ComputeShader, UniformBuffer,
  RawTexture, Constants, StorageBuffer,
} from '@babylonjs/core';
import { WaveEngine } from './wave-engine';
import { Wind, SeaConditions } from '../models';
import { SceneService } from './scene.service';

// ── Grid constants ────────────────────────────────────────────────────────────

const N    = 256;                    // FFT grid side length — must be power of 2
const LOG2 = 8;                      // log2(N) = number of butterfly passes per axis
const G    = 9.81;

// Physical domain sizes (metres) for each cascade
const DOMAIN = [1000, 200, 25] as const;

// ── WGSL: Spectrum initialisation ────────────────────────────────────────────
//
// Generates the initial spectrum h₀(k) from a JONSWAP directional spectrum.
// Runs once on init and on every weather change.
// Output texture layout: RGBA32F
//   R = Re(h₀(k)),  G = Im(h₀(k)),  B = Re(h₀(-k)*),  A = Im(h₀(-k)*)

const SPEC_INIT_WGSL = /* wgsl */ `
struct Params {
  N          : u32,
  L          : f32,   // domain size (metres)
  windSpeed  : f32,   // m/s at 10 m
  windDirX   : f32,   // unit vector
  windDirZ   : f32,
  fetch      : f32,   // wind fetch (metres) — controls JONSWAP peak
  seed       : u32,
}

@group(0) @binding(0) var<uniform> p : Params;
@group(0) @binding(1) var h0_out : texture_storage_2d<rgba32float, write>;

const G : f32 = 9.81;

// PCG hash — good avalanche, cheap on GPU
fn pcg(v : u32) -> u32 {
  var s = v * 747796405u + 2891336453u;
  s = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (s >> 22u) ^ s;
}

// Two independent uniform [0,1) values from a single u32 seed
fn hash2(seed : u32) -> vec2<f32> {
  let a = pcg(seed);
  let b = pcg(a + 1u);
  return vec2<f32>(
    f32(a) / 4294967296.0,
    f32(b) / 4294967296.0,
  );
}

// Box-Muller: uniform → standard normal pair
fn gaussianPair(u : vec2<f32>) -> vec2<f32> {
  let eps  = 1e-7;
  let mag  = sqrt(-2.0 * log(max(u.x, eps)));
  let phi  = 6.283185307 * u.y;
  return vec2<f32>(mag * cos(phi), mag * sin(phi));
}

// JONSWAP directional power spectrum at wavenumber k (scalar magnitude)
fn jonswap(k : f32, kp : f32) -> f32 {
  if (k < 1e-6) { return 0.0; }
  let alpha  = 0.0081;
  let gamma  = 3.3;
  let sigma  = select(0.09, 0.07, k <= kp);

  // PM base
  let pm = alpha * G * G / (k * k * k * k) * exp(-1.25 * pow(kp / k, 4.0));
  // JONSWAP peak-enhancement
  let r  = exp(-0.5 * pow((sqrt(k / kp) - 1.0) / sigma, 2.0));
  return pm * pow(gamma, r);
}

// Directional spreading D(k, theta) — cos^2s model (Hasselmann 1980)
fn spreading(kdx : f32, kdz : f32, wdx : f32, wdz : f32) -> f32 {
  let cosA = kdx * wdx + kdz * wdz;   // dot(k_unit, wind_unit)
  let s    = 2.0;
  return max(0.0, pow(max(0.0, cosA), s * 2.0));
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let n = p.N;
  if (gid.x >= n || gid.y >= n) { return; }

  // Wavenumber vector (shifted so DC is at centre)
  let nx = i32(gid.x) - i32(n / 2u);
  let nz = i32(gid.y) - i32(n / 2u);
  let dk = 6.283185307 / p.L;           // 2π/L
  let kx = f32(nx) * dk;
  let kz = f32(nz) * dk;
  let km = sqrt(kx * kx + kz * kz);

  // Peak wavenumber from JONSWAP: kp = (g / (1.026 U)²)
  let kp = G / (1.026 * p.windSpeed * p.windSpeed);

  // Amplitude from spectrum
  var amp = 0.0;
  if (km > 1e-6) {
    let kdx  = kx / km;
    let kdz  = kz / km;
    let S    = jonswap(km, kp) * spreading(kdx, kdz, p.windDirX, p.windDirZ);
    let dkxy = dk * dk;
    amp  = sqrt(2.0 * S * dkxy);
  }

  // Independent Gaussian pair for (h₀(k), h₀(-k)*)
  let idx     = gid.y * n + gid.x;
  let seed    = p.seed ^ (idx * 1664525u + 1013904223u);
  let gauss1  = gaussianPair(hash2(seed));
  let seed2   = p.seed ^ ((n * n - 1u - idx) * 1664525u + 1013904223u);
  let gauss2  = gaussianPair(hash2(seed2));

  let h0_re   = amp * gauss1.x * 0.7071067811865476;
  let h0_im   = amp * gauss1.y * 0.7071067811865476;
  let h0c_re  = amp * gauss2.x * 0.7071067811865476;
  let h0c_im  = amp * gauss2.y * 0.7071067811865476;

  textureStore(h0_out, vec2<i32>(gid.xy), vec4<f32>(h0_re, h0_im, h0c_re, h0c_im));
}
`;

// ── WGSL: Time evolution ─────────────────────────────────────────────────────
//
// For each wavevector k, computes:
//   h̃(k,t) = h₀(k)·e^(iωt) + conj(h₀(-k))·e^(-iωt)
//   where ω = sqrt(g·|k|)  (deep-water dispersion)
//
// Also builds the choppy displacement and Jacobian components:
//   h̃_x = i·(kx/|k|)·h̃,   h̃_z = i·(kz/|k|)·h̃
//   h̃_jxx = -kx²/|k|·h̃,   h̃_jzz = -kz²/|k|·h̃
//
// Outputs four RGBA32F textures:
//   height   : (Re, Im, 0, 0)
//   chopX    : (Re, Im, 0, 0)
//   chopZ    : (Re, Im, 0, 0)
//   jacobian : (Re_jxx, Im_jxx, Re_jzz, Im_jzz)

const TIME_EVOLVE_WGSL = /* wgsl */ `
struct Params {
  N    : u32,
  L    : f32,
  time : f32,
  choppyScale : f32,   // 0.5–1.0 scales horizontal displacement
}

@group(0) @binding(0) var<uniform>  p       : Params;
@group(0) @binding(1) var           h0_tex  : texture_storage_2d<rgba32float, read>;
@group(0) @binding(2) var           ht_h    : texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var           ht_dx   : texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var           ht_dz   : texture_storage_2d<rgba32float, write>;
@group(0) @binding(5) var           ht_jac  : texture_storage_2d<rgba32float, write>;

fn cmul(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let n = p.N;
  if (gid.x >= n || gid.y >= n) { return; }

  // Sample h0(k) and h0(-k)* from the init texture
  let h0    = textureLoad(h0_tex, vec2<i32>(gid.xy));
  let h0_k  = h0.xy;
  let h0_nc = h0.zw;   // conj of h0(-k) stored directly

  // Wavenumber
  let nx = i32(gid.x) - i32(n / 2u);
  let nz = i32(gid.y) - i32(n / 2u);
  let dk = 6.283185307 / p.L;
  let kx = f32(nx) * dk;
  let kz = f32(nz) * dk;
  let km = sqrt(kx * kx + kz * kz);

  // Angular frequency deep-water dispersion ω = sqrt(g·|k|)
  let omega = sqrt(9.81 * km);

  // e^(iωt) = cos + i·sin,  e^(-iωt) = cos - i·sin
  let cosO  = cos(omega * p.time);
  let sinO  = sin(omega * p.time);
  let ePos  = vec2<f32>( cosO,  sinO);
  let eNeg  = vec2<f32>( cosO, -sinO);

  // h̃(k,t) = h₀(k)·e^+ + h₀(-k)*·e^-
  let h_tilde = cmul(h0_k, ePos) + cmul(h0_nc, eNeg);

  // Choppy displacement: i·(kdir)·h̃  where i = (0,1) so cmul(i,z) = (-z.y, z.x)
  var dt_dx = vec2<f32>(0.0, 0.0);
  var dt_dz = vec2<f32>(0.0, 0.0);
  var jac_xx = vec2<f32>(0.0, 0.0);
  var jac_zz = vec2<f32>(0.0, 0.0);

  if (km > 1e-6) {
    let kdx   = kx / km;
    let kdz   = kz / km;
    // i·kdx·h̃ = (-kdx·Im(h̃), kdx·Re(h̃))
    dt_dx  = p.choppyScale * vec2<f32>(-kdx * h_tilde.y,  kdx * h_tilde.x);
    dt_dz  = p.choppyScale * vec2<f32>(-kdz * h_tilde.y,  kdz * h_tilde.x);
    // Jacobian partial: -kx²/|k|·h̃ and -kz²/|k|·h̃
    let jxx = -(kx * kx) / km;
    let jzz = -(kz * kz) / km;
    jac_xx = vec2<f32>(jxx * h_tilde.x, jxx * h_tilde.y);
    jac_zz = vec2<f32>(jzz * h_tilde.x, jzz * h_tilde.y);
  }

  let coord = vec2<i32>(gid.xy);
  textureStore(ht_h,   coord, vec4<f32>(h_tilde.x, h_tilde.y, 0.0, 0.0));
  textureStore(ht_dx,  coord, vec4<f32>(dt_dx.x,   dt_dx.y,   0.0, 0.0));
  textureStore(ht_dz,  coord, vec4<f32>(dt_dz.x,   dt_dz.y,   0.0, 0.0));
  textureStore(ht_jac, coord, vec4<f32>(jac_xx.x,  jac_xx.y,  jac_zz.x, jac_zz.y));
}
`;

// ── WGSL: Radix-2 butterfly FFT pass ─────────────────────────────────────────
//
// One horizontal or vertical pass of the Cooley–Tukey DIT FFT.
// Called log2(N) times in each direction.
// Reads from `in_tex`, writes to `out_tex` — ping-pong between two scratch textures.
//
// stage     : 0 .. log2(N)-1
// direction : 0 = horizontal (rows), 1 = vertical (columns)

const FFT_BUTTERFLY_WGSL = /* wgsl */ `
struct Params {
  N         : u32,
  stage     : u32,   // 0..log2(N)-1
  direction : u32,   // 0=horizontal, 1=vertical
}

@group(0) @binding(0) var<uniform> p       : Params;
@group(0) @binding(1) var          in_tex  : texture_storage_2d<rgba32float, read>;
@group(0) @binding(2) var          out_tex : texture_storage_2d<rgba32float, write>;

fn cmul(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x);
}

// Bit-reversal permutation index for stage 0 (DIT input reorder)
fn bitrev(i : u32, bits : u32) -> u32 {
  var v = i;
  var r = 0u;
  for (var b = 0u; b < bits; b++) {
    r = (r << 1u) | (v & 1u);
    v >>= 1u;
  }
  return r;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = p.N;
  if (gid.x >= N || gid.y >= N) { return; }

  // Which axis index are we butterfly-ing along?
  let i = select(gid.x, gid.y, p.direction == 1u);   // index along butterfly axis
  let j = select(gid.y, gid.x, p.direction == 1u);   // index along orthogonal axis

  let half    = N >> (p.stage + 1u);
  let group   = i / (half * 2u);
  let posInGp = i % (half * 2u);

  // Indices of the two butterfly partners
  var i0 = group * half * 2u + (posInGp % half);
  var i1 = i0 + half;

  // At stage 0 apply bit-reversal permutation
  if (p.stage == 0u) {
    let bits = u32(log2(f32(N)));
    i0 = bitrev(i0, bits);
    i1 = bitrev(i1, bits);
  }

  // Load partner samples
  var coord0 = vec2<i32>(select(vec2<u32>(i0, j), vec2<u32>(j, i0), p.direction == 1u));
  var coord1 = vec2<i32>(select(vec2<u32>(i1, j), vec2<u32>(j, i1), p.direction == 1u));

  let s0 = textureLoad(in_tex, coord0).xy;
  let s1 = textureLoad(in_tex, coord1).xy;

  // Twiddle factor W_N^k = e^(-2πi·k/N) where k = posInGp % half
  let k     = posInGp % half;
  let angle = -6.283185307 * f32(k) / f32(N >> p.stage);
  let W     = vec2<f32>(cos(angle), sin(angle));

  // Butterfly: even index gets  s0 + W·s1
  //            odd  index gets  s0 - W·s1
  let Ws1  = cmul(W, s1);
  let even = s0 + Ws1;
  let odd  = s0 - Ws1;

  let out  = select(odd, even, posInGp < half);
  let outCoord = vec2<i32>(select(
    vec2<u32>(i, j),
    vec2<u32>(j, i),
    p.direction == 1u
  ));
  textureStore(out_tex, outCoord, vec4<f32>(out.x, out.y, 0.0, 0.0));
}
`;

// ── WGSL: Post-process ───────────────────────────────────────────────────────
//
// Applies the (-1)^(x+y) sign correction (DC-centre permutation).
// Combines the four FFT outputs into:
//   displacement_tex RGBA32F : (dx, height, dz, jacobian)
//   normals_tex      RG16F   : packed as RGBA32F here, uploaded as-is
//     R = nx (surface normal x-component)
//     G = nz (surface normal z-component)
//     BA = (0, 0) — ny derived as sqrt(1 - nx² - nz²)
//
// Jacobian J = 1 + (dDx/dx + dDz/dz) from the jac partial components.
// J < 0 → breaking wave — foam signal.

// ── WGSL: Post-process (rewritten) ───────────────────────────────────────────
//
// Reads the 2D-IFFTed height field from fft_h, then:
//   1. Applies the (-1)^(x+y) DC-centre sign correction.
//   2. Computes the surface normal using central finite differences of h.
//      This is correct — the old approach (using frequency-domain dx/dz as
//      normal proxies) produced garbage because dx/dz were never IFFTed.
//   3. Derives a Jacobian-like foam signal from the surface Laplacian:
//      high negative curvature (crest) → breaking foam.
//
// Outputs:
//   disp_out  RGBA32F : (0, height, 0, foam_jacobian)
//     — no horizontal choppiness until dx/dz get their own IFFT passes.
//   norm_out  RGBA32F : (nx, nz, 0, 1)
//     — ny reconstructed in the GLSL fragment shader as sqrt(1-nx²-nz²).

const FFT_POSTPROCESS_WGSL = /* wgsl */ `
struct Params {
  N           : u32,
  L           : f32,
  heightScale : f32,
  normalScale : f32,   // multiplies dh/dx and dh/dz — sharpens apparent normals
}

@group(0) @binding(0) var<uniform> p        : Params;
@group(0) @binding(1) var fft_h    : texture_storage_2d<rgba32float, read>;
@group(0) @binding(2) var disp_out : texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var norm_out : texture_storage_2d<rgba32float, write>;

// Load the sign-corrected, scaled height at grid index (ix, iz).
// Wraps with period N (tiling ocean).
fn loadH(ix : i32, iz : i32) -> f32 {
  let n    = i32(p.N);
  let xi   = ((ix % n) + n) % n;
  let zi   = ((iz % n) + n) % n;
  let sign = select(-1.0, 1.0, ((u32(xi) + u32(zi)) & 1u) == 0u);
  return textureLoad(fft_h, vec2<i32>(xi, zi)).x * sign * p.heightScale;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = p.N;
  if (gid.x >= N || gid.y >= N) { return; }

  let coord = vec2<i32>(gid.xy);
  let ix    = i32(gid.x);
  let iz    = i32(gid.y);

  let h  = loadH(ix,   iz  );
  let hR = loadH(ix+1, iz  );   // +X neighbour
  let hL = loadH(ix-1, iz  );   // -X
  let hF = loadH(ix,   iz+1);   // +Z
  let hB = loadH(ix,   iz-1);   // -Z

  // Central-difference gradient → surface normal N = normalize(-dh/dx, 1, -dh/dz)
  let texel = p.L / f32(N);
  let dhdx  = (hR - hL) / (2.0 * texel) * p.normalScale;
  let dhdz  = (hF - hB) / (2.0 * texel) * p.normalScale;
  let nlen  = sqrt(dhdx * dhdx + 1.0 + dhdz * dhdz);
  let nx    = -dhdx / nlen;
  let nz    = -dhdz / nlen;

  // Curvature (discrete Laplacian) — negative at wave crests.
  // Normalised by texel² so it's dimensionless; scale 0.6 is empirical.
  let laplacian = (hR + hL + hF + hB - 4.0 * h) / (texel * texel);
  let jacobian  = clamp(1.0 - max(0.0, -laplacian) * texel * 0.60, 0.0, 1.5);

  textureStore(disp_out, coord, vec4<f32>(0.0, h, 0.0, jacobian));
  textureStore(norm_out,  coord, vec4<f32>(nx, nz, 0.0, 1.0));
}
`;

// ── Per-cascade state ─────────────────────────────────────────────────────────

interface CascadeTextures {
  h0:     RawTexture;   // initial spectrum (init once)
  // Ping-pong scratch pair (for butterfly passes)
  pingA:  RawTexture;
  pingB:  RawTexture;
  // Evolved spectrum before IFFT
  ht_h:   RawTexture;
  ht_dx:  RawTexture;
  ht_dz:  RawTexture;
  ht_jac: RawTexture;
  // Final outputs (sampled by rendering shaders)
  displacement: RawTexture;
  normals:      RawTexture;
}

interface CascadeShaders {
  specInit:    ComputeShader;
  timeEvolve:  ComputeShader;
  fftHoriz:    ComputeShader[];   // LOG2 passes
  fftVert:     ComputeShader[];   // LOG2 passes
  postProcess: ComputeShader;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class OceanFFTEngine {
  private sceneService = inject(SceneService);
  private waveEngine   = inject(WaveEngine);   // kept for CPU physics

  private cascadeTex!: CascadeTextures[];
  private cascadeShd!: CascadeShaders[];

  // Per-cascade uniform buffers
  private ubSpec!:     UniformBuffer[];
  private ubEvolve!:   UniformBuffer[];
  private ubPost!:     UniformBuffer[];

  private elapsed = 0;
  private windSpeed  = 8.0;
  private windDirX   = 0.0;
  private windDirZ   = 1.0;
  private choppyScale = 0.8;

  // FFT dispatch dimensions: N/16 × N/16
  private readonly DX = N / 16;   // = 16

  // ── Init ───────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const engine = this.sceneService.engine;
    const scene  = this.sceneService.scene;

    this.cascadeTex = [];
    this.cascadeShd = [];
    this.ubSpec     = [];
    this.ubEvolve   = [];
    this.ubPost     = [];

    for (let c = 0; c < 3; c++) {
      this.cascadeTex.push(this.buildTextures(engine, scene));
      this.ubSpec.push(this.buildSpecParams(engine));
      this.ubEvolve.push(this.buildEvolveParams(engine));
      this.ubPost.push(this.buildPostParams(engine));
      this.cascadeShd.push(this.buildShaders(engine, c));
    }

    // Initialise spectra with default weather
    await this.initSpectra();
  }

  // ── Per-frame tick ─────────────────────────────────────────────────────────

  tick(dt: number): void {
    this.elapsed += dt;

    for (let c = 0; c < 3; c++) {
      // Update time in evolve uniform buffer
      this.ubEvolve[c].updateFloat('time', this.elapsed);
      this.ubEvolve[c].update();

      const shd = this.cascadeShd[c];
      const tex = this.cascadeTex[c];

      // Stage 1: time evolution
      shd.timeEvolve.dispatch(this.DX, this.DX, 1);

      // Stage 2a: horizontal butterfly (LOG2 passes, ping-pong)
      this.runFFTPasses(shd.fftHoriz, tex, 0);

      // Stage 2b: vertical butterfly (LOG2 passes, ping-pong)
      this.runFFTPasses(shd.fftVert, tex, 1);

      // Stage 3: postprocess → displacement + normals
      shd.postProcess.dispatch(this.DX, this.DX, 1);
    }
  }

  private runFFTPasses(
    passes: ComputeShader[],
    tex: CascadeTextures,
    direction: 0 | 1,
  ): void {
    // The butterfly starts from ht_h/ht_dx/ht_dz and ping-pongs in pingA/pingB.
    // For simplicity we run all channels sequentially.
    // TODO: for maximum performance, all channels could be packed into RGBA and
    //       run in a single pass — deferred as a future optimisation.
    for (let stage = 0; stage < LOG2; stage++) {
      passes[stage].dispatch(this.DX, this.DX, 1);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getDisplacementTex(cascade: number): RawTexture {
    return this.cascadeTex[cascade].displacement;
  }

  getNormalsTex(cascade: number): RawTexture {
    return this.cascadeTex[cascade].normals;
  }

  getDomain(cascade: number): number {
    return DOMAIN[cascade];
  }

  /** Delegates to CPU Gerstner engine for physics queries (buoyancy). */
  getHeightAt(wx: number, wz: number, t: number): number {
    return this.waveEngine.getHeightAt(wx, wz, t);
  }

  get beaufort(): number { return this.waveEngine.beaufort; }
  get totalAmplitude(): number { return this.waveEngine.totalAmplitude; }

  async updateWeather(wind: Wind, sea: SeaConditions): Promise<void> {
    this.waveEngine.updateWeather(wind, sea);

    this.windSpeed   = wind.speed;
    const hdgRad     = wind.fromBearingDeg * Math.PI / 180;
    this.windDirX    = Math.sin(hdgRad);
    this.windDirZ    = Math.cos(hdgRad);
    this.choppyScale = 0.5 + sea.choppiness * 0.5;

    await this.initSpectra();
  }

  // ── Texture factory ────────────────────────────────────────────────────────

  private buildTextures(engine: WebGPUEngine, scene: Scene): CascadeTextures {
    const fmt  = Constants.TEXTUREFORMAT_RGBA;
    const flt  = Constants.TEXTURETYPE_FLOAT;
    const near = Constants.TEXTURE_NEAREST_SAMPLINGMODE;
    const stor = Constants.TEXTURE_CREATIONFLAG_STORAGE;

    const make = (label: string) => new RawTexture(
      null, N, N, fmt, scene, false, false, near, flt, stor,
    );

    return {
      h0:    make('h0'),
      pingA: make('pingA'),
      pingB: make('pingB'),
      ht_h:   make('ht_h'),
      ht_dx:  make('ht_dx'),
      ht_dz:  make('ht_dz'),
      ht_jac: make('ht_jac'),
      displacement: make('disp'),
      normals:      make('nrm'),
    };
  }

  // ── Uniform buffer factories ───────────────────────────────────────────────

  private buildSpecParams(engine: WebGPUEngine): UniformBuffer {
    const ub = new UniformBuffer(engine);
    ub.addUniform('N',         1);
    ub.addUniform('L',         1);
    ub.addUniform('windSpeed', 1);
    ub.addUniform('windDirX',  1);
    ub.addUniform('windDirZ',  1);
    ub.addUniform('fetch',     1);
    ub.addUniform('seed',      1);
    ub.create();
    return ub;
  }

  private buildEvolveParams(engine: WebGPUEngine): UniformBuffer {
    const ub = new UniformBuffer(engine);
    ub.addUniform('N',           1);
    ub.addUniform('L',           1);
    ub.addUniform('time',        1);
    ub.addUniform('choppyScale', 1);
    ub.create();
    return ub;
  }

  private buildPostParams(engine: WebGPUEngine): UniformBuffer {
    const ub = new UniformBuffer(engine);
    ub.addUniform('N',           1);
    ub.addUniform('L',           1);
    ub.addUniform('heightScale', 1);
    ub.addUniform('normalScale', 1);
    ub.create();
    return ub;
  }

  // ── Shader factory ─────────────────────────────────────────────────────────

  private buildShaders(engine: WebGPUEngine, cascade: number): CascadeShaders {
    const tex = this.cascadeTex[cascade];
    const ubS = this.ubSpec[cascade];
    const ubE = this.ubEvolve[cascade];
    const ubP = this.ubPost[cascade];
    const sfx = `_c${cascade}`;

    // Spectrum init
    const specInit = new ComputeShader(`specInit${sfx}`, engine,
      { computeSource: SPEC_INIT_WGSL },
      { bindingsMapping: {
        p:      { group: 0, binding: 0 },
        h0_out: { group: 0, binding: 1 },
      }},
    );
    specInit.setUniformBuffer('p', ubS);
    specInit.setStorageTexture('h0_out', tex.h0);

    // Time evolution
    const timeEvolve = new ComputeShader(`timeEvolve${sfx}`, engine,
      { computeSource: TIME_EVOLVE_WGSL },
      { bindingsMapping: {
        p:      { group: 0, binding: 0 },
        h0_tex: { group: 0, binding: 1 },
        ht_h:   { group: 0, binding: 2 },
        ht_dx:  { group: 0, binding: 3 },
        ht_dz:  { group: 0, binding: 4 },
        ht_jac: { group: 0, binding: 5 },
      }},
    );
    timeEvolve.setUniformBuffer('p', ubE);
    timeEvolve.setStorageTexture('h0_tex', tex.h0);
    timeEvolve.setStorageTexture('ht_h',   tex.ht_h);
    timeEvolve.setStorageTexture('ht_dx',  tex.ht_dx);
    timeEvolve.setStorageTexture('ht_dz',  tex.ht_dz);
    timeEvolve.setStorageTexture('ht_jac', tex.ht_jac);

    // Build butterfly passes for horizontal and vertical
    const fftHoriz = this.buildButterflyPasses(engine, cascade, tex, 0);
    const fftVert  = this.buildButterflyPasses(engine, cascade, tex, 1);

    // Post-process — normals now derived from finite differences of height,
    // so we no longer need the raw fft_dx / fft_dz / fft_jac inputs (those
    // textures still hold un-IFFTed frequency-domain values anyway).
    const postProcess = new ComputeShader(`postProcess${sfx}`, engine,
      { computeSource: FFT_POSTPROCESS_WGSL },
      { bindingsMapping: {
        p:        { group: 0, binding: 0 },
        fft_h:    { group: 0, binding: 1 },
        disp_out: { group: 0, binding: 2 },
        norm_out: { group: 0, binding: 3 },
      }},
    );
    postProcess.setUniformBuffer('p', ubP);
    // After 8 horizontal + 8 vertical butterfly stages, the 2D IFFT result
    // lives in pingB (vertical stage 7, which is odd, writes pingB).
    postProcess.setStorageTexture('fft_h',    tex.pingB);
    postProcess.setStorageTexture('disp_out', tex.displacement);
    postProcess.setStorageTexture('norm_out', tex.normals);

    return { specInit, timeEvolve, fftHoriz, fftVert, postProcess };
  }

  private buildButterflyPasses(
    engine: WebGPUEngine,
    cascade: number,
    tex: CascadeTextures,
    direction: 0 | 1,
  ): ComputeShader[] {
    const passes: ComputeShader[] = [];
    const dirLabel = direction === 0 ? 'H' : 'V';

    for (let stage = 0; stage < LOG2; stage++) {
      const ub = new UniformBuffer(engine);
      ub.addUniform('N',         1);
      ub.addUniform('stage',     1);
      ub.addUniform('direction', 1);
      ub.create();
      ub.updateUInt('N',         N);
      ub.updateUInt('stage',     stage);
      ub.updateUInt('direction', direction);
      ub.update();

      const cs = new ComputeShader(
        `fft${dirLabel}_c${cascade}_s${stage}`, engine,
        { computeSource: FFT_BUTTERFLY_WGSL },
        { bindingsMapping: {
          p:       { group: 0, binding: 0 },
          in_tex:  { group: 0, binding: 1 },
          out_tex: { group: 0, binding: 2 },
        }},
      );
      cs.setUniformBuffer('p', ub);

      // Horizontal passes (direction=0): start from ht_h (frequency domain).
      // Vertical passes   (direction=1): start from pingB — the horizontal FFT
      //   output (LOG2=8 stages → last write is stage 7 → pingB).
      //   BUG if this reads ht_h again: you'd redo a column-only 1D FFT instead
      //   of completing the 2D IFFT.
      const startTex = direction === 0 ? tex.ht_h : tex.pingB;
      const readTex  = stage === 0 ? startTex : (stage % 2 === 0 ? tex.pingB : tex.pingA);
      const writeTex = stage % 2 === 0 ? tex.pingA : tex.pingB;

      cs.setStorageTexture('in_tex',  readTex);
      cs.setStorageTexture('out_tex', writeTex);

      passes.push(cs);
    }
    return passes;
  }

  // ── Spectrum initialisation (async dispatch) ───────────────────────────────

  private async initSpectra(): Promise<void> {
    for (let c = 0; c < 3; c++) {
      const L   = DOMAIN[c];
      const ub  = this.ubSpec[c];
      ub.updateUInt('N',         N);
      ub.updateFloat('L',        L);
      ub.updateFloat('windSpeed', Math.max(1, this.windSpeed));
      ub.updateFloat('windDirX', this.windDirX);
      ub.updateFloat('windDirZ', this.windDirZ);
      ub.updateFloat('fetch',    100000);  // 100 km fetch — open ocean
      ub.updateUInt('seed',      (c + 1) * 7919);  // prime seed per cascade
      ub.update();

      const evolveUB = this.ubEvolve[c];
      evolveUB.updateUInt('N',           N);
      evolveUB.updateFloat('L',          L);
      evolveUB.updateFloat('time',       0);
      evolveUB.updateFloat('choppyScale', this.choppyScale);
      evolveUB.update();

      const postUB = this.ubPost[c];
      postUB.updateUInt('N', N);
      postUB.updateFloat('L', L);
      // heightScale: 0.018 gives ~0.5–2 m waves at typical wind speeds without
      // violent vertex displacement that causes strobing normals.
      postUB.updateFloat('heightScale', this.windSpeed * 0.018 * Math.sqrt(L / 1000));
      // normalScale = 1.0: finite-difference normals are already physically
      // proportional to the real surface slope; boosting them past ~1 creates
      // extremely steep facets on cascade 2 (25 m / 256 = 10 cm texels) whose
      // specular angle flips every frame as the FFT evolves → epileptic strobing.
      postUB.updateFloat('normalScale', 1.0);
      postUB.update();

      await this.cascadeShd[c].specInit.dispatchWhenReady(this.DX, this.DX, 1);
    }
  }
}
