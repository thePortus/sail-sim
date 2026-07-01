/**
 * GPU scatter placement (WebGPU-compute roadmap P3) — compute twins of the scatter.service CPU
 * builders (grass, rocks, driftwood, trees, palms — plus their flat shadow-blob variants via a
 * shadowMode uniform). One invocation per patch cell: gates (height band, slope, town pads,
 * clustering noise, density accept, variant deal) → instance matrix + tint, atomically compacted
 * into the patch's storage buffers (GpuScatterPatch), which the thin-instance renderer reads
 * DIRECTLY. The atomic count is read back asynchronously (4 bytes) to set the draw count.
 *
 * Statistical ports, not bit-exact ones: nothing on the CPU consumes scatter positions, so the GPU
 * hash needs the same LOOK (density, clustering character), not the same bits. The hash is
 * deliberately sinless (Metal fast-math sin() flatlines at large args).
 *
 * One dispatch per kernel per frame (queued): Babylon UniformBuffer updates are queue-ordered, so
 * two dispatches sharing one UBO in a single frame would both read the LAST values written.
 *
 * WGSL rules (hard-won): NO semicolons and NO backticks inside WGSL comments — Babylon's compute
 * preprocessor line-splits on ';' even in comments and template literals end at backticks.
 */
import {
  ComputeShader, UniformBuffer, Scene, Texture, Vector2, Vector4, WebGPUEngine, Observer,
} from '@babylonjs/core';
import { ComputeHelper } from '../ocean-fft/compute-helper';
import { GpuScatterPatch } from './instancing/gpu-scatter-patch';

/** Oriented town-pad exclusion box, prefiltered by the caller (max 2 per patch). */
export interface PadBox { cx: number; cz: number; hx: number; hz: number; sin: number; cos: number }

export interface HeightFieldGPU { tex: Texture; wbounds: Vector4; texSize: Vector2 }

