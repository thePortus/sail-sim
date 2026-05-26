import { Injectable, inject } from '@angular/core';
import {
  MeshBuilder, Vector2, Vector3, AbstractMesh, Mesh, ShaderMaterial, Scene,
  DirectionalLight, MirrorTexture, Plane,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanFFTEngine } from './ocean-fft-engine.service';
import { SeaConditions, Wind } from '../models';

// ── Vertex shader ─────────────────────────────────────────────────────────────
//
// Procedural wave displacement (Babylon NME model — simplified for WebGPU).
//
// Three-component model:
//   1. 2D Voronoi F1 × 2  — organic swell crests drifting downwind
//   2. 3-octave value-noise fBm — medium-frequency chop
//   3. Directional sine swell   — primary long-wavelength swell
//
// Deliberately uses only:
//   • smoothNoise() — 1 helper (_h), simple trilinear value noise
//   • voronoi2D()   — 9-iteration 2D cellular noise
// Avoids the full Simplex3D + 3D-Voronoi (27 iterations) that overwhelmed
// Babylon's GLSL→WGSL transpiler.
//
// FFT normal textures are still sampled in the fragment shader for micro-detail.

const OCEAN_VERT = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 worldViewProjection;
uniform mat4 world;

uniform vec2  u_WorldOffset;
uniform float u_MeshHalfSize;
uniform float u_DisplaceScale;
uniform float u_DomainC0;
uniform float u_DomainC1;
uniform float u_DomainC2;
uniform float u_Time;
uniform vec2  u_Direction;
uniform float u_WindSpeed;
uniform float u_WaveDepth;
uniform float u_WaveFreq;
uniform float u_DragMult;
uniform float u_Iterations;

varying vec3  v_worldPos;
varying float v_waveHeight;
varying vec2  v_uv_c0;
varying vec2  v_uv_c1;
varying vec2  v_uv_c2;
varying vec4  v_projPos;

vec2 wavedx(vec2 position, vec2 direction, float frequency, float timeshift) {
  float x = dot(direction, position) * frequency + timeshift;
  float wave = exp(sin(x) - 1.0);
  float dx = wave * cos(x);
  return vec2(wave, -dx);
}

float getwaves(vec2 position, float t) {
  float wavePhaseShift = length(position) * 0.1;
  float iter = 0.0;
  float frequency = 1.0;
  float timeMultiplier = 2.0;
  float weight = 1.0;
  float sum = 0.0;
  float sumW = 0.0;
  float timeScale = 0.55 + max(u_WindSpeed, 1.0) * 0.045;

  for (int i = 0; i < 24; i++) {
    if (float(i) >= u_Iterations) break;
    vec2 p = vec2(sin(iter), cos(iter));
    vec2 res = wavedx(position, p, frequency, t * timeMultiplier * timeScale + wavePhaseShift);
    position += p * res.y * weight * u_DragMult;
    sum += res.x * weight;
    sumW += weight;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }
  return sum / max(sumW, 1e-5);
}

void main() {
  float wx = position.x + u_WorldOffset.x;
  float wz = position.z + u_WorldOffset.y;

  // Edge-fade: blend displacement to zero near mesh boundary to hide seam.
  float d    = max(abs(position.x), abs(position.z));
  float fade = u_DisplaceScale * (1.0 - smoothstep(
    u_MeshHalfSize * 0.80,
    u_MeshHalfSize * 0.97,
    d
  ));

  // Per-cascade tiling UVs for FFT normal sampling in fragment shader.
  float u0 = fract(wx / u_DomainC0);  float v0 = fract(wz / u_DomainC0);
  float u1 = fract(wx / u_DomainC1);  float v1 = fract(wz / u_DomainC1);
  float u2 = fract(wx / u_DomainC2);  float v2 = fract(wz / u_DomainC2);

  vec3  pos = position;
  float h   = 0.0;

  if (fade > 0.001) {
    vec2 wavePos = vec2(
      wx * u_Direction.x + wz * u_Direction.y,
      -wx * u_Direction.y + wz * u_Direction.x
    ) * u_WaveFreq;
    h      = (getwaves(wavePos, u_Time) - 0.5) * u_WaveDepth;
    pos.y += h * fade;
  }

  v_worldPos   = (world * vec4(pos, 1.0)).xyz;
  v_waveHeight = h;
  v_uv_c0      = vec2(u0, v0);
  v_uv_c1      = vec2(u1, v1);
  v_uv_c2      = vec2(u2, v2);
  gl_Position  = worldViewProjection * vec4(pos, 1.0);
  v_projPos    = gl_Position;
}
`;

// ── Fragment shader ───────────────────────────────────────────────────────────
//
// Lighting pipeline:
//   1. FFT cascade normals  — micro-detail ripple from compute textures
//   2. Macro normals        — dFdx/dFdy(v_waveHeight) matches actual geometry
//   3. NME colour gradient  — trough navy → mid ocean blue → cyan crest
//   4. Schlick Fresnel      — F0 = 0.020 (water n ≈ 1.33)
//   5. SSS back-scatter     — teal glow through wave crests
//   6. GGX specular         — tight lobe (r=0.028), properly BRDF-normalised
//   7. RTT reflection       — screen-space mirror + analytical sky fallback
//   8. Height-threshold foam + Beaufort whitecaps
//   9. Horizon haze

const OCEAN_FRAG = `
precision highp float;

