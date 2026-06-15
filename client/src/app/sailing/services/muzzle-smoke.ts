/**
 * MuzzleSmoke — shader-based cannon SMOKE: a pool of camera-facing billboard puffs, each rendering an
 * animated simplex-noise cloud, that spawn at the muzzle and RISE + DRIFT downwind + GROW + FADE. A short
 * per-shot "belch" emitter spits several puffs over ~0.4 s so they stack into a moving plume — replacing the
 * dense fountain ParticleSystem (the lingering pall particles are kept). Opt out: localStorage.ignis_smoke='particles'.
 *
 * Cloud field adapted from a public-domain Ashima simplex-noise FBM (e.g. ShaderToy "clouds"). ALL procedural
 * (no textures) so it transpiles to valid WGSL on WebGPU and runs on WebGL — and we reuse the render-state
 * recipe proven on [[muzzle_explosion_effect]]: alpha<1 to force the transparent pass, no depth write, and
 * exclusion from the SSAO/DoF prePass + ocean RTTs. Smoke is NORMAL alpha-blended (occludes), not additive.
 */
import { Constants, Material, Mesh, MeshBuilder, RawTexture, RenderTargetTexture, Scene, ShaderMaterial, Texture } from '@babylonjs/core';

/** Soft-particle depth wiring supplied by the host (SceneService). */
export interface MuzzleSmokeDeps {
  excludeFromPrePass: (m: Material) => void;
  setDepthActive: (on: boolean) => void;          // turn the (gated) smoke depth pass on/off
  getDepthTexture: () => RenderTargetTexture | null;  // the camera-space-Z depth map (null until first active)
  vFlip: number;                                  // 1 on WebGPU (render-target V orientation), else 0
}

const VERT = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
uniform mat4 worldView;
varying vec2 vUV;
varying vec4 vClip;
varying float vViewZ;
void main(void) {
  vUV = uv;
  vec4 cp = worldViewProjection * vec4(position, 1.0);
  vClip = cp;
  vViewZ = -(worldView * vec4(position, 1.0)).z;   // camera-space distance in front (positive)
  gl_Position = cp;
}
`;

const FRAG = `
precision highp float;
varying vec2 vUV;
varying vec4 vClip;
varying float vViewZ;
uniform float uLife;
uniform float uTime;
uniform float uSeed;
uniform sampler2D sceneDepth;   // camera-space Z of solid geometry (ship + terrain)
uniform float uSoftOn;          // 1 when the depth pass is live (else skip the fade)
uniform float uVFlip;           // 1 → flip the sampled V (WebGPU render-target orientation)
uniform float uSoftRange;       // metres of soft transition at intersections

// ── Ashima 3D simplex noise (procedural; no texture) ──
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// 3-octave scrolling FBM (trimmed from the demo's 6 for our GPU budget). 0..1.
float fbmCloud(vec2 uv) {
  float t = uTime;
  float n = snoise(vec3(uv * 3.0  + uSeed,         t * 0.4)) * 0.55
          + snoise(vec3(uv * 6.0  + uSeed * 1.7,   t * 0.5)) * 0.28
          + snoise(vec3(uv * 12.0 - uSeed * 0.9,   t * 0.3)) * 0.14;
  return 0.5 * (n + 1.0);
}