// ── Shared WGSL prelude: params, bindings, noise, terrain sampling, matrix emit ─────────────────
const PRELUDE = /* wgsl */ `
struct Params {
  patchCenter: vec2f,     // patch centre in world XZ
  patchSize: f32,         // patch edge length in metres
  densityMul: f32,        // quality-tier density multiplier
  variant: f32,           // variant this layer owns, or -1 = keep all (shadow blobs)
  capacity: f32,          // instance capacity of the patch buffers
  texSize: vec2f,         // heightfield texel count (full width/height)
  wbounds: vec4f,         // heightfield world bounds: minX, minZ, sizeX, sizeZ
  pad0a: vec4f,           // town pad 0: cx, cz, halfX, halfZ
  pad0b: vec4f,           // town pad 0: sin, cos, enabled, unused
  pad1a: vec4f,           // town pad 1: cx, cz, halfX, halfZ
  pad1b: vec4f,           // town pad 1: sin, cos, enabled, unused
  extra: vec4f,           // x: shadowMode (1 = emit flat blob discs), yzw: unused
};

@group(0) @binding(0) var<storage, read_write> mats: array<mat4x4f>;
@group(0) @binding(1) var<storage, read_write> cols: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(3) var heightTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> params: Params;

const TAU: f32 = 6.28318530718;
const SHADOW_LIFT: f32 = 0.06;

// Sinless hash (Dave Hoskins hash12) — same statistics as the CPU sin-hash without Metal's
// fast-math sin flatline at large arguments
fn hash2(p: vec2f) -> f32 {
  var q = fract(p * vec2f(0.1031, 0.1030));
  q = q + dot(q, q.yx + vec2f(33.33, 33.33));
  return fract((q.x + q.y) * q.x);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 4-octave fractal value noise in [0,1] — mirrors the CPU fbm2 octave offsets
fn fbm2(p: vec2f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  var norm = 0.0;
  for (var o = 0; o < 4; o++) {
    sum = sum + amp * vnoise(p * freq + vec2f(f32(o) * 19.3, f32(o) * -7.1));
    norm = norm + amp;
    amp = amp * 0.5;
    freq = freq * 2.0;
  }
  return sum / norm;
}

// Sharper-than-smoothstep gate (the CPU step01) — double smoothstep
fn step01(a: f32, b: f32, x: f32) -> f32 {
  let s = smoothstep(a, b, x);
  return s * s * (3.0 - 2.0 * s);
}

// Bilinear heightfield sample at world XZ — same texel convention as the terrain clipmap
fn groundAt(wx: f32, wz: f32) -> f32 {
  let u = (wx - params.wbounds.x) / params.wbounds.z;
  let v = (params.wbounds.y + params.wbounds.w - wz) / params.wbounds.w;
  let fxy = vec2f(u, v) * params.texSize - vec2f(0.5, 0.5);
  let i0 = vec2i(floor(fxy));
  let f = fxy - floor(fxy);
  let mx = vec2i(params.texSize) - vec2i(1, 1);
  let h00 = textureLoad(heightTex, clamp(i0,                vec2i(0), mx), 0).r;
  let h10 = textureLoad(heightTex, clamp(i0 + vec2i(1, 0),  vec2i(0), mx), 0).r;
  let h01 = textureLoad(heightTex, clamp(i0 + vec2i(0, 1),  vec2i(0), mx), 0).r;
  let h11 = textureLoad(heightTex, clamp(i0 + vec2i(1, 1),  vec2i(0), mx), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

// Local slope in m/m over one heightfield texel — mirrors the CPU slopeAt (which uses cellM, not E)
fn slopeAt(px: f32, pz: f32, baseY: f32) -> f32 {
  let d = params.wbounds.z / params.texSize.x;
  return length(vec2f(groundAt(px + d, pz) - baseY, groundAt(px, pz + d) - baseY)) / d;
}

// Filled-disk shoreline scan (3 rings x 8 staggered spokes) — mirrors the CPU nearShoreline
fn nearShore(px: f32, pz: f32, minDist: f32) -> bool {
  for (var r = 1; r <= 3; r++) {
    let d = (f32(r) / 3.0) * minDist;
    for (var i = 0; i < 8; i++) {
      let a = (f32(i) / 8.0) * TAU + f32(r) * 0.4;
      if (groundAt(px + cos(a) * d, pz + sin(a) * d) <= 0.4) { return true; }
    }
  }
  return false;
}

fn inPad(px: f32, pz: f32, a: vec4f, b: vec4f) -> bool {
  if (b.z < 0.5) { return false; }
  let dx = px - a.x;
  let dz = pz - a.y;
  let along = dx * b.x + dz * b.y;
  let across = dx * b.y - dz * b.x;
  return abs(along) <= a.w && abs(across) <= a.z;
}

fn inAnyPad(px: f32, pz: f32) -> bool {
  return inPad(px, pz, params.pad0a, params.pad0b) || inPad(px, pz, params.pad1a, params.pad1b);
}

fn qmul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

// Babylon Quaternion.RotationYawPitchRoll (yaw about Y, then pitch about X, then roll about Z)
fn qYawPitchRoll(yaw: f32, pitch: f32, roll: f32) -> vec4f {
  let qy = vec4f(0.0, sin(yaw * 0.5), 0.0, cos(yaw * 0.5));
  let qx = vec4f(sin(pitch * 0.5), 0.0, 0.0, cos(pitch * 0.5));
  let qz = vec4f(0.0, 0.0, sin(roll * 0.5), cos(roll * 0.5));
  return qmul(qy, qmul(qx, qz));
}

// Compose scale * rotation * translation with Babylon's row-major float[16] layout — WGSL columns
// hold Babylon ROWS (translation lands at floats 12..14, validated in the P3 spike)
fn composeMat(q: vec4f, sx: f32, sy: f32, sz: f32, px: f32, y: f32, pz: f32) -> mat4x4f {
  let x = q.x; let yy = q.y; let z = q.z; let w = q.w;
  let r0 = vec3f(1.0 - 2.0 * (yy * yy + z * z), 2.0 * (x * yy + w * z), 2.0 * (x * z - w * yy)) * sx;
  let r1 = vec3f(2.0 * (x * yy - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (yy * z + w * x)) * sy;
  let r2 = vec3f(2.0 * (x * z + w * yy), 2.0 * (yy * z - w * x), 1.0 - 2.0 * (x * x + yy * yy)) * sz;
  return mat4x4f(vec4f(r0, 0.0), vec4f(r1, 0.0), vec4f(r2, 0.0), vec4f(px, y, pz, 1.0));
}

// Append one instance — returns false when the patch is full (drop the rest, matches CPU caps)
fn emit(m: mat4x4f, col: vec4f) -> bool {
  let slot = atomicAdd(&counter, 1u);
  if (slot >= u32(params.capacity)) { return false; }
  mats[slot] = m;
  cols[slot] = col;
  return true;
}

// Flat shadow-blob disc of the given footprint radius (identity rotation — the blob plugin
// stretches it away from the sun)
fn emitShadow(px: f32, groundY: f32, pz: f32, radius: f32) {
  let d = radius * 2.0;
  let m = mat4x4f(
    vec4f(d, 0.0, 0.0, 0.0), vec4f(0.0, 1.0, 0.0, 0.0), vec4f(0.0, 0.0, d, 0.0),
    vec4f(px, groundY + SHADOW_LIFT, pz, 1.0));
  _ = emit(m, vec4f(1.0));
}

// Jittered candidate position for cell (x, z) of an RxR patch grid — same construction as the CPU
fn candidate(x: f32, z: f32, res: f32) -> vec2f {
  let cx = params.patchCenter.x;
  let cz = params.patchCenter.y;
  let cell = params.patchSize / res;
  let px = cx + (x + hash2(vec2f(cx + x * 12.9, cz + z * 78.2))) * cell - params.patchSize * 0.5;
  let pz = cz + (z + hash2(vec2f(cx + x * 39.3 + 7.1, cz + z * 11.7 - 3.3))) * cell - params.patchSize * 0.5;
  return vec2f(px, pz);
}

// Variant deal: each accepted candidate belongs to exactly one variant (negative variant keeps all)
fn dealtAway(px: f32, pz: f32, n: f32) -> bool {
  if (params.variant < 0.0) { return false; }
  return u32(hash2(vec2f(px * 0.71 + 50.0, pz * 0.67 - 50.0)) * n) != u32(params.variant);
}

fn tintJitter(px: f32, pz: f32, base: vec3f, amp: f32) -> vec4f {
  let j = vec3f(
    (hash2(vec2f(px * 8.1, pz * 8.3)) - 0.5) * amp,
    (hash2(vec2f(px * 8.3, pz * 8.1)) - 0.5) * amp,
    (hash2(vec2f(px * 8.7, pz * 8.9)) - 0.5) * amp,
  );
  return vec4f(max(base + j, vec3f(0.0)), 1.0);
}
`;