uniform float     u_Time;
uniform float     u_choppiness;
uniform float     u_DisplaceScale;
uniform float     u_Beaufort;
uniform float     u_MaxCascade;
uniform float     u_WindSpeed;
uniform float     u_WaveDepth;
uniform float     u_WaveFreq;
uniform float     u_DragMult;
uniform float     u_Iterations;
uniform float     u_NormEpsilon;
uniform vec3      u_cameraPosition;
uniform vec3      u_sunDir;
uniform vec3      u_sunColor;
uniform vec3      u_skyColorA;
uniform vec3      u_skyColorB;
uniform sampler2D u_norm0;
uniform sampler2D u_norm1;
uniform sampler2D u_norm2;
uniform sampler2D u_reflectionSampler;

varying vec3  v_worldPos;
varying float v_waveHeight;
varying vec2  v_uv_c0;
varying vec2  v_uv_c1;
varying vec2  v_uv_c2;
varying vec4  v_projPos;

vec2 wavedx(vec2 position, vec2 direction, float frequency, float timeshift) {
  float x = dot(direction, position) * frequency + timeshift;
  float wave = exp(sin(x) - 1.0);
  float dx = wave * cos(x);
  return vec2(wave, -dx);
}

float getwaves(vec2 position, float t) {
  float wavePhaseShift = length(position) * 0.1;
  float iter = 0.0;
  float frequency = 1.0;
  float timeMultiplier = 2.0;
  float weight = 1.0;
  float sum = 0.0;
  float sumW = 0.0;
  float timeScale = 0.55 + max(u_WindSpeed, 1.0) * 0.045;

  for (int i = 0; i < 24; i++) {
    if (float(i) >= u_Iterations) break;
    vec2 p = vec2(sin(iter), cos(iter));
    vec2 res = wavedx(position, p, frequency, t * timeMultiplier * timeScale + wavePhaseShift);
    position += p * res.y * weight * u_DragMult;
    sum += res.x * weight;
    sumW += weight;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }
  return sum / max(sumW, 1e-5);
}

vec3 waveNormal(vec2 pos, float e, float depth, float t) {
  vec2 ex = vec2(e, 0.0);
  float H = getwaves(pos, t) * depth;
  vec3 a = vec3(pos.x, H, pos.y);
  return normalize(
    cross(
      a - vec3(pos.x - e, getwaves(pos - ex, t) * depth, pos.y),
      a - vec3(pos.x, getwaves(pos + ex.yx, t) * depth, pos.y + e)
    )
  );
}

vec3 extra_cheap_atmosphere(vec3 raydir, vec3 sundir) {
  float special_trick = 1.0 / (raydir.y * 1.0 + 0.1);
  float special_trick2 = 1.0 / (sundir.y * 11.0 + 1.0);
  float raysundt = pow(abs(dot(sundir, raydir)), 2.0);
  vec3 suncolor = mix(vec3(1.0),
                      max(vec3(0.0), vec3(1.0) - vec3(5.5, 13.0, 22.4) / 22.4),
                      special_trick2);
  vec3 bluesky = vec3(5.5, 13.0, 22.4) / 22.4 * suncolor;
  vec3 bluesky2 = max(vec3(0.0),
                      bluesky - vec3(5.5, 13.0, 22.4) * 0.002 *
                      (special_trick - 6.0 * sundir.y * sundir.y));
  bluesky2 *= special_trick * (0.24 + raysundt * 0.24);
  return bluesky2 * (1.0 + pow(1.0 - raydir.y, 3.0));
}

vec3 getAtmosphere(vec3 dir) {
  return extra_cheap_atmosphere(dir, normalize(u_sunDir)) * 0.5;
}