void main(void) {
  float life = clamp(uLife, 0.0, 1.0);
  vec2 q = vUV - 0.5;
  float rr = length(q) * 2.0;
  float disc = smoothstep(1.0, 0.1, rr);   // round soft edge, no square

  // Slowly ROTATE the sample domain so the smoke visibly churns as it lives.
  float a = uTime * 0.2 + uSeed;
  vec2 ruv = vec2(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a)) + 0.5;

  float n = fbmCloud(ruv);                  // 0..1 animated cloud field
  // Contrast → real wisps + holes (not a uniform blob).
  float dens = smoothstep(0.28, 0.78, n) * disc;
  // Brightness FOLLOWS the noise (n^2) → visible billows: bright tops, dark folds (the missing structure).
  vec3 col = mix(vec3(0.13, 0.13, 0.14), vec3(0.5, 0.49, 0.46), n * n);   // dirty gunpowder grey
  // Fade in fast, HOLD a good while, then dissipate.
  float env = smoothstep(0.0, 0.10, life) * (1.0 - smoothstep(0.6, 1.0, life));
  float alpha = dens * env * 0.9;

  // SOFT-PARTICLE fade: dissolve where the puff meets solid geometry so it never hard-cuts against the ship
  // (the "pasted-on" billboard tell). uSoftOn is a UNIFORM, so the texture read sits in uniform control flow
  // (WGSL-legal); textureLod (explicit LOD) is belt-and-suspenders. Where there's no geometry the depth map
  // clears to ~far, so soft → 1 (full).
  float soft = 1.0;
  if (uSoftOn > 0.5) {
    vec2 suv = (vClip.xy / vClip.w) * 0.5 + 0.5;
    suv.y = mix(suv.y, 1.0 - suv.y, uVFlip);
    float sceneZ = abs(textureLod(sceneDepth, suv, 0.0).r);   // abs → robust to the depth-map sign convention
    soft = clamp((sceneZ - vViewZ) / uSoftRange, 0.0, 1.0);
  }
  alpha *= soft;

  gl_FragColor = vec4(col, alpha);
}
`;

interface Puff {
  mesh: Mesh; mat: ShaderMaterial; active: boolean;
  life: number; lifetime: number; seed: number;
  px: number; py: number; pz: number;   // world position
  vx: number; vy: number; vz: number;   // velocity (m/s)
  size0: number; size1: number;         // start/end billboard diameter
}
interface Emitter { x: number; y: number; z: number; dx: number; dz: number; tLeft: number; spawnIn: number; }

export class MuzzleSmoke {
  private puffs: Puff[] = [];
  private emitters: Emitter[] = [];
  private dummyDepth: RawTexture | null = null;
  private depthBound = false;
  private readonly BELCH_DUR = 0.6;      // s the muzzle keeps belching puffs
  private readonly SPAWN_EVERY = 0.06;   // s between puffs in a belch (~10 puffs/shot)

  constructor(scene: Scene, private deps: MuzzleSmokeDeps, pool = 40) {
    // 1x1 "far" depth so the sceneDepth sampler is ALWAYS bound (an unbound sampler errors on WebGPU); the
    // real depth map replaces it once the gated pass goes live.
    this.dummyDepth = RawTexture.CreateRTexture(new Float32Array([1.0e8]), 1, 1, scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
    for (let i = 0; i < pool; i++) {
      const mat = new ShaderMaterial('muzzleSmokeMat' + i, scene,
        { vertexSource: VERT, fragmentSource: FRAG },
        { attributes: ['position', 'uv'],
          uniforms: ['worldViewProjection', 'worldView', 'uLife', 'uTime', 'uSeed', 'uSoftOn', 'uVFlip', 'uSoftRange'],
          samplers: ['sceneDepth'] });
      mat.alpha = 0.99;                       // alpha<1 → ShaderMaterial enters the transparent pass (proven recipe)
      mat.needAlphaBlending = () => true;
      mat.alphaMode = Constants.ALPHA_COMBINE;   // NORMAL alpha (smoke occludes), not additive
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
      mat.setTexture('sceneDepth', this.dummyDepth);
      mat.setFloat('uSoftOn', 0); mat.setFloat('uVFlip', deps.vFlip); mat.setFloat('uSoftRange', 3.0);
      deps.excludeFromPrePass(mat);

      const mesh = MeshBuilder.CreatePlane('muzzleSmoke' + i, { size: 1 }, scene);
      mesh.material = mat;
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.renderingGroupId = 3;
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.metadata = { excludeFromRefraction: true };
      mesh.setEnabled(false);
      this.puffs.push({ mesh, mat, active: false, life: 0, lifetime: 2.4, seed: 0,
        px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, size0: 3, size1: 9 });
    }
  }

  /** Start a per-shot belch: spits several puffs over BELCH_DUR along the beam (dirX,dirZ unit). */
  belch(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    this.emitters.push({ x, y, z, dx: dirX, dz: dirZ, tLeft: this.BELCH_DUR, spawnIn: 0 });
  }

  /** Lingering pall: a few BIG, slow, very long-lived puffs that hang and drift (replaces the linger PS). */
  pall(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    for (let k = 0; k < 3; k++) { this.spawnPallPuff(x, y, z, dirX, dirZ, k); }
  }

  private spawnPallPuff(x: number, y: number, z: number, dx: number, dz: number, k: number): void {
    let p = this.puffs.find(s => !s.active);
    if (!p) { p = this.puffs.reduce((a, b) => (b.life > a.life ? b : a), this.puffs[0]); }
    const r = (n: number) => ((Math.sin((k * 31.7 + x * 0.13 + n) * 12.9898) * 43758.5453) % 1 + 1) % 1 - 0.5;
    p.px = x + dx * 0.5 + r(1) * 1.5; p.py = y + 0.4 + r(2) * 0.5; p.pz = z + dz * 0.5 + r(3) * 1.5;
    p.vx = dx * 1.5 + r(4) * 1.0; p.vy = 0.5 + r(5) * 0.3; p.vz = dz * 1.5 + r(6) * 1.0;   // slow drift + gentle rise
    p.seed = (x * 0.37 + z * 0.91 + k * 7.0) % 50;
    p.size0 = 8.0 + r(7) * 2.0; p.size1 = 22.0 + r(8) * 6.0;   // big billowing pall
    p.lifetime = 9.0 + (r(9) + 0.5) * 5.0;                     // 9..14 s
    p.life = 0; p.active = true;
    p.mesh.position.set(p.px, p.py, p.pz);
    p.mesh.scaling.setAll(p.size0);
    p.mat.setFloat('uLife', 0); p.mat.setFloat('uTime', p.seed); p.mat.setFloat('uSeed', p.seed);
    p.mesh.setEnabled(true);
  }

  private spawnPuff(e: Emitter): void {
    let p = this.puffs.find(s => !s.active);
    if (!p) { p = this.puffs.reduce((a, b) => (b.life > a.life ? b : a), this.puffs[0]); }
    // Deterministic-ish jitter from time-left so puffs in a belch differ without Math.random in hot paths.
    const r = (n: number) => ((Math.sin((e.tLeft * 97.13 + n) * 12.9898) * 43758.5453) % 1 + 1) % 1 - 0.5;
    const speed = 13.0 * (e.tLeft / this.BELCH_DUR) + 4.0;  // strong outward JET out the barrel at the start
    p.px = e.x + e.dx * 0.4; p.py = e.y + 0.1; p.pz = e.z + e.dz * 0.4;
    p.vx = e.dx * speed + r(1) * 2.0;
    p.vy = 0.9 + r(2) * 0.7;                                // mostly OUT first, only a little rise
    p.vz = e.dz * speed + r(3) * 2.0;
    p.seed = (e.tLeft * 53.7) % 50;
    p.size0 = 3.2 + r(4) * 1.0;
    p.size1 = 12.0 + r(5) * 4.0;                            // billows much wider as it rises
    p.lifetime = 3.6 + (r(6) + 0.5) * 2.2;                  // 3.6..5.8 s (lingers longer)
    p.life = 0; p.active = true;
    p.mesh.position.set(p.px, p.py, p.pz);
    p.mesh.scaling.setAll(p.size0);
    p.mat.setFloat('uLife', 0); p.mat.setFloat('uTime', p.seed); p.mat.setFloat('uSeed', p.seed);
    p.mesh.setEnabled(true);
  }

  /** Tick the belch emitters + advance every live puff. windX/windZ drift the smoke downwind (m/s). */
  update(dt: number, windX = 0, windZ = 0): void {
    // Emitters spit puffs.
    for (const e of this.emitters) {
      e.tLeft -= dt; e.spawnIn -= dt;
      while (e.spawnIn <= 0 && e.tLeft > 0) { this.spawnPuff(e); e.spawnIn += this.SPAWN_EVERY; }
    }
    this.emitters = this.emitters.filter(e => e.tLeft > 0);

    // Soft-particle depth: only run the (ship-inclusive) depth pass while smoke exists; bind the real depth
    // map once it's built, then sample it (uSoftOn=1). No smoke → pass off, no cost.
    const anyActive = this.emitters.length > 0 || this.puffs.some(p => p.active);
    this.deps.setDepthActive(anyActive);
    const dtex = this.deps.getDepthTexture();
    if (dtex && !this.depthBound) {
      this.depthBound = true;
      for (const q of this.puffs) { q.mat.setTexture('sceneDepth', dtex); }
    }
    const softOn = anyActive && this.depthBound ? 1 : 0;

    // Puffs: drag the belch velocity, keep rising, drift downwind, grow, fade.
    const dragH = Math.max(0, 1 - 0.85 * dt);   // gentler drag → the belch carries forward before drift takes over
    for (const p of this.puffs) {
      if (!p.active) { continue; }
      p.life += dt / p.lifetime;
      if (p.life >= 1) { p.active = false; p.mesh.setEnabled(false); continue; }
      p.vx *= dragH; p.vz *= dragH;
      p.vy = p.vy * Math.max(0, 1 - 0.4 * dt) + 0.5 * dt;   // buoyancy, gently sustained
      p.px += (p.vx + windX) * dt; p.py += p.vy * dt; p.pz += (p.vz + windZ) * dt;
      const grow = 1 - (1 - p.life) * (1 - p.life);          // ease-out
      p.mesh.position.set(p.px, p.py, p.pz);
      p.mesh.scaling.setAll(p.size0 + (p.size1 - p.size0) * grow);
      p.mat.setFloat('uLife', p.life);
      p.mat.setFloat('uTime', p.seed + p.life * p.lifetime); // slow internal roil
      p.mat.setFloat('uSoftOn', softOn);
    }
  }

  dispose(): void {
    this.dummyDepth?.dispose();
    this.dummyDepth = null;
    this.deps.setDepthActive(false);
    for (const p of this.puffs) { p.mesh.dispose(); p.mat.dispose(); }
    this.puffs = []; this.emitters = [];
  }
}
