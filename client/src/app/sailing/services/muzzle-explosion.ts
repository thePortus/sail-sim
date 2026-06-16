/**
 * MuzzleExplosions — a pool of camera-facing billboards that render a raymarched VOLUMETRIC fireball at a
 * cannon muzzle, replacing the old additive orange flame particles (smoke/linger/flash-light are untouched).
 *
 * Adapted from "Volumetric explosion" by Duke (ShaderToy lsySzd, CC BY-NC-SA), itself after otaviogood /
 * Shane / iq. KEY ADAPTATIONS for this engine:
 *  - ALL noise is PROCEDURAL (hash-based) — the original sampled a noise texture (iChannel0) and a dither
 *    texture INSIDE the raymarch loop, which is illegal WGSL (`textureSample` in non-uniform control flow)
 *    and would kill the WebGPU pipeline. No textures here → transpiles to valid WGSL and runs on WebGL.
 *  - Rendered on a billboard quad (vUV = the virtual screen), additive (ALPHA_ONEONE) so the black
 *    background contributes nothing — like the flame it replaces.
 *  - Per-instance `uLife` (0..1) drives a quick-decay envelope; the pool lets a broadside / remotes overlap.
 *  - Raymarch steps + spiral-noise iterations trimmed (the game is GPU-bound); the blast is brief + small.
 */
import { Constants, Material, Mesh, MeshBuilder, Scene, ShaderMaterial, Vector3 } from '@babylonjs/core';