vec3 getSun(vec3 dir) {
  float sunN = pow(max(0.0, dot(dir, normalize(u_sunDir))), 720.0) * 210.0;
  return u_sunColor * sunN;
}

vec3 aces_tonemap(vec3 color) {
  mat3 m1 = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  mat3 m2 = mat3(
    1.60475, -0.10208, -0.00327,
    -0.53108, 1.10813, -0.07276,
    -0.07367, -0.00605, 1.07602
  );
  vec3 v = m1 * color;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return pow(clamp(m2 * (a / b), 0.0, 1.0), vec3(1.0 / 2.2));
}

void main() {
  float t = u_Time;
  float depth = u_WaveDepth * u_DisplaceScale;
  float dist = length(v_worldPos - u_cameraPosition);
  vec2 wavePos = vec2(
    v_worldPos.x * u_Direction.x + v_worldPos.z * u_Direction.y,
    -v_worldPos.x * u_Direction.y + v_worldPos.z * u_Direction.x
  ) * u_WaveFreq;

  vec3 ray = normalize(v_worldPos - u_cameraPosition);
  vec3 N = waveNormal(wavePos, u_NormEpsilon, depth, t);

  // Distance flattening mirrors the playground approach and helps avoid
  // high-frequency shimmer on far LODs.
  N = mix(
    N,
    vec3(0.0, 1.0, 0.0),
    0.8 * min(1.0, sqrt(dist * 0.01) * 1.1)
  );

  // Blend in FFT micro-normals so near-field ripple detail is preserved.
  vec2 n0 = texture2D(u_norm0, v_uv_c0).xy;
  vec3 fftN = normalize(vec3(n0.x, sqrt(max(0.0, 1.0 - dot(n0, n0))), n0.y));
  if (u_MaxCascade >= 1.0) {
    vec2 n1 = texture2D(u_norm1, v_uv_c1).xy;
    vec3 f1 = normalize(vec3(n1.x, sqrt(max(0.0, 1.0 - dot(n1, n1))), n1.y));
    fftN = normalize(fftN + f1 * (1.0 - smoothstep(900.0, 2200.0, dist)));
  }
  if (u_MaxCascade >= 2.0) {
    vec2 n2 = texture2D(u_norm2, v_uv_c2).xy;
    vec3 f2 = normalize(vec3(n2.x, sqrt(max(0.0, 1.0 - dot(n2, n2))), n2.y));
    fftN = normalize(fftN + f2 * (1.0 - smoothstep(280.0, 700.0, dist)));
  }
  float fftBlend = clamp(0.15 + u_choppiness * 0.35, 0.0, 0.5);
  N = normalize(mix(N, fftN, fftBlend));

  float fresnel = 0.04 + (1.0 - 0.04) * pow(1.0 - max(0.0, dot(-N, ray)), 5.0);

  vec3 R = normalize(reflect(ray, N));
  R.y = abs(R.y);
  vec3 analyticRefl = getAtmosphere(R) + getSun(R);

  vec2 screenUV = (v_projPos.xy / v_projPos.w) * 0.5 + 0.5;
  screenUV += N.xz * 0.022;
  screenUV = clamp(screenUV, 0.001, 0.999);
  vec3 rttRefl = texture2D(u_reflectionSampler, screenUV).rgb;
  vec3 reflection = mix(analyticRefl, rttRefl, 0.80);

  // Mild body scattering keeps wave troughs from becoming pitch black.
  float hNorm = clamp(v_waveHeight / max(u_WaveDepth, 0.001) + 0.5, 0.0, 1.0);
  vec3 deepCol  = vec3(0.0293, 0.0698, 0.1717) * 0.24;
  vec3 crestCol = vec3(0.08, 0.28, 0.38) * 0.35;
  vec3 scattering = mix(deepCol, crestCol, hNorm);

  float bftT = clamp((u_Beaufort - 4.0) / 6.0, 0.0, 1.0);
  float foam = smoothstep(0.70, 1.0, hNorm) * (0.20 + bftT * bftT * 0.55);

  vec3 color = fresnel * reflection + scattering;
  color = mix(color, vec3(0.93, 0.96, 0.99), foam * u_DisplaceScale);

  float fogT = clamp((dist - 2600.0) / 9000.0, 0.0, 1.0);
  vec3 fogColor = mix(u_skyColorA * 0.92, u_skyColorB * 1.06, 0.55);
  color = mix(color, fogColor, fogT * fogT * 0.82);

  gl_FragColor = vec4(aces_tonemap(color * 2.0), 1.0);
}
`;

// ── Kelvin wake shaders (unchanged) ──────────────────────────────────────────
const WAKE_VERT = `
precision highp float;
attribute vec3 position; attribute vec2 uv;
varying vec2 vUV;
uniform mat4 worldViewProjection;
void main(){ vUV = uv; gl_Position = worldViewProjection * vec4(position, 1.0); }
`;

const WAKE_FRAG = `
precision highp float;
varying vec2 vUV;
uniform float time; uniform float speed; uniform float planeW; uniform float planeL;
void main(){
  float lx = (vUV.x - 0.5) * planeW;
  float lz = (1.0 - vUV.y) * planeL;
  if (lz < 1.0) { gl_FragColor = vec4(0.0); return; }
  float kelvinArm  = abs(lx) - lz * 0.354;
  float lengthFade = exp(-lz * 0.0045);
  float armFoam    = exp(-kelvinArm * kelvinArm * 0.016) * lengthFade;
  float tPhase  = lz * 0.09 - time * 1.7;
  float trans   = (sin(tPhase) * 0.5 + 0.5) * exp(-lz * 0.006) * exp(-lx * lx * 0.0005);
  float dPhase  = kelvinArm * 0.13 - time * 1.1;
  float diverg  = (sin(dPhase) * 0.5 + 0.5) * armFoam;
  float r       = sqrt(lx * lx + lz * lz);
  float centre  = exp(-r * 0.035) * (1.0 - exp(-r * 0.22)) * exp(-lx * lx * 0.07);
  float foam    = clamp(armFoam * 0.52 + trans * 0.20 + diverg * 0.12 + centre * 0.36, 0.0, 1.0) * speed;
  gl_FragColor  = vec4(1.0, 1.0, 1.0, foam * 0.80);
}
`;

// ── CPU port of GPU waveHeight() ─────────────────────────────────────────────
//
// Mirrors the GLSL `waveHeight(wx, wz)` in OCEAN_VERT exactly so that the CPU
// buoyancy sampler sees the same surface height as the rendered ocean vertex.
// Called 8× per physics tick (once per hull point) — fast enough on the CPU.

function _fract(x: number): number { return x - Math.floor(x); }

/** Playground wave primitive — returns [wave, -dx]. */
function _wavedx(px: number, py: number, dx: number, dy: number, frequency: number, timeShift: number): [number, number] {
  const x = (dx * px + dy * py) * frequency + timeShift;
  const wave = Math.exp(Math.sin(x) - 1.0);
  const ddx = wave * Math.cos(x);
  return [wave, -ddx];
}

/** CPU port of playground getwaves() — used by buoyancy parity path. */
function _getWaves(px0: number, py0: number, t: number, windSpeed: number, dragMult: number, iterations: number): number {
  let px = px0;
  let py = py0;
  const wavePhaseShift = Math.hypot(px, py) * 0.1;
  const timeScale = 0.55 + Math.max(windSpeed, 1.0) * 0.045;
  let iter = 0.0;
  let frequency = 1.0;
  let timeMultiplier = 2.0;
  let weight = 1.0;
  let sum = 0.0;
  let sumW = 0.0;

  const n = Math.max(1, Math.min(24, Math.floor(iterations)));
  for (let i = 0; i < n; i++) {
    const dx = Math.sin(iter);
    const dy = Math.cos(iter);
    const [wave, negDx] = _wavedx(px, py, dx, dy, frequency, t * timeMultiplier * timeScale + wavePhaseShift);
    px += dx * negDx * weight * dragMult;
    py += dy * negDx * weight * dragMult;
    sum += wave * weight;
    sumW += weight;
    weight *= 0.8;
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }

  return sum / Math.max(sumW, 1e-5);
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class OceanService {
  private sceneService = inject(SceneService);
  private fftEngine    = inject(OceanFFTEngine);

  private oceanMeshNear!: Mesh;          // ultra-close LOD centered on boat
  private oceanMesh0!:   Mesh;
  private oceanMesh1!:   Mesh;
  private oceanMeshFar!: Mesh;
  private oceanMatNear!: ShaderMaterial;
  private oceanMat0!:    ShaderMaterial;
  private oceanMat1!:    ShaderMaterial;
  private oceanMatFar!:  ShaderMaterial;

  private wakePlane!: Mesh;
  private wakeMat!:   ShaderMaterial;

  private reflectionRTT!: MirrorTexture;

  private elapsed    = 0;
  private boatX      = 0;
  private boatZ      = 0;
  private boatHdgR   = 0;
  private boatSpeed  = 0;

  // Wind state — updated by updateWeather(), used for per-frame uniform upload.
  private windSpeed = 8.0;
  private windDirX  = 0.0;
  private windDirZ  = 1.0;

  // ── LOD geometry constants ─────────────────────────────────────────────────
  // LOD hierarchy (vertex spacing):
  //   NEAR  80 m ×  80 m, 256 subs →  0.31 m/vert — hull precision (boat-centred)
  //   LOD0 800 m × 800 m, 512 subs →  1.56 m/vert — smooth close-up (camera-centred)
  //   LOD1  4 km ×  4 km, 128 subs → 31.25 m/vert — mid-range swell
  //   FAR 200 km ×200 km,  32 subs →  flat        — horizon fill, no displacement
  private readonly NEAR_SIZE = 80;
  private readonly NEAR_SUB  = 256;
  private readonly LOD0_SIZE = 800;
  private readonly LOD0_SUB  = 512;   // was 256 — doubled for smooth close-up
  private readonly LOD1_SIZE = 4_000;
  private readonly LOD1_SUB  = 128;
  private readonly FAR_SIZE  = 200_000;
  private readonly FAR_SUB   = 32;

  private readonly WAKE_W      = 180;
  private readonly WAKE_L      = 320;
  private readonly BOAT_HALF_L =   7.0;

  // Playground-style wave tuning. Near and LOD0 use full quality;
  // LOD1/FAR are reduced for performance.
  private readonly WAVE_FREQ = 0.18;
  private readonly WAVE_DRAG = 0.38;
  private readonly WAVE_DEPTH_NEAR = 3.0;
  private readonly WAVE_DEPTH_MID  = 2.3;
  private readonly WAVE_DEPTH_FAR  = 1.5;

  // ── Init ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.fftEngine.init();

    const { scene } = this.sceneService;
    this.buildReflectionRTT(scene);
    this.buildLodFar(scene);
    this.buildLod1(scene);
    this.buildLod0(scene);
    this.buildLodNear(scene);
    this.buildWakePlane(scene);
    this.registerRenderLoop(scene);
  }

  // ── Reflection RTT ────────────────────────────────────────────────────────

  private buildReflectionRTT(scene: Scene): void {
    // 1024 px gives crisp, close-up reflections; 512 looks blurry at hull range.
    this.reflectionRTT = new MirrorTexture('oceanReflection', 1024, scene, true);
    this.reflectionRTT.mirrorPlane = new Plane(0, -1, 0, 0);
    this.reflectionRTT.renderList  = [];

    // Seed with the sky — always present and covers the whole horizon.
    const skybox = scene.getMeshByName('skybox');
    if (skybox) this.reflectionRTT.renderList!.push(skybox);

    // CRITICAL: register as a custom render target so BabylonJS renders it
    // every frame.  Without this entry the ShaderMaterial sampler receives a
    // blank texture — BabylonJS only auto-renders RTTs that are wired through
    // StandardMaterial / PBRMaterial reflection slots, not ShaderMaterial.
    scene.customRenderTargets.push(this.reflectionRTT);

    // Island meshes arrive asynchronously (HTTP load).  Auto-enroll them so
    // we don't need a separate manual call after each island is built.
    // Vessel parts are enrolled via the explicit addToRenderList() calls in
    // vessel.service.ts (which run after the vessel mesh is created).
    scene.onNewMeshAddedObservable.add((mesh) => {
      if (mesh.name.startsWith('island_')) {
        this.addToRenderList(mesh);
      }
    });
  }

  // ── LOD meshes ─────────────────────────────────────────────────────────────

  private buildLodFar(scene: Scene): void {
    this.oceanMeshFar = MeshBuilder.CreateGround('ocean_far', {
      width: this.FAR_SIZE, height: this.FAR_SIZE, subdivisions: this.FAR_SUB,
    }, scene);
    this.oceanMeshFar.renderingGroupId = 0;
    this.oceanMatFar = this.buildOceanMaterial(scene, 'oceanMatFar', 0.0, this.FAR_SIZE / 2, -1);
    this.oceanMeshFar.material = this.oceanMatFar;
  }

  private buildLod1(scene: Scene): void {
    this.oceanMesh1 = MeshBuilder.CreateGround('ocean_lod1', {
      width: this.LOD1_SIZE, height: this.LOD1_SIZE, subdivisions: this.LOD1_SUB,
    }, scene);
    this.oceanMesh1.renderingGroupId = 1;
    this.oceanMesh1.position.y       = 0.002;
    this.oceanMat1 = this.buildOceanMaterial(scene, 'oceanMat1', 1.0, this.LOD1_SIZE / 2, 1);
    this.oceanMesh1.material = this.oceanMat1;
  }

  private buildLod0(scene: Scene): void {
    this.oceanMesh0 = MeshBuilder.CreateGround('ocean_lod0', {
      width: this.LOD0_SIZE, height: this.LOD0_SIZE, subdivisions: this.LOD0_SUB,
    }, scene);
    this.oceanMesh0.renderingGroupId = 2;
    this.oceanMesh0.position.y       = 0.004;
    this.oceanMat0 = this.buildOceanMaterial(scene, 'oceanMat0', 1.0, this.LOD0_SIZE / 2, 2);
    this.oceanMesh0.material = this.oceanMat0;
  }

  /**
   * Ultra-close near-boat LOD — 0.31 m vertex spacing for wave resolution
   * directly under the hull.  Centred on the boat (not the camera) so it
   * stays precisely aligned with the physics-sampled wave surface.
   * Rendered in group 2 at y+0.006 — just above LOD0 (+0.004) so depth-testing
   * always keeps the denser near surface visible through the coarser one.
   * The shader's edge-fade smoothstep (80 %–97 % of halfSize = 32–39 m from
   * boat centre) blends the displacement gracefully to zero at the seam.
   */
  private buildLodNear(scene: Scene): void {
    this.oceanMeshNear = MeshBuilder.CreateGround('ocean_near', {
      width: this.NEAR_SIZE, height: this.NEAR_SIZE, subdivisions: this.NEAR_SUB,
    }, scene);
    this.oceanMeshNear.renderingGroupId = 2;
    this.oceanMeshNear.position.y       = 0.006;   // above LOD0 (0.004) — wins depth test
    this.oceanMatNear = this.buildOceanMaterial(scene, 'oceanMatNear', 1.0, this.NEAR_SIZE / 2, 2);
    this.oceanMeshNear.material = this.oceanMatNear;
  }

  // ── Ocean ShaderMaterial factory ──────────────────────────────────────────

  private buildOceanMaterial(
    scene:         Scene,
    name:          string,
    displaceScale: number,
    meshHalfSize:  number,
    maxCascade:    number,
  ): ShaderMaterial {
    const mat = new ShaderMaterial(name, scene,
      { vertexSource: OCEAN_VERT, fragmentSource: OCEAN_FRAG },
      {
        attributes: ['position', 'uv'],
        uniforms: [
          'world', 'worldViewProjection',
          'u_WorldOffset', 'u_MeshHalfSize', 'u_DisplaceScale', 'u_MaxCascade',
          'u_DomainC0', 'u_DomainC1', 'u_DomainC2',
          'u_Time', 'u_choppiness', 'u_Beaufort',
          'u_WaveDepth', 'u_WaveFreq', 'u_DragMult', 'u_Iterations', 'u_NormEpsilon',
          'u_Direction', 'u_WindSpeed',
          'u_cameraPosition',
          'u_sunDir', 'u_sunColor', 'u_skyColorA', 'u_skyColorB',
        ],
        samplers: [
          // FFT normals only — procedural vertex displacement no longer reads disp textures.
          'u_norm0', 'u_norm1', 'u_norm2',
          'u_reflectionSampler',
        ],
        needAlphaBlending: false,
      },
    );

    // When the FFT engine is inactive (WebGL fallback), cap cascade usage at 0
    // so the fragment shader only samples the dummy 1×1 flat-normal texture once
    // rather than three times.  Procedural vertex displacement still runs fine.
    const effectiveCascade = this.fftEngine.isActive ? maxCascade : Math.min(maxCascade, 0);
    const waveDepth = maxCascade >= 2 ? this.WAVE_DEPTH_NEAR : maxCascade >= 1 ? this.WAVE_DEPTH_MID : this.WAVE_DEPTH_FAR;
    const iterationCount = maxCascade >= 2 ? 24 : maxCascade >= 1 ? 16 : 9;
    const normEpsilon = maxCascade >= 2 ? 0.010 : maxCascade >= 1 ? 0.018 : 0.032;

    mat.setFloat('u_DisplaceScale', displaceScale);
    mat.setFloat('u_MeshHalfSize',  meshHalfSize);
    mat.setFloat('u_MaxCascade',    effectiveCascade);
    mat.setFloat('u_DomainC0', this.fftEngine.getDomain(0));
    mat.setFloat('u_DomainC1', this.fftEngine.getDomain(1));
    mat.setFloat('u_DomainC2', this.fftEngine.getDomain(2));

    mat.setFloat('u_choppiness', 0.40);
    mat.setFloat('u_Beaufort',    1.0);
    mat.setFloat('u_WindSpeed',   this.windSpeed);
    mat.setFloat('u_WaveDepth',   waveDepth);
    mat.setFloat('u_WaveFreq',    this.WAVE_FREQ);
    mat.setFloat('u_DragMult',    this.WAVE_DRAG);
    mat.setFloat('u_Iterations',  iterationCount);
    mat.setFloat('u_NormEpsilon', normEpsilon);
    mat.setVector2('u_Direction', new Vector2(this.windDirX, this.windDirZ));

    mat.setVector3('u_sunDir',    new Vector3(0.5, 0.85, 0.2).normalize());
    mat.setVector3('u_sunColor',  new Vector3(1.00, 0.95, 0.80));
    mat.setVector3('u_skyColorA', new Vector3(0.22, 0.48, 0.72));
    mat.setVector3('u_skyColorB', new Vector3(0.08, 0.28, 0.58));

    mat.setFloat('u_Time', 0);
    mat.setVector3('u_cameraPosition', Vector3.Zero());
    mat.setVector2('u_WorldOffset',    new Vector2(0, 0));

    mat.setTexture('u_reflectionSampler', this.reflectionRTT);
    this.uploadFFTTextures(mat);

    return mat;
  }

  // ── Upload FFT normal textures ────────────────────────────────────────────

  private uploadFFTTextures(mat: ShaderMaterial): void {
    mat.setTexture('u_norm0', this.fftEngine.getNormalsTex(0));
    mat.setTexture('u_norm1', this.fftEngine.getNormalsTex(1));
    mat.setTexture('u_norm2', this.fftEngine.getNormalsTex(2));
  }

  // ── Kelvin wake plane ──────────────────────────────────────────────────────

  private buildWakePlane(scene: Scene): void {
    this.wakePlane = MeshBuilder.CreateGround('wakePlane', {
      width: this.WAKE_W, height: this.WAKE_L, subdivisions: 1,
    }, scene);
    this.wakePlane.isPickable    = false;
    this.wakePlane.renderingGroupId = 2;

    this.wakeMat = new ShaderMaterial('wakeMat', scene,
      { vertexSource: WAKE_VERT, fragmentSource: WAKE_FRAG },
      {
        attributes: ['position', 'uv'],
        uniforms:   ['worldViewProjection', 'time', 'speed', 'planeW', 'planeL'],
        needAlphaBlending: true,
      },
    );
    this.wakeMat.setFloat('planeW', this.WAKE_W);
    this.wakeMat.setFloat('planeL', this.WAKE_L);
    this.wakeMat.setFloat('time',   0);
    this.wakeMat.setFloat('speed',  0);
    this.wakeMat.backFaceCulling = false;
    this.wakePlane.material = this.wakeMat;
  }

  // ── Per-frame render loop ──────────────────────────────────────────────────

  private registerRenderLoop(scene: Scene): void {
    scene.registerBeforeRender(() => {
      const dt = scene.getEngine().getDeltaTime() * 0.001;
      this.elapsed += dt;

      this.fftEngine.tick(dt);

      const cam = scene.activeCamera;
      const t   = this.elapsed;

      if (cam) {
        const cx   = cam.position.x;
        const cz   = cam.position.z;
        const wOff = new Vector2(cx, cz);
        const camV = cam.position;

        // Near mesh — centre on the boat, not the camera, for hull-precision waves.
        // WorldOffset must match mesh centre so the shader computes correct world coords.
        const nearOff = new Vector2(this.boatX, this.boatZ);
        this.oceanMeshNear.position.x = this.boatX;
        this.oceanMeshNear.position.z = this.boatZ;
        this.oceanMatNear.setVector2('u_WorldOffset',    nearOff);
        this.oceanMatNear.setVector3('u_cameraPosition', camV);

        this.oceanMesh0.position.x = cx; this.oceanMesh0.position.z = cz;
        this.oceanMat0.setVector2('u_WorldOffset',    wOff);
        this.oceanMat0.setVector3('u_cameraPosition', camV);

        this.oceanMesh1.position.x = cx; this.oceanMesh1.position.z = cz;
        this.oceanMat1.setVector2('u_WorldOffset',    wOff);
        this.oceanMat1.setVector3('u_cameraPosition', camV);

        this.oceanMeshFar.position.x = cx; this.oceanMeshFar.position.z = cz;
        this.oceanMatFar.setVector2('u_WorldOffset',    wOff);
        this.oceanMatFar.setVector3('u_cameraPosition', camV);
      }

      const beaufortV = this.fftEngine.beaufort;
      const windDir   = new Vector2(this.windDirX, this.windDirZ);
      const allMats   = [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar];

      for (const mat of allMats) {
        mat.setFloat('u_Time',      t);
        mat.setFloat('u_Beaufort',  beaufortV);
        mat.setFloat('u_WindSpeed', this.windSpeed);
        mat.setVector2('u_Direction', windDir);
      }

      const dl = scene.lights.find(l => l instanceof DirectionalLight) as DirectionalLight | undefined;
      if (dl) {
        const sunDir = dl.direction.negate().normalize();
        const sunCol = new Vector3(dl.diffuse.r, dl.diffuse.g, dl.diffuse.b);
        const elev   = Math.max(0, sunDir.y);
        const skyA   = new Vector3(0.18 + elev * 0.48, 0.36 + elev * 0.38, 0.76 + elev * 0.22);
        const skyB   = new Vector3(0.06 + elev * 0.22, 0.18 + elev * 0.26, 0.58 + elev * 0.26);
        for (const mat of allMats) {
          mat.setVector3('u_sunDir',    sunDir);
          mat.setVector3('u_sunColor',  sunCol);
          mat.setVector3('u_skyColorA', skyA);
          mat.setVector3('u_skyColorB', skyB);
        }
      }

      this.wakeMat.setFloat('time',  t);
      this.wakeMat.setFloat('speed', Math.min(1, Math.abs(this.boatSpeed) / 8));
      const shift = this.WAKE_L / 2 - this.BOAT_HALF_L;
      this.wakePlane.position.x = this.boatX - Math.sin(this.boatHdgR) * shift;
      this.wakePlane.position.z = this.boatZ - Math.cos(this.boatHdgR) * shift;
      this.wakePlane.rotation.y = this.boatHdgR;
      this.wakePlane.position.y = this.fftEngine.getHeightAt(this.boatX, this.boatZ, t) + 0.12;
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getWaveHeightAt(wx: number, wz: number, t: number): number {
    return this.fftEngine.getHeightAt(wx, wz, t);
  }

  /**
   * CPU port of the GPU vertex shader's `waveHeight(wx, wz)`.
   *
   * Produces the same wave height as the rendered ocean surface for a given
   * world position and simulation time.  Use this (rather than
   * WaveEngine.getHeightAt) whenever the CPU height must match the visual
   * surface — e.g. hull buoyancy sampling in VesselBuoyancyService.
   *
   * The shader reads `u_WindSpeed`, `u_Direction`, and `u_Time`; the CPU
   * equivalents (windSpeed, windDirX/Z) are kept in sync by updateWeather().
   */
  getVisualHeightAt(wx: number, wz: number, t: number): number {
    const px = (wx * this.windDirX + wz * this.windDirZ) * this.WAVE_FREQ;
    const py = (-wx * this.windDirZ + wz * this.windDirX) * this.WAVE_FREQ;
    const h = (_getWaves(px, py, t, this.windSpeed, this.WAVE_DRAG, 24) - 0.5) * this.WAVE_DEPTH_NEAR;
    return h;
  }

  setBoatTransform(x: number, z: number, hdgRad: number, speed: number): void {
    this.boatX     = x;
    this.boatZ     = z;
    this.boatHdgR  = hdgRad;
    this.boatSpeed = speed;
  }

  updateWeather(wind: Wind, sea: SeaConditions): void {
    this.fftEngine.updateWeather(wind, sea);

    this.windSpeed = wind.speed;
    const hdgRad   = wind.fromBearingDeg * Math.PI / 180;
    this.windDirX  = Math.sin(hdgRad);
    this.windDirZ  = Math.cos(hdgRad);

    const chop = sea.choppiness;
    for (const mat of [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar]) {
      if (mat) mat.setFloat('u_choppiness', chop);
    }
  }

  // O(1) dedup — island meshes arrive via both the onNewMeshAdded observable and
  // explicit addToRenderList() calls; vegetation instances arrive only via the
  // direct call.  The Set avoids O(n) Array.includes() on a potentially large list.
  private renderListSet = new Set<AbstractMesh>();

  addToRenderList(mesh: AbstractMesh): void {
    if (this.reflectionRTT?.renderList && !this.renderListSet.has(mesh)) {
      this.renderListSet.add(mesh);
      this.reflectionRTT.renderList.push(mesh);
    }
  }

  getOceanMesh(): Mesh { return this.oceanMesh0; }
}
