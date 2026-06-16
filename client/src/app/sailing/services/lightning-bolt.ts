/**
 * LightningBolt — a pool of distant, camera-facing billboards that render a procedural lightning bolt in
 * the sky during storms. The existing storm system only FLASHED an ambient light (kept); this adds the
 * VISIBLE strike to go with it. A bolt is spawned by CloudService.strikeLightning at a random azimuth +
 * distance and flickers in perfect sync with the same flash envelope that drives the light (so the bolt
 * and the scene-flash are the same event). Per-client — no server signaling (strike timing is already
 * per-client, per the storm RNG).
 *
 * Shader adapted from "lightning" by (ShaderToy dsXfDn): an FBM-displaced vertical bright streak whose
 * per-frame brightness strobes via a time hash. ALL procedural (no textures) → transpiles to valid WGSL on
 * WebGPU and runs on WebGL. Rendered ADDITIVE (ALPHA_ONEONE) so the black background contributes nothing —
 * same render-state recipe as [[muzzle_explosion_effect]] (alpha<1 to enter the transparent pass, no depth
 * write but DO depth-test so land in front occludes a far strike, excluded from the SSAO/DoF prePass).
 */
import { Constants, Material, Mesh, MeshBuilder, Scene, ShaderMaterial } from '@babylonjs/core';

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
uniform float uTime;        // animation clock (advances while the bolt lives) → strobe + FBM scroll
uniform float uIntensity;   // 0..1 flash envelope (same curve as the scene light flash)
uniform float uSeed;        // per-strike phase so every bolt forks differently
uniform float uAspect;      // quad width/height — keeps the FBM jitter isotropic

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
mat2 rot2(float a) { float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }

float vnoise(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float a = hash12(ip);
  float b = hash12(ip + vec2(1.0, 0.0));
  float c = hash12(ip + vec2(0.0, 1.0));
  float d = hash12(ip + vec2(1.0, 1.0));
  vec2 t = smoothstep(0.0, 1.0, fp);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 8; i++) {
    v += amp * vnoise(p);
    p = rot2(0.45) * p * 2.0;
    amp *= 0.5;
  }
  return v;
}