const MAIN_OPEN = /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(RES) || id.y >= u32(RES)) { return; }
  let pos = candidate(f32(id.x), f32(id.y), RES);
  let px = pos.x;
  let pz = pos.y;
  let shadow = params.extra.x > 0.5;
`;

// ── Grass: rare lush bushes, 3-6 full-tuft burst (updated wide-footprint clumps), 5 tints ───────
// KEEP burst/radius/tints IN SYNC with scatter.service buildGrass + GRASS_TINTS.
export const GRASS_WGSL = PRELUDE + /* wgsl */ `
const RES: f32 = 28.0;
const BURST: f32 = 6.0;
const BUSH_R: f32 = 0.9;

fn emitClump(px: f32, pz: f32, y: f32) -> bool {
  let s = 0.7 + hash2(vec2f(px * 5.3 - 2.0, pz * 4.7 + 8.0)) * 0.9;
  let yaw = hash2(vec2f(px * 1.13 + 7.0, pz * 1.07 - 7.0)) * TAU;
  var tints = array<vec3f, 5>(
    vec3f(0.88, 1.00, 0.78), vec3f(1.00, 1.00, 0.72), vec3f(1.05, 0.92, 0.55),
    vec3f(1.12, 0.84, 0.42), vec3f(1.15, 0.95, 0.55),
  );
  let ti = u32(hash2(vec2f(px * 0.9 - 11.0, pz * 0.9 + 11.0)) * 5.0) % 5u;
  return emit(
    composeMat(qYawPitchRoll(yaw, 0.0, 0.0), s, s, s, px, y - 0.02, pz),
    tintJitter(px, pz, tints[ti], 0.08));
}
` + MAIN_OPEN + /* wgsl */ `
  let y = groundAt(px, pz);
  if (y < 0.6) { return; }
  if (inAnyPad(px, pz)) { return; }
  let slope = slopeAt(px, pz, y);
  if (slope > 0.7) { return; }

  let region = fbm2(vec2f(px / 45.0 + 120.0, pz / 45.0 - 60.0));
  let bush = fbm2(vec2f(px / 5.0 + 31.0, pz / 5.0 + 17.0));
  let core = step01(0.50, 0.78, bush);
  let coreD = core * core * core;
  let alt = 1.0 - smoothstep(90.0, 140.0, y);
  // FOREST: lush, near-continuous coverage on inland/higher ground (base meadow floor + denser bush hearts).
  let forestRegion = step01(0.34, 0.50, region);
  let forestCover = 0.55 + 0.45 * coreD;
  let lowland = smoothstep(1.5, 13.0, y);
  let forestDens = forestRegion * forestCover * lowland;
  // BEACH: modest grass on the sand band (~old forest amount) — cubed bush cores only, no meadow floor.
  let beachBand = smoothstep(0.7, 1.8, y) * (1.0 - smoothstep(4.0, 11.0, y));
  let beachRegion = step01(0.50, 0.62, region);
  let beachDens = beachRegion * coreD * beachBand * 0.85;
  let density = max(forestDens, beachDens) * alt * (1.0 - slope * 0.7) * params.densityMul;
  if (hash2(vec2f(px * 3.1 + 1.7, pz * 2.9 - 3.3)) > density) { return; }
  if (dealtAway(px, pz, 2.0)) { return; }

  if (!emitClump(px, pz, y)) { return; }
  let blades = u32(3.0 + coreD * (BURST - 3.0));
  for (var b = 1u; b < blades; b++) {
    let fb = f32(b);
    let ang = hash2(vec2f(px * (3.1 + fb * 0.7) + fb * 1.7, pz * (2.3 + fb * 0.5) - fb * 2.9)) * TAU;
    let rad = sqrt(hash2(vec2f(px * (5.7 + fb) + 3.0, pz * (1.9 + fb) - 3.0))) * BUSH_R;
    let jx = px + cos(ang) * rad;
    let jz = pz + sin(ang) * rad;
    if (!emitClump(jx, jz, groundAt(jx, jz))) { return; }
  }
}
`;

// ── Rocks: beach shelf + upland fields, size mix small/big/boulder, tumble rotation, 6 tints ────
export const ROCKS_WGSL = PRELUDE + /* wgsl */ `
const RES: f32 = 24.0;
` + MAIN_OPEN + /* wgsl */ `
  let y = groundAt(px, pz);
  if (y < 0.25 || y > 150.0) { return; }
  if (inAnyPad(px, pz)) { return; }
  let slope = slopeAt(px, pz, y);
  if (slope > 0.85) { return; }

  let clump = fbm2(vec2f(px / 18.0, pz / 18.0));
  let beach = 1.0 - smoothstep(7.0, 14.0, y);
  let upland = smoothstep(12.0, 45.0, y);
  let bandMul = 0.45 + 0.55 * beach + 0.6 * upland;
  let dens = (0.004 + 0.085 * smoothstep(0.60, 0.82, clump)) * bandMul * (1.0 - slope * 0.4) * params.densityMul;
  if (hash2(vec2f(px * 3.1 + 1.7, pz * 2.9 - 3.3)) > dens) { return; }
  if (dealtAway(px, pz, 3.0)) { return; }

  let r = hash2(vec2f(px * 5.3 - 2.0, pz * 4.7 + 8.0));
  var base = 0.25 + hash2(vec2f(px * 6.1 + 9.0, pz * 6.1 - 9.0)) * 0.4;
  if (r < 0.05) { base = 1.8 + hash2(vec2f(px * 2.2, pz * 2.2)) * 1.7; }
  else if (r < 0.30) { base = 0.7 + hash2(vec2f(px * 1.9 + 3.0, pz * 1.9 - 3.0)) * 0.7; }
  let sx = base * (0.85 + hash2(vec2f(px * 7.7, pz * 1.3)) * 0.35);
  let sy = base * (0.60 + hash2(vec2f(px * 1.3, pz * 7.7)) * 0.40);
  let sz = base * (0.85 + hash2(vec2f(px * 3.7, pz * 9.1)) * 0.35);
  // Disc floor (0.8 m) so small rocks still throw a visible skirt, proportional x1.3 for boulders (KEEP IN
  // SYNC with scatter.service buildRocks). The old flat x1.15 tucked the disc under the rock → looked shadowless.
  if (shadow) { emitShadow(px, y, pz, max(0.8, max(sx, sz) * 1.3)); return; }

  let q = qYawPitchRoll(
    hash2(vec2f(px * 1.11 + 4.0, pz * 1.07 - 4.0)) * TAU,
    (hash2(vec2f(px * 2.3, pz * 5.1)) - 0.5) * 0.5,
    (hash2(vec2f(px * 5.1, pz * 2.3)) - 0.5) * 0.5);
  // GENTLE near-neutral tints — the 3 photoreal PBR rock textures carry the colour now (KEEP IN SYNC with
  // scatter.service ROCK_TINTS).
  var tints = array<vec3f, 6>(
    vec3f(1.00, 1.00, 1.00), vec3f(0.92, 0.90, 0.87), vec3f(0.87, 0.89, 0.93),
    vec3f(1.00, 0.97, 0.92), vec3f(0.91, 0.93, 0.90), vec3f(0.96, 0.96, 0.99),
  );
  let ti = u32(hash2(vec2f(px * 0.9 - 11.0, pz * 0.9 + 11.0)) * 6.0) % 6u;
  _ = emit(composeMat(q, sx, sy, sz, px, y - base * 0.1, pz), tintJitter(px, pz, tints[ti], 0.10));
}
`;

// ── Driftwood: tide-line drifts, uniform scale mix, slight settle tumble, 6 tints ───────────────
export const DRIFT_WGSL = PRELUDE + /* wgsl */ `
const RES: f32 = 20.0;
` + MAIN_OPEN + /* wgsl */ `
  let y = groundAt(px, pz);
  if (y < 0.25 || y > 7.0) { return; }
  if (inAnyPad(px, pz)) { return; }
  let slope = slopeAt(px, pz, y);
  if (slope > 0.75) { return; }

  let clump = fbm2(vec2f(px / 16.0 + 40.0, pz / 16.0 - 22.0));
  let dens = (0.004 + 0.07 * smoothstep(0.60, 0.82, clump)) * (1.0 - slope * 0.4) * params.densityMul;
  if (hash2(vec2f(px * 3.1 + 1.7, pz * 2.9 - 3.3)) > dens) { return; }
  if (dealtAway(px, pz, 3.0)) { return; }

  let r = hash2(vec2f(px * 5.3 - 2.0, pz * 4.7 + 8.0));
  var s = 0.45 + hash2(vec2f(px * 6.1 + 9.0, pz * 6.1 - 9.0)) * 0.25;
  if (r < 0.15) { s = 1.2 + hash2(vec2f(px * 2.2, pz * 2.2)) * 0.6; }
  else if (r < 0.70) { s = 0.7 + hash2(vec2f(px * 1.9 + 3.0, pz * 1.9 - 3.0)) * 0.5; }
  if (shadow) { emitShadow(px, y, pz, s * 1.15); return; }

  let q = qYawPitchRoll(
    hash2(vec2f(px * 1.11 + 4.0, pz * 1.07 - 4.0)) * TAU,
    (hash2(vec2f(px * 2.3, pz * 5.1)) - 0.5) * 0.3,
    (hash2(vec2f(px * 5.1, pz * 2.3)) - 0.5) * 0.3);
  // Gentle tints — driftwood now uses the bark PBR sets (KEEP IN SYNC with scatter.service DRIFT_TINTS).
  var tints = array<vec3f, 6>(
    vec3f(1.00, 1.00, 1.02), vec3f(1.02, 1.00, 0.96), vec3f(0.96, 0.93, 0.88),
    vec3f(0.90, 0.86, 0.80), vec3f(0.97, 0.94, 0.88), vec3f(0.86, 0.88, 0.90),
  );
  let ti = u32(hash2(vec2f(px * 0.9 - 11.0, pz * 0.9 + 11.0)) * 6.0) % 6u;
  _ = emit(composeMat(q, s, s, s, px, y - 0.03, pz), tintJitter(px, pz, tints[ti], 0.08));
}
`;

// ── Forest beeches: stands with clearings, gentle inland ground, shoreline setback, no tint ─────
export const TREES_WGSL = PRELUDE + /* wgsl */ `
const RES: f32 = 16.0;
` + MAIN_OPEN + /* wgsl */ `
  let y = groundAt(px, pz);
  if (y < 0.6 || y > 80.0) { return; }
  if (inAnyPad(px, pz)) { return; }
  let slope = slopeAt(px, pz, y);
  if (slope > 0.5) { return; }

  let stand = fbm2(vec2f(px / 45.0, pz / 45.0));
  let clearing = fbm2(vec2f(px / 13.0 + 9.0, pz / 13.0 - 4.0));
  let dens = smoothstep(0.46, 0.72, stand) * smoothstep(0.4, 0.62, clearing)
    * (1.0 - slope * 0.8) * 0.18 * params.densityMul;
  if (hash2(vec2f(px * 3.1 + 1.7, pz * 2.9 - 3.3)) > dens) { return; }
  if (dealtAway(px, pz, 2.0)) { return; }
  if (nearShore(px, pz, 7.0)) { return; }

  let s = 0.9 + hash2(vec2f(px * 5.3 - 2.0, pz * 4.7 + 8.0)) * 0.22;
  if (shadow) { emitShadow(px, y, pz, s * 4.2); return; }
  let yaw = hash2(vec2f(px * 1.13 + 7.0, pz * 1.07 - 7.0)) * TAU;
  _ = emit(composeMat(qYawPitchRoll(yaw, 0.0, 0.0), s, s, s, px, y - 0.35, pz), vec4f(1.0));
}
`;

// ── Beach palms: coastal groves on the sand/low-coast band, shoreline setback, no tint ──────────
export const PALMS_WGSL = PRELUDE + /* wgsl */ `
const RES: f32 = 14.0;
` + MAIN_OPEN + /* wgsl */ `
  let y = groundAt(px, pz);
  if (y < 0.6 || y > 45.0) { return; }
  if (inAnyPad(px, pz)) { return; }
  let slope = slopeAt(px, pz, y);
  if (slope > 0.5) { return; }

  let stand = fbm2(vec2f(px / 28.0 + 60.0, pz / 28.0 - 40.0));
  let dens = smoothstep(0.48, 0.80, stand) * (1.0 - slope * 0.6) * 0.95 * params.densityMul;
  if (hash2(vec2f(px * 3.1 + 1.7, pz * 2.9 - 3.3)) > dens) { return; }
  if (dealtAway(px, pz, 2.0)) { return; }
  if (nearShore(px, pz, 7.0)) { return; }

  let s = 0.92 + hash2(vec2f(px * 5.3 - 2.0, pz * 4.7 + 8.0)) * 0.16;
  if (shadow) { emitShadow(px, y, pz, s * 2.6); return; }
  let yaw = hash2(vec2f(px * 1.13 + 7.0, pz * 1.07 - 7.0)) * TAU;
  _ = emit(composeMat(qYawPitchRoll(yaw, 0.0, 0.0), s, s, s, px, y - 0.35, pz), vec4f(1.0));
}
`;

/** Per-kernel dispatch grid edge (matches each kernel's RES constant). */
export const KERNEL_RES: Record<string, number> = {
  grass: 28, rocks: 24, drift: 20, trees: 16, palms: 14,
};

/** Owns one layer kernel's ComputeShader + UBO and drains ONE patch dispatch per frame. */
export class ScatterCompute {
  private readonly cs: ComputeShader;
  private readonly params: UniformBuffer;
  private readonly res: number;
  private readonly queue: Array<{
    patch: GpuScatterPatch; cx: number; cz: number; variant: number;
    patchSize: number; densityMul: number; pads: PadBox[]; shadowMode: number;
  }> = [];
  private observer: Observer<Scene> | null = null;

  constructor(engine: WebGPUEngine, private readonly scene: Scene, kind: string, wgsl: string,
              private readonly getHeightField: () => HeightFieldGPU | null) {
    this.res = KERNEL_RES[kind] ?? 28;
    this.params = new UniformBuffer(engine);
    this.params.addUniform('patchCenter', 2);
    this.params.addUniform('patchSize', 1);
    this.params.addUniform('densityMul', 1);
    this.params.addUniform('variant', 1);
    this.params.addUniform('capacity', 1);
    this.params.addUniform('texSize', 2);
    this.params.addUniform('wbounds', 4);
    this.params.addUniform('pad0a', 4);
    this.params.addUniform('pad0b', 4);
    this.params.addUniform('pad1a', 4);
    this.params.addUniform('pad1b', 4);
    this.params.addUniform('extra', 4);

    this.cs = ComputeHelper.createShader(engine, `scatter_${kind}`, wgsl, 'main', {
      mats:      { group: 0, binding: 0 },
      cols:      { group: 0, binding: 1 },
      counter:   { group: 0, binding: 2 },
      heightTex: { group: 0, binding: 3 },
      params:    { group: 0, binding: 4 },
    });
    this.cs.setUniformBuffer('params', this.params);

    this.observer = scene.onBeforeRenderObservable.add(() => this.drainOne());
  }

  /** Queue a patch fill. The patch renders 0 instances until its dispatch + count readback land. */
  enqueue(patch: GpuScatterPatch, cx: number, cz: number, variant: number,
          patchSize: number, densityMul: number, pads: PadBox[], shadowMode = 0): void {
    this.queue.push({ patch, cx, cz, variant, patchSize, densityMul, pads, shadowMode });
  }

  private drainOne(): void {
    if (!this.queue.length) { return; }
    const hf = this.getHeightField();
    if (!hf) { return; }   // terrain height texture not built yet — retry next frame

    const { patch, cx, cz, variant, patchSize, densityMul, pads, shadowMode } = this.queue[0];

    this.cs.setStorageBuffer('mats', patch.mats);
    this.cs.setStorageBuffer('cols', patch.cols);
    this.cs.setStorageBuffer('counter', patch.counter);
    this.cs.setTexture('heightTex', hf.tex, false);

    this.params.updateFloat2('patchCenter', cx, cz);
    this.params.updateFloat('patchSize', patchSize);
    this.params.updateFloat('densityMul', densityMul);
    this.params.updateFloat('variant', variant);
    this.params.updateFloat('capacity', patch.capacity);
    this.params.updateFloat2('texSize', hf.texSize.x, hf.texSize.y);
    this.params.updateVector4('wbounds', hf.wbounds);
    const p0 = pads[0], p1 = pads[1];
    this.params.updateFloat4('pad0a', p0?.cx ?? 0, p0?.cz ?? 0, p0?.hx ?? 0, p0?.hz ?? 0);
    this.params.updateFloat4('pad0b', p0?.sin ?? 0, p0?.cos ?? 1, p0 ? 1 : 0, 0);
    this.params.updateFloat4('pad1a', p1?.cx ?? 0, p1?.cz ?? 0, p1?.hx ?? 0, p1?.hz ?? 0);
    this.params.updateFloat4('pad1b', p1?.sin ?? 0, p1?.cos ?? 1, p1 ? 1 : 0, 0);
    this.params.updateFloat4('extra', shadowMode, 0, 0, 0);
    this.params.update();

    patch.counter.update(new Uint32Array([0]));   // queue-ordered: lands before the dispatch below

    if (!ComputeHelper.dispatch(this.cs, this.res, this.res, 1)) { return; }   // compiling — retry
    this.queue.shift();

    // Async count readback (4 bytes, per-patch counter — no race with later dispatches).
    patch.counter.read().then((buf) => {
      patch.setCount(new Uint32Array(buf.buffer, buf.byteOffset, 1)[0]);
    }).catch(() => { /* engine torn down mid-read — patch is being disposed anyway */ });
  }

  /** Drop queued jobs for a disposed patch (patch culling can outrun the one-per-frame drain). */
  cancel(patch: GpuScatterPatch): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].patch === patch) { this.queue.splice(i, 1); }
    }
  }

  dispose(): void {
    if (this.observer) { this.scene.onBeforeRenderObservable.remove(this.observer); this.observer = null; }
    this.queue.length = 0;
    this.params.dispose();
  }
}

/** The four asset SHADOW kernels (rocks/drift/trees/palms in shadowMode) merged into one dispatcher.
 *  Per patch it runs all four kernels into the SAME buffers sharing ONE atomic append counter — reset
 *  once, read back once — so every asset's near-ring shadow blobs pack contiguously into a SINGLE
 *  thin-instance mesh (1 draw) instead of four. (WebGPU auto-synchronises between compute passes, so the
 *  later kernels' atomicAdd continues from the running total written by the earlier ones.) The kernels are
 *  unchanged: they already emit flat discs when params.extra.x (shadowMode) = 1. */
export class ShadowCompute {
  private readonly kernels: Array<{ cs: ComputeShader; res: number }> = [];
  private readonly params: UniformBuffer;
  private readonly queue: Array<{
    patch: GpuScatterPatch; cx: number; cz: number; patchSize: number; densityMul: number; pads: PadBox[];
  }> = [];
  private observer: Observer<Scene> | null = null;

  constructor(engine: WebGPUEngine, private readonly scene: Scene,
              private readonly getHeightField: () => HeightFieldGPU | null) {
    this.params = new UniformBuffer(engine);
    this.params.addUniform('patchCenter', 2);
    this.params.addUniform('patchSize', 1);
    this.params.addUniform('densityMul', 1);
    this.params.addUniform('variant', 1);
    this.params.addUniform('capacity', 1);
    this.params.addUniform('texSize', 2);
    this.params.addUniform('wbounds', 4);
    this.params.addUniform('pad0a', 4);
    this.params.addUniform('pad0b', 4);
    this.params.addUniform('pad1a', 4);
    this.params.addUniform('pad1b', 4);
    this.params.addUniform('extra', 4);

    const SHADOW_KERNELS: Array<[string, string]> = [
      ['rocks', ROCKS_WGSL], ['drift', DRIFT_WGSL], ['trees', TREES_WGSL], ['palms', PALMS_WGSL],
    ];
    for (const [kind, wgsl] of SHADOW_KERNELS) {
      const cs = ComputeHelper.createShader(engine, `scatter_shadow_${kind}`, wgsl, 'main', {
        mats:      { group: 0, binding: 0 },
        cols:      { group: 0, binding: 1 },
        counter:   { group: 0, binding: 2 },
        heightTex: { group: 0, binding: 3 },
        params:    { group: 0, binding: 4 },
      });
      cs.setUniformBuffer('params', this.params);
      this.kernels.push({ cs, res: KERNEL_RES[kind] ?? 24 });
    }

    this.observer = scene.onBeforeRenderObservable.add(() => this.drainOne());
  }

  enqueue(patch: GpuScatterPatch, cx: number, cz: number,
          patchSize: number, densityMul: number, pads: PadBox[]): void {
    this.queue.push({ patch, cx, cz, patchSize, densityMul, pads });
  }

  private drainOne(): void {
    if (!this.queue.length) { return; }
    const hf = this.getHeightField();
    if (!hf) { return; }   // terrain height texture not built yet — retry next frame

    const { patch, cx, cz, patchSize, densityMul, pads } = this.queue[0];

    // One shared param block for all four kernels (same patch; variant -1 keeps every candidate; shadowMode 1).
    this.params.updateFloat2('patchCenter', cx, cz);
    this.params.updateFloat('patchSize', patchSize);
    this.params.updateFloat('densityMul', densityMul);
    this.params.updateFloat('variant', -1);
    this.params.updateFloat('capacity', patch.capacity);
    this.params.updateFloat2('texSize', hf.texSize.x, hf.texSize.y);
    this.params.updateVector4('wbounds', hf.wbounds);
    const p0 = pads[0], p1 = pads[1];
    this.params.updateFloat4('pad0a', p0?.cx ?? 0, p0?.cz ?? 0, p0?.hx ?? 0, p0?.hz ?? 0);
    this.params.updateFloat4('pad0b', p0?.sin ?? 0, p0?.cos ?? 1, p0 ? 1 : 0, 0);
    this.params.updateFloat4('pad1a', p1?.cx ?? 0, p1?.cz ?? 0, p1?.hx ?? 0, p1?.hz ?? 0);
    this.params.updateFloat4('pad1b', p1?.sin ?? 0, p1?.cos ?? 1, p1 ? 1 : 0, 0);
    this.params.updateFloat4('extra', 1, 0, 0, 0);   // shadowMode = 1 → emit flat discs
    this.params.update();

    // Point every kernel at the SAME patch buffers + the shared append counter.
    for (const { cs } of this.kernels) {
      cs.setStorageBuffer('mats', patch.mats);
      cs.setStorageBuffer('cols', patch.cols);
      cs.setStorageBuffer('counter', patch.counter);
      cs.setTexture('heightTex', hf.tex, false);
    }

    // Reset the shared counter ONCE (queue-ordered → lands before the dispatches), then run all four; each
    // kernel's atomicAdd continues from the prior total, so the discs compact into one contiguous buffer.
    patch.counter.update(new Uint32Array([0]));
    for (const { cs, res } of this.kernels) {
      if (!ComputeHelper.dispatch(cs, res, res, 1)) { return; }   // a kernel still compiling — retry the whole patch next frame
    }
    this.queue.shift();

    patch.counter.read().then((buf) => {
      patch.setCount(new Uint32Array(buf.buffer, buf.byteOffset, 1)[0]);
    }).catch(() => { /* engine torn down mid-read — patch is being disposed anyway */ });
  }

  /** Drop queued jobs for a disposed patch (patch culling can outrun the one-per-frame drain). */
  cancel(patch: GpuScatterPatch): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].patch === patch) { this.queue.splice(i, 1); }
    }
  }

  dispose(): void {
    if (this.observer) { this.scene.onBeforeRenderObservable.remove(this.observer); this.observer = null; }
    this.queue.length = 0;
    this.params.dispose();
  }
}