const VERT = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main(void) {
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAG = `
precision highp float;
varying vec2 vUV;
uniform float uLife;   // 0 at spawn → 1 at death
uniform float uTime;   // animation clock (global + per-instance seed)

#define R(p, a) p = cos(a) * p + sin(a) * vec2(p.y, -p.x)

// ── Procedural value noise (replaces the texture-based iChannel0 noise) ──
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec3 x) {
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n = mix(mix(mix(hash13(p + vec3(0.0, 0.0, 0.0)), hash13(p + vec3(1.0, 0.0, 0.0)), f.x),
                    mix(hash13(p + vec3(0.0, 1.0, 0.0)), hash13(p + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                mix(mix(hash13(p + vec3(0.0, 0.0, 1.0)), hash13(p + vec3(1.0, 0.0, 1.0)), f.x),
                    mix(hash13(p + vec3(0.0, 1.0, 1.0)), hash13(p + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  return 1.0 - 0.82 * n;   // match the original noise()'s range/inversion
}
float fbm(vec3 p) {
  return noise(p * 0.06125) * 0.5 + noise(p * 0.125) * 0.25 + noise(p * 0.25) * 0.125 + noise(p * 0.4) * 0.2;
}
float Sphere(vec3 p, float r) { return length(p) - r; }

// otaviogood's spiral noise (no hash/texture — successive rotated sin waves)
float SpiralNoiseC(vec3 p) {
  const float nudge = 4.0;
  const float normalizer = 0.2425356250;   // 1/sqrt(1 + nudge*nudge)
  float n = -mod(uTime * 0.2, -2.0);
  float iter = 2.0;
  for (int i = 0; i < 6; i++) {            // was 8 — trimmed for perf
    n += -abs(sin(p.y * iter) + cos(p.x * iter)) / iter;
    p.xy += vec2(p.y, -p.x) * nudge; p.xy *= normalizer;
    p.xz += vec2(p.z, -p.x) * nudge; p.xz *= normalizer;
    iter *= 1.733733;
  }
  return n;
}
float VolumetricExplosion(vec3 p) {
  // NB: 'final' is a RESERVED WORD in WGSL — name it 'dens' so the GLSL→WGSL transpile is valid.
  float dens = Sphere(p, 4.0);
  dens += fbm(p * 50.0);
  dens += SpiralNoiseC(p.zxy * 0.4132 + 333.0) * 3.0;
  return dens;
}
float map(vec3 p) {
  R(p.xz, uTime * 0.15);   // a touch more spin so the swirl reads in the brief life
  return VolumetricExplosion(p / 0.5) * 0.5;
}

vec3 computeColor(float density, float radius) {
  vec3 result = mix(vec3(1.0, 0.9, 0.8), vec3(0.4, 0.15, 0.1), density);
  vec3 colCenter = 7.0 * vec3(0.8, 1.0, 1.0);
  vec3 colEdge = 1.5 * vec3(0.48, 0.53, 0.5);
  result *= mix(colCenter, colEdge, min((radius + 0.05) / 0.9, 1.15));
  return result;
}
void main(void) {
  // vUV is the billboard's virtual screen; centre it (square quad → no aspect term).
  vec2 p = vUV - 0.5;
  vec3 rd = normalize(vec3(p, 1.0));
  vec3 ro = vec3(0.0, 0.0, -7.5);   // a bit farther back → the fireball sits inside the quad with edge margin

  float ld = 0.0, td = 0.0, w = 0.0;
  float d = 1.0, t = 0.0;
  const float h = 0.1;
  vec4 sum = vec4(0.0);

  // Ray vs the bounding sphere (r^2 = 8), inlined — no out-params and no sqrt(neg) for clean WGSL.
  float b = dot(rd, ro);
  float cc = dot(ro, ro) - 8.0;
  float delta = b * b - cc;
  float dsq = sqrt(max(delta, 0.0));
  float minD = -b - dsq;
  float maxD = -b + dsq;
  if (delta >= 0.0 && maxD > 0.0) {
    t = minD * step(t, minD);
    for (int i = 0; i < 44; i++) {           // was 86 — trimmed for perf (brief, small on screen)
      vec3 pos = ro + t * rd;
      if (td > 0.9 || d < 0.12 * t || t > 10.0 || sum.a > 0.99 || t > maxD) break;
      float dd = map(pos);
      dd = max(dd, 0.03);
      vec3 ldst = vec3(0.0) - pos;
      float lDist = max(length(ldst), 0.001);
      vec3 lightColor = vec3(1.0, 0.5, 0.25);
      sum.rgb += (lightColor / exp(lDist * lDist * lDist * 0.08) / 30.0);   // bloom
      if (dd < h) {
        ld = h - dd;
        w = (1.0 - td) * ld;
        td += w + 1.0 / 200.0;
        vec4 col = vec4(computeColor(td, lDist), td);
        sum += sum.a * vec4(sum.rgb, 0.0) * 0.2 / lDist;   // emission
        col.a *= 0.2;
        col.rgb *= col.a;
        sum = sum + col * (1.0 - sum.a);
      }
      td += 1.0 / 70.0;
      t += max(dd * 0.08 * max(min(length(ldst), dd), 2.0), 0.01);
      // NB: do NOT write the outer d here. In the original it stays 1.0 so the break test (d lt 0.12*t)
      // is a FAR cutoff (t gt 8.3). Setting d = dd made it ~0.03 at the sphere entry, breaking after one
      // step (the near-black silhouette bug).
    }
    sum *= 1.0 / exp(ld * 0.2) * 0.8;
    sum = clamp(sum, 0.0, 1.0);
    sum.xyz = sum.xyz * sum.xyz * (3.0 - 2.0 * sum.xyz);
  }

  vec3 col = sum.xyz * 1.7;   // brightness boost so it reads against the scene
  // Radial envelope. (1) ALWAYS feather the outer edge so the hard bounding-sphere/billboard circle is never
  // visible. (2) As the blast dies, the visible front COLLAPSES INWARD (outer edges fade first, core last) for
  // a softer, more natural death than a uniform dim.
  float life  = clamp(uLife, 0.0, 1.0);
  float rr    = length(vUV - 0.5) * 2.0;     // 0 = centre, 1 = billboard mid-edge
  float front = 1.05 - life * 0.95;          // collapse front: life 0 → 1.05, life 1 → 0.10
  float radial = smoothstep(front, front - 0.5, rr);
  float fade  = mix(1.0, 0.55, life);        // gentle overall dim on top (subtle)
  gl_FragColor = vec4(col * radial * fade, 1.0);
}
`;

interface Slot { mesh: Mesh; mat: ShaderMaterial; life: number; lifetime: number; active: boolean; seed: number; size: number; }

export class MuzzleExplosions {
  private slots: Slot[] = [];
  private readonly LIFETIME = 0.9;    // seconds the fireball lives (longer — then the smoke carries on)
  // Animation time runs at ANIM_RATE "shader seconds" per real second of life, so the noise roils/rotates a
  // visible amount in the flash (the demo swirls over many seconds; we compress that into the brief life).
  private readonly ANIM_RATE = 6.3;   // slowed ~30% for a lazier swirl

  constructor(scene: Scene, excludeFromPrePass: (m: Material) => void, pool = 16, includeInGlow?: (m: Mesh) => void) {
    for (let i = 0; i < pool; i++) {
      const mat = new ShaderMaterial('muzzleExplosionMat' + i, scene,
        { vertexSource: VERT, fragmentSource: FRAG },
        { attributes: ['position', 'uv'], uniforms: ['worldViewProjection', 'uLife', 'uTime'] });
      mat.alphaMode = Constants.ALPHA_ONEONE;   // additive (ONE, ONE) — bright fire, black adds nothing
      // A raw ShaderMaterial renders OPAQUE unless it thinks it's transparent — then it occludes the smoke
      // behind it (the black/cutout square). The RELIABLE trigger is `alpha < 1`: ShaderMaterial.needAlpha-
      // Blending() checks it natively. alphaMode=ONEONE ignores the alpha value in the blend math, so 0.99
      // just flips it into the transparent (no depth-write) pass. (Override kept as belt-and-suspenders.)
      mat.alpha = 0.99;
      mat.needAlphaBlending = () => true;
      mat.backFaceCulling  = false;
      mat.disableDepthWrite = true;             // additive: test depth (so the hull occludes it) but don't write
      mat.setFloat('uLife', 0); mat.setFloat('uTime', 0);
      // Keep it OUT of the SSAO/DoF prePass — a billboard rendered there is treated as opaque geometry and
      // punches a defocused/darkened cutout (the "inverse profile" artifact). Same trick the vessel uses.
      excludeFromPrePass(mat);

      const mesh = MeshBuilder.CreatePlane('muzzleExplosion' + i, { size: 1 }, scene);
      mesh.material = mat;
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;             // always face the camera
      mesh.renderingGroupId = 3;                              // above the ocean LODs, with the flame it replaces
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      // Don't let it bleed into the ocean reflection/refraction RTTs (it's an above-water additive flash).
      mesh.metadata = { excludeFromRefraction: true };
      includeInGlow?.(mesh);   // bloom the fireball through the glow layer (day + night)
      mesh.setEnabled(false);
      this.slots.push({ mesh, mat, life: 0, lifetime: this.LIFETIME, active: false, seed: 0, size: 1 });
    }
  }

  /** Spawn a fireball at a world position. `size` = the billboard diameter in metres (~the blast width). */
  spawn(x: number, y: number, z: number, size = 6.5): void {
    let slot = this.slots.find(s => !s.active);
    if (!slot) {                                              // pool exhausted → recycle the oldest (highest life)
      slot = this.slots.reduce((a, b) => (b.life > a.life ? b : a), this.slots[0]);
    }
    slot.size = size;
    slot.seed = Math.abs((x * 0.37 + z * 0.91) % 50);         // per-shot phase so blasts don't look identical
    slot.life = 0;
    slot.active = true;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scaling.setAll(size * 0.8);                     // starts a touch smaller, expands as it animates
    slot.mat.setFloat('uLife', 0);
    slot.mat.setFloat('uTime', slot.seed);
    slot.mesh.setEnabled(true);
  }

  /** Advance every active fireball; disable those that have burnt out. Call once per frame. */
  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) { continue; }
      s.life += dt / s.lifetime;
      if (s.life >= 1) { s.active = false; s.mesh.setEnabled(false); continue; }
      const age = s.life * s.lifetime;                        // seconds since spawn
      s.mat.setFloat('uLife', s.life);
      s.mat.setFloat('uTime', s.seed + age * this.ANIM_RATE); // fast time → the noise roils/spins as it lives
      s.mesh.scaling.setAll(s.size * (0.8 + 0.35 * s.life));  // expanding blast
    }
  }

  dispose(): void {
    for (const s of this.slots) { s.mesh.dispose(); s.mat.dispose(); }
    this.slots = [];
  }
}