void main(void) {
  // Cheap out the moment the flash has faded — the bolt covers a big patch of sky, so don't run 8 octaves
  // of noise per pixel when it contributes nothing. (uIntensity is a uniform → WGSL-legal early return.)
  if (uIntensity <= 0.002) { gl_FragColor = vec4(0.0); return; }

  vec2 uv = 2.0 * vUV - 1.0;
  uv.x *= uAspect;
  // FBM-displace the domain → the streak wanders + forks like a real bolt (the heart of the original).
  uv += 2.0 * fbm(uv + 0.8 * uTime + uSeed) - 1.0;

  float dist = abs(uv.x);
  float flick = mix(0.012, 0.07, hash11(uTime + uSeed));   // per-frame brightness strobe
  float core = min(flick / max(dist, 0.004), 40.0);        // bright hot centre, glowing falloff

  vec3 col = vec3(0.45, 0.6, 1.0) * core;                  // blue-white, blows to white at the core
  // Vertical shaping: brightest up at the cloud base, fading into the horizon at the bottom (so the strike
  // "lands" near the sea line rather than punching a hard bar into the water), plus a soft top/edge feather.
  float baseFade = smoothstep(0.04, 0.38, vUV.y);
  float topEdge  = smoothstep(1.0, 0.9, vUV.y);
  col *= mix(0.5, 1.0, vUV.y) * baseFade * topEdge;
  col *= uIntensity;

  gl_FragColor = vec4(col, 1.0);
}
`;

interface Bolt {
  mesh: Mesh; mat: ShaderMaterial; active: boolean;
  life: number; lifetime: number; clock: number;
}

export class LightningBolt {
  private bolts: Bolt[] = [];
  private readonly BASE_W = 320;     // billboard size in metres (a tall, distant bolt)
  private readonly BASE_H = 560;
  private readonly ANIM_RATE = 9.0;  // shader "seconds" per real second → lively strobe in the brief life

  constructor(scene: Scene, excludeFromPrePass: (m: Material) => void, pool = 3) {
    for (let i = 0; i < pool; i++) {
      const mat = new ShaderMaterial('lightningBoltMat' + i, scene,
        { vertexSource: VERT, fragmentSource: FRAG },
        { attributes: ['position', 'uv'], uniforms: ['worldViewProjection', 'uTime', 'uIntensity', 'uSeed', 'uAspect'] });
      mat.alphaMode = Constants.ALPHA_ONEONE;     // additive — black background adds nothing
      mat.alpha = 0.99;                           // alpha<1 → enters the transparent (no depth-write) pass
      mat.needAlphaBlending = () => true;
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;               // depth-TEST (land in front occludes a far strike) but don't write
      mat.setFloat('uIntensity', 0); mat.setFloat('uTime', 0); mat.setFloat('uSeed', 0);
      mat.setFloat('uAspect', this.BASE_W / this.BASE_H);
      excludeFromPrePass(mat);

      const mesh = MeshBuilder.CreatePlane('lightningBolt' + i, { width: this.BASE_W, height: this.BASE_H }, scene);
      mesh.material = mat;
      mesh.billboardMode = Mesh.BILLBOARDMODE_Y;   // yaw to face the camera but stay world-vertical (a bolt is upright)
      mesh.renderingGroupId = 3;                   // above the ocean LODs, depth-tested vs the world (see scene group setup)
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;        // large + far — skip frustum culling churn
      mesh.metadata = { excludeFromRefraction: true };   // keep it out of the ocean RTTs + smoke depth pass
      mesh.setEnabled(false);
      this.bolts.push({ mesh, mat, active: false, life: 0, lifetime: 0.52, clock: 0 });
    }
  }

  /**
   * Fire a bolt near the camera at a compass azimuth (radians, +Z = north) and a normalized distance
   * (0 close → 1 far, the same value the thunder delay uses). Placed relative to the camera at strike time
   * so it always reads as "in the distance" wherever the player is; the strike is brief, so the camera
   * barely moves and a fixed world placement is fine.
   */
  strike(camX: number, camY: number, camZ: number, azimuthRad: number, dist01: number, storm: number): void {
    let b = this.bolts.find(s => !s.active);
    if (!b) { b = this.bolts.reduce((a, c) => (c.life > a.life ? c : a), this.bolts[0]); }

    const distance = 700 + dist01 * 900;                  // 700..1600 m out
    const scale = (1.0 - 0.4 * dist01) * (0.8 + 0.3 * storm);   // far / weaker storm → smaller
    const dirX = Math.sin(azimuthRad), dirZ = Math.cos(azimuthRad);
    b.mesh.position.set(camX + dirX * distance, camY + 120 * Math.max(0.6, scale), camZ + dirZ * distance);
    b.mesh.scaling.setAll(scale);

    b.clock = (camX * 0.013 + camZ * 0.029 + azimuthRad) % 50;   // per-strike phase
    b.mat.setFloat('uSeed', b.clock);
    b.life = 0; b.active = true;
    b.mat.setFloat('uIntensity', 0); b.mat.setFloat('uTime', b.clock);
    b.mesh.setEnabled(true);
  }

  /** Advance live bolts and set their brightness to the supplied flash envelope (0..1, from CloudService —
   *  shared with the scene-light flash so the two are the same event). Call every frame. */
  update(dt: number, envelope: number): void {
    for (const b of this.bolts) {
      if (!b.active) { continue; }
      b.life += dt / b.lifetime;
      b.clock += dt * this.ANIM_RATE;
      // Retire when the envelope has died or the slot's life is spent.
      if (b.life >= 1 || envelope <= 0.002) { b.active = false; b.mesh.setEnabled(false); continue; }
      b.mat.setFloat('uTime', b.clock);
      b.mat.setFloat('uIntensity', envelope);
    }
  }

  dispose(): void {
    for (const b of this.bolts) { b.mesh.dispose(); b.mat.dispose(); }
    this.bolts = [];
  }
}
