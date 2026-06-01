import { Injectable, inject } from '@angular/core';
import {
  Scene,
  Vector3,
  Color4,
  DynamicTexture,
  ParticleSystem,
  GPUParticleSystem,
  SpriteManager,
  Sprite,
  Observer,
  PostProcess,
  ShaderStore,
  ShaderLanguage,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { SfxService } from './sfx.service';
import { VolumetricCloudsPlugin } from './volumetric-clouds-plugin';
import { Weather } from '../models';

type CloudSpriteEntry = {
  sprite: Sprite;
  baseY: number;
  baseSize: number;
  driftScale: number;
  phase: number;
  spin: number;
};

// ── Lens-rain post-process ───────────────────────────────────────────────────
// A screen-space effect that makes occasional raindrops appear to land on the
// camera lens: procedural drops (two grid layers) refract the underlying scene
// like little lenses, drift down, and fade. Strength is driven by uIntensity
// (current precipitation) so it only shows in rain and intensifies in storms.
// Provided in both GLSL (WebGL) and WGSL (WebGPU) to match the active engine.

const LENS_RAIN_GLSL = `
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform float uTime;
uniform float uIntensity;
uniform float uAspect;

float h21(vec2 p){
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

// One grid layer of drops → vec4(offset.xy, coverage, rim).
vec4 dropLayer(vec2 uv, float scl, float seed){
  vec2 gv = uv * scl;
  vec2 id = floor(gv);
  vec2 f  = fract(gv) - 0.5;
  float r1 = h21(id + seed);
  float r2 = h21(id + seed + 7.7);
  if (h21(id + seed + 3.1) < 0.5) return vec4(0.0);   // only ~half the cells host a drop
  float period = mix(3.5, 7.5, r2);
  float life = fract((uTime + r1 * 90.0) / period);
  vec2 c = (vec2(r1, r2) - 0.5) * 0.55;
  c.y -= life * 0.30;                                  // drift down the screen over its life
  float rad = mix(0.10, 0.34, smoothstep(0.0, 0.12, life)) * (0.65 + 0.35 * r2);
  float d = length(f - c);
  float m = smoothstep(rad, rad * 0.45, d);
  m *= 1.0 - smoothstep(0.72, 1.0, life);              // fade out at end of life
  vec2 offset = -(f - c) * m * (0.05 / scl);           // lens refraction toward centre
  float rim = (1.0 - smoothstep(rad * 0.45, rad, d)) * smoothstep(rad * 0.55, rad, d) * m;
  return vec4(offset, m, rim);
}

void main(){
  vec3 scene = texture2D(textureSampler, vUV).rgb;
  if (uIntensity < 0.02) { gl_FragColor = vec4(scene, 1.0); return; }
  vec2 uv = vec2(vUV.x * uAspect, vUV.y);              // aspect-correct so drops are round
  vec4 l1 = dropLayer(uv,  6.0,  0.0);
  vec4 l2 = dropLayer(uv, 10.0, 23.0);
  vec2 offset = l1.xy + l2.xy;
  float cover = max(l1.z, l2.z);
  float rim   = l1.w + l2.w;
  float amt = clamp(uIntensity * 1.4, 0.0, 1.0);
  vec2 ruv = clamp(vUV + offset * amt, 0.001, 0.999);
  vec3 refr = texture2D(textureSampler, ruv).rgb;
  vec3 col = mix(scene, refr, clamp(cover * amt, 0.0, 1.0));
  col += rim * amt * 0.08;                             // faint bright rim/highlight
  gl_FragColor = vec4(col, 1.0);
}
`;

const LENS_RAIN_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform uTime: f32;
uniform uIntensity: f32;
uniform uAspect: f32;

fn h21(pIn: vec2f) -> f32 {
  var p = fract(pIn * vec2f(123.34, 345.45));
  p += dot(p, p + vec2f(34.345));
  return fract(p.x * p.y);
}

fn dropLayer(uv: vec2f, scl: f32, seed: f32) -> vec4f {
  let gv = uv * scl;
  let id = floor(gv);
  let f  = fract(gv) - vec2f(0.5);
  let r1 = h21(id + vec2f(seed));
  let r2 = h21(id + vec2f(seed + 7.7));
  if (h21(id + vec2f(seed + 3.1)) < 0.5) { return vec4f(0.0); }
  let period = mix(3.5, 7.5, r2);
  let life = fract((uniforms.uTime + r1 * 90.0) / period);
  var c = (vec2f(r1, r2) - vec2f(0.5)) * 0.55;
  c.y -= life * 0.30;
  let rad = mix(0.10, 0.34, smoothstep(0.0, 0.12, life)) * (0.65 + 0.35 * r2);
  let d = length(f - c);
  var m = smoothstep(rad, rad * 0.45, d);
  m *= 1.0 - smoothstep(0.72, 1.0, life);
  let offset = -(f - c) * m * (0.05 / scl);
  let rim = (1.0 - smoothstep(rad * 0.45, rad, d)) * smoothstep(rad * 0.55, rad, d) * m;
  return vec4f(offset, m, rim);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let scene = textureSample(textureSampler, textureSamplerSampler, input.vUV).rgb;
  var col = scene;
  // Branch on a uniform → uniform control flow, so textureSample inside is valid.
  // No bare 'return;' (invalid in a value-returning WGSL entry point).
  if (uniforms.uIntensity >= 0.02) {
    let uv = vec2f(input.vUV.x * uniforms.uAspect, input.vUV.y);
    let l1 = dropLayer(uv,  6.0,  0.0);
    let l2 = dropLayer(uv, 10.0, 23.0);
    let offset = l1.xy + l2.xy;
    let cover = max(l1.z, l2.z);
    let rim   = l1.w + l2.w;
    let amt = clamp(uniforms.uIntensity * 1.4, 0.0, 1.0);
    let ruv = clamp(input.vUV + offset * amt, vec2f(0.001), vec2f(0.999));
    let refr = textureSample(textureSampler, textureSamplerSampler, ruv).rgb;
    col = mix(scene, refr, clamp(cover * amt, 0.0, 1.0));
    col += vec3f(rim * amt * 0.08);
  }
  fragmentOutputs.color = vec4f(col, 1.0);
}
`;

@Injectable({ providedIn: 'root' })
export class CloudService {
  private sceneService = inject(SceneService);
  private oceanService = inject(OceanService);
  private sfx          = inject(SfxService);

  private scene: Scene | null = null;
  private beforeRenderObserver: Observer<Scene> | null = null;

  // Layer B: sprite cloud masses
  private spriteManager: SpriteManager | null = null;
  private sprites: CloudSpriteEntry[] = [];
  // P5: sprite clouds retired in favour of the volumetric layer. Kept dormant as a
  // possible low-end fallback. Flip true to build + tick the old billboard clouds.
  private spritesEnabled = false;

  // Layer C: storm fog (GPU particles, CPU fallback)
  private stormTexture: DynamicTexture | null = null;
  private stormEmitter = new Vector3(0, 0, 0);
  private stormParticles: ParticleSystem | GPUParticleSystem | null = null;
  private stormUsesGpu = false;

  // Layer E: rain streaks (separate from mist; elongated additive particles)
  private rainTexture: DynamicTexture | null = null;
  private rainEmitter = new Vector3(0, 0, 0);
  private rainParticles: ParticleSystem | GPUParticleSystem | null = null;
  private rainUsesGpu = false;

  // Layer F: lens-rain post-process (drops on the camera lens)
  private lensRain: PostProcess | null = null;

  // Weather-driven state
  private cloudiness = 0.25;
  private targetCloudiness = 0.25;
  private storminess = 0;
  private targetStorminess = 0;
  private windX = 0;
  private windZ = 1;
  private windSpeed = 8;
  private stormPrecipitation = false;
  // Precipitation type + intensity (blended separately from storminess so the
  // visual rain ramp can differ from the fog ramp).
  private precipType: 'none' | 'drizzle' | 'rain' | 'storm' = 'none';
  private precipIntensity = 0;
  private targetPrecipIntensity = 0;

  // Layer D: volumetric ray-march clouds (post-process)
  private volClouds: VolumetricCloudsPlugin | null = null;

  // Lightning + thunder (active during storms)
  private lightningCooldown = 9;            // seconds until the next strike
  private flashStart = -100;                // this.elapsed at the current strike
  private flashActive = false;
  private pendingThunder: { at: number; vol: number } | null = null;
  private sfxCtx: AudioContext | null = null;

  // Continuous rain ambience (light patter bed), gain driven by precip intensity.
  private rainGain: GainNode | null = null;
  private rainNoiseStarted = false;
  private sfxMaster: GainNode | null = null;

  private elapsed = 0;
  private initialized = false;

  // Cloud quality: 0=Low 1=Medium 2=High(default) 3=Ultra
  private static readonly QUALITY_STEPS = [
    { marchSteps: 16, lightSteps: 3 },   // 0 Low
    { marchSteps: 28, lightSteps: 4 },   // 1 Medium
    { marchSteps: 48, lightSteps: 6 },   // 2 High  ← default
    { marchSteps: 80, lightSteps: 8 },   // 3 Ultra
  ] as const;
  private _cloudQuality = 2;

  getCloudQuality(): number { return this._cloudQuality; }

  setCloudQuality(level: number): void {
    const q = Math.max(0, Math.min(3, Math.round(level)));
    this._cloudQuality = q;
    if (this.volClouds) {
      const step = CloudService.QUALITY_STEPS[q];
      this.volClouds.marchSteps = step.marchSteps;
      this.volClouds.lightSteps = step.lightSteps;
    }
  }

  private readonly SPRITE_CAPACITY = 320;
  private readonly CANOPY_SPRITES  =  48;
  private readonly WRAP_RANGE = 26000;
  private readonly WRAP_SPAN  = 52000;
  private readonly CELL_SIZE  = 256;
  private readonly NUM_CELLS  =   4;

  init(): void {
    if (this.initialized) return;

    const scene = this.sceneService.scene;
    if (!scene) return;

    this.scene = scene;
    // Sprite cloud layer RETIRED (Phase 5): the volumetric clouds are now the sole cloud
    // representation and look better alone. initSpriteLayer/tickSprites/buildCloudSpriteImage
    // are kept in the file (dormant) as a potential low-end fallback, but not built or ticked.
    if (this.spritesEnabled) this.initSpriteLayer(scene);
    this.initStormLayer(scene);
    this.initRainLayer(scene);
    this.initLensRain();
    this.initVolumetricLayer();

    this.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
      this.tick(dt);
    });

    this.initialized = true;
  }

  updateWeather(weather: Weather): void {
    this.targetCloudiness = Math.max(0, Math.min(1, weather.cloudiness));

    let precip = 0;
    this.stormPrecipitation = weather.precipitation === 'storm';
    if (this.stormPrecipitation) precip = 1.0;
    else if (weather.precipitation === 'rain') precip = 0.30;
    else if (weather.precipitation === 'drizzle') precip = 0.10;
    this.targetStorminess = Math.max(precip, Math.max(0, this.targetCloudiness - 0.78) * 1.15);

    // Rain intensity target (blended independently from storm fog).
    this.precipType = (weather.precipitation ?? 'none') as typeof this.precipType;
    if (this.precipType === 'storm')        this.targetPrecipIntensity = 1.0;
    else if (this.precipType === 'rain')    this.targetPrecipIntensity = 0.40;
    else if (this.precipType === 'drizzle') this.targetPrecipIntensity = 0.12;
    else                                    this.targetPrecipIntensity = 0;

    // Wind comes FROM bearing, cloud advection moves TO opposite direction.
    const bearingRad = ((weather.wind.fromBearingDeg + 180) % 360) * Math.PI / 180;
    this.windX = Math.sin(bearingRad);
    this.windZ = Math.cos(bearingRad);
    this.windSpeed = Math.max(2, weather.wind.speed);

    // Keep volumetric layer in sync.
    if (this.volClouds) {
      this.volClouds.updateCoverage(this.targetCloudiness);
      // Cloud TYPE follows the weather: calm skies → fair-weather cumulus, storms →
      // towering cumulonimbus (taller, darker-based, more broken).
      this.volClouds.cloudType = 0.40 + this.targetStorminess * 0.55;
      this.volClouds.updateWind(
        new Vector3(this.windX, 0, this.windZ),
        this.windSpeed,
      );
    }
  }

  dispose(): void {
    if (this.scene && this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
    }
    this.beforeRenderObserver = null;

    this.spriteManager?.dispose();
    this.spriteManager = null;
    this.sprites = [];

    this.stormParticles?.dispose();
    this.stormParticles = null;
    this.stormTexture?.dispose();
    this.stormTexture = null;

    this.rainParticles?.dispose();
    this.rainParticles = null;
    this.rainTexture?.dispose();
    this.rainTexture = null;

    this.lensRain?.dispose();
    this.lensRain = null;

    this.sceneService.setLightningFlash(0);
    this.flashActive = false;
    this.pendingThunder = null;
    this.sfx.releaseMaster(this.sfxMaster);
    this.sfxMaster = null;
    this.sfxCtx?.close().catch(() => {});
    this.sfxCtx = null;
    this.rainGain = null;
    this.rainNoiseStarted = false;

    this.volClouds?.dispose();
    this.volClouds = null;

    this.scene = null;
    this.initialized = false;
  }

  // --------------------------------------------------------------------------
  // Layer D: volumetric ray-march clouds (post-process)
  // --------------------------------------------------------------------------

  private initVolumetricLayer(): void {
    const camera = this.sceneService.camera;
    if (!camera) {
      console.warn('[CloudService] No camera — skipping volumetric clouds');
      return;
    }

    this.volClouds = new VolumetricCloudsPlugin(
      this.scene!,
      camera,
      () => this.sceneService.getSunDirection(),
      {
        cloudBaseHeight:  900,
        cloudThickness:   600,
        cloudCoverage:    this.cloudiness,
        windDirection:    new Vector3(this.windX, 0, this.windZ),
        windSpeed:        this.windSpeed,
        // Quality defaults — can be tweaked at runtime.
        marchSteps:  48,
        lightSteps:  6,
        renderScale: 0.82,
      },
    );
  }

  // --------------------------------------------------------------------------
  // Layer B: sprite cloud masses
  // --------------------------------------------------------------------------

  private initSpriteLayer(scene: Scene): void {
    const spriteImage = this.buildCloudSpriteImage();
    this.spriteManager = new SpriteManager(
      'cloudSpriteManager', spriteImage,
      this.SPRITE_CAPACITY, this.CELL_SIZE, scene,
    );
    this.spriteManager.renderingGroupId = 0;

    // ── Seeded hash so cloud layout is deterministic ────────────────────────
    const h = (n: number) => { const x = Math.sin(n * 127.1) * 43758.5; return x - Math.floor(x); };

    // ── 1. Camera-anchored canopy sprites (overhead coverage) ───────────────
    for (let i = 0; i < this.CANOPY_SPRITES && i < this.SPRITE_CAPACITY; i++) {
      const angle  = (i / this.CANOPY_SPRITES) * Math.PI * 2 + i * 0.41;
      const radius = 1400 + (i % 8) * 280;
      const altBand = i % 3;
      const y = 960 + altBand * 380 + (i % 4) * 90;
      const size = 820 + (i % 6) * 140 + altBand * 80;

      const sprite = new Sprite(`cloudCanopy_${i}`, this.spriteManager!);
      sprite.position.set(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
      sprite.size      = size;
      sprite.cellIndex = i % this.NUM_CELLS;
      sprite.isVisible = false;
      sprite.color     = new Color4(1, 1, 1, 0);
      sprite.angle     = h(i * 3.7) * Math.PI;

      this.sprites.push({
        sprite,
        baseY: y,
        baseSize: size,
        driftScale: 0.18 + altBand * 0.06,
        phase: i * 0.53,
        spin: (h(i * 11.3) - 0.5) * 0.003,
      });
    }

    // ── 2. World-drifting sprites organised into cloud banks ────────────────
    //
    // Banks are sparsely distributed so there are real gaps between formations
    // rather than a uniform carpet.  Each bank spawns 5–9 overlapping sprites
    // of varying size and altitude, which together read as a single cloud mass.
    const BANK_COUNT  = 42;
    const bankRadii   = [3400, 5800, 9200, 14000, 20000, 26000];

    let created = this.CANOPY_SPRITES;
    for (let b = 0; b < BANK_COUNT && created < this.SPRITE_CAPACITY; b++) {
      // Bank centre
      const ringIdx  = b % bankRadii.length;
      const ring     = bankRadii[ringIdx];
      const angle    = (b / BANK_COUNT) * Math.PI * 2 + h(b * 5.1) * 0.9;
      const jitter   = h(b * 7.3) * (ring * 0.35);
      const bx = Math.sin(angle) * ring + Math.cos(angle * 1.7) * jitter;
      const bz = Math.cos(angle) * ring + Math.sin(angle * 1.3) * jitter;
      const bAlt = 1100 + (b % 3) * 420 + h(b * 3.1) * 180;

      // Sprites within this bank
      const bankSprites = 4 + (b % 5);
      for (let i = 0; i < bankSprites && created < this.SPRITE_CAPACITY; i++, created++) {
        const sa = (i / bankSprites) * Math.PI * 2 + h(created * 2.9);
        const sr = (140 + h(created * 4.1) * 420) * (1 + ringIdx * 0.22);
        const x  = bx + Math.sin(sa) * sr;
        const z  = bz + Math.cos(sa) * sr;
        const y  = bAlt + (h(created * 6.7) - 0.5) * 220;
        const sz = (880 + ringIdx * 90 + h(created * 8.3) * 280);

        const sprite = new Sprite(`cloudBank_${created}`, this.spriteManager!);
        sprite.position.set(x, y, z);
        sprite.size      = sz;
        sprite.cellIndex = created % this.NUM_CELLS;
        sprite.isVisible = false;
        sprite.color     = new Color4(1, 1, 1, 0);
        sprite.angle     = h(created * 5.3) * Math.PI;

        this.sprites.push({
          sprite,
          baseY: y,
          baseSize: sz,
          driftScale: 0.20 + (ringIdx % 3) * 0.05,
          phase: created * 0.37,
          spin: (h(created * 9.1) - 0.5) * 0.0018,
        });
      }
    }
  }

  // ── Spritesheet: NUM_CELLS cloud variants side-by-side ─────────────────────
  private buildCloudSpriteImage(): string {
    const cs = this.CELL_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width  = cs * this.NUM_CELLS;
    canvas.height = cs;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let v = 0; v < this.NUM_CELLS; v++) {
      this.drawCloudCell(ctx, v * cs, 0, cs, v);
    }
    return canvas.toDataURL('image/png');
  }

  /**
   * Draws one cumulus cloud variant into the canvas at (ox, oy).
   * Shape: flat base, bumpy top, built from layered elliptical soft puffs.
   */
  private drawCloudCell(
    ctx: CanvasRenderingContext2D,
    ox: number, oy: number, cs: number, v: number,
  ): void {
    // Deterministic per-variant hash.
    const h = (i: number, k = 0) => {
      const x = Math.sin(i * 127.1 + v * 311.7 + k * 53.3) * 43758.5;
      return x - Math.floor(x);
    };

    type Puff = { x: number; y: number; rx: number; ry: number; a: number; w: number };
    const puffs: Puff[] = [];

    // Layer 1 – wide, flat base puffs (anchor the cloud footprint).
    const nBase = 5 + (v % 2);
    for (let i = 0; i < nBase; i++) {
      puffs.push({
        x:  0.12 + (i + h(i, 1) * 0.5) / nBase * 0.76,
        y:  0.64 + h(i, 2) * 0.09,
        rx: 0.18 + h(i, 3) * 0.10,
        ry: 0.09 + h(i, 4) * 0.05,
        a:  0.86,
        w:  0.91,
      });
    }

    // Layer 2 – mid puffs (fill the body).
    const nMid = 8 + (v % 3);
    for (let i = 0; i < nMid; i++) {
      puffs.push({
        x:  0.10 + (i + h(i + 50, 1) * 0.4) / nMid * 0.80,
        y:  0.44 + h(i + 50, 2) * 0.16,
        rx: 0.09 + h(i + 50, 3) * 0.08,
        ry: 0.08 + h(i + 50, 4) * 0.07,
        a:  0.78 + h(i + 50, 5) * 0.14,
        w:  0.97 + h(i + 50, 6) * 0.03,
      });
    }

    // Layer 3 – top puffs, arched for the classic cumulus crown.
    const nTop = 10 + (v % 4);
    for (let i = 0; i < nTop; i++) {
      const t = i / (nTop - 1);
      const arch = Math.sin(t * Math.PI);  // tallest in the middle
      puffs.push({
        x:  0.13 + t * 0.74 + (h(i + 100, 1) - 0.5) * 0.10,
        y:  0.17 + (1 - arch) * 0.16 + h(i + 100, 2) * 0.07,
        rx: 0.055 + h(i + 100, 3) * 0.065,
        ry: 0.055 + h(i + 100, 4) * 0.060,
        a:  0.70 + h(i + 100, 5) * 0.22,
        w:  1.00,
      });
    }

    // Layer 4 – tiny accent puffs for high-frequency texture.
    for (let i = 0; i < 16; i++) {
      puffs.push({
        x:  0.14 + h(i + 200, 1) * 0.72,
        y:  0.20 + h(i + 200, 2) * 0.48,
        rx: 0.025 + h(i + 200, 3) * 0.040,
        ry: 0.020 + h(i + 200, 4) * 0.035,
        a:  0.28 + h(i + 200, 5) * 0.32,
        w:  1.00,
      });
    }

    // Draw puffs — base first so brighter tops render on top.
    for (const p of puffs) {
      const cx  = ox + p.x * cs;
      const cy  = oy + p.y * cs;
      const rx  = p.rx * cs;
      const ry  = p.ry * cs;
      const maxR = Math.max(rx, ry);

      // Squash/stretch the drawing context so the gradient is elliptical.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx / maxR, ry / maxR);

      const rv = Math.round(255 * Math.min(1, p.w));
      const gv = Math.round(255 * Math.min(1, p.w * 0.985));
      const bv = Math.round(255 * Math.min(1, p.w * 0.97 + 0.03));
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, maxR);
      grad.addColorStop(0.00, `rgba(${rv},${gv},${bv},${p.a.toFixed(3)})`);
      grad.addColorStop(0.38, `rgba(${rv},${gv},${bv},${(p.a * 0.68).toFixed(3)})`);
      grad.addColorStop(0.68, `rgba(${rv},${gv},${bv},${(p.a * 0.22).toFixed(3)})`);
      grad.addColorStop(0.88, `rgba(${rv},${gv},${bv},${(p.a * 0.05).toFixed(3)})`);
      grad.addColorStop(1.00, `rgba(${rv},${gv},${bv},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, maxR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // --------------------------------------------------------------------------
  // Layer C: storm fog (GPU + fallback)
  // --------------------------------------------------------------------------

  private initStormLayer(scene: Scene): void {
    this.stormTexture = this.buildStormTexture(scene);

    const gpuSupported = this.sceneService.isWebGPU && (GPUParticleSystem as unknown as { IsSupported?: boolean }).IsSupported !== false;
    if (gpuSupported) {
      this.stormParticles = new GPUParticleSystem('stormCloudGpu', { capacity: 9000, randomTextureSize: 256 }, scene);
      this.stormUsesGpu = true;
    } else {
      this.stormParticles = new ParticleSystem('stormCloudCpuFallback', 2200, scene);
      this.stormUsesGpu = false;
    }

    const ps = this.stormParticles;
    ps.particleTexture = this.stormTexture;
    ps.emitter = this.stormEmitter;
    ps.minEmitBox = new Vector3(-2200, -70, -2200);
    ps.maxEmitBox = new Vector3(2200, 95, 2200);

    ps.color1 = new Color4(0.76, 0.80, 0.88, 0.04);
    ps.color2 = new Color4(0.58, 0.64, 0.74, 0.02);
    ps.colorDead = new Color4(0.50, 0.56, 0.66, 0.0);

    ps.minSize = 34;
    ps.maxSize = 110;
    ps.minLifeTime = 9;
    ps.maxLifeTime = 18;
    ps.minEmitPower = 0.04;
    ps.maxEmitPower = 0.26;
    ps.direction1 = new Vector3(-0.22, 0.01, -0.22);
    ps.direction2 = new Vector3(0.22, 0.06, 0.22);
    ps.gravity = Vector3.Zero();
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.updateSpeed = 0.010;
    ps.emitRate = 0;
    ps.start();
  }

  private buildStormTexture(scene: Scene): DynamicTexture {
    const size = 128;
    const tex = new DynamicTexture('stormCloudParticleTex', { width: size, height: size }, scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, size, size);

    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.42, 'rgba(245,248,255,0.78)');
    g.addColorStop(0.78, 'rgba(218,228,245,0.20)');
    g.addColorStop(1.0, 'rgba(210,220,240,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    tex.update();
    return tex;
  }

  // --------------------------------------------------------------------------
  // Tick
  // --------------------------------------------------------------------------

  private tick(dt: number): void {
    if (!this.scene) return;

    this.elapsed += dt;
    this.cloudiness += (this.targetCloudiness - this.cloudiness) * Math.min(1, dt * 0.70);
    this.storminess += (this.targetStorminess - this.storminess) * Math.min(1, dt * 0.55);

    const camera = this.sceneService.camera;
    const camX = camera?.position.x ?? 0;
    const camZ = camera?.position.z ?? 0;

    if (this.spritesEnabled) this.tickSprites(dt, camX, camZ);
    this.tickStormLayer(dt, camX, camZ);
    this.tickRainLayer(dt, camX, camZ);
    this.tickLightning(dt);

    // Keep ocean reflection in sync with current sky coverage and sun position.
    const sunEl = this.sceneService.getSunDirection().y;
    this.oceanService.setCloudReflection(this.cloudiness, sunEl);
  }

  private tickSprites(dt: number, camX: number, camZ: number): void {
    const cloudD = Math.max(0, Math.min(1, this.cloudiness));
    const stormD = Math.max(0, Math.min(1, this.storminess));

    // Fade in more sprites as cloudiness rises; always show canopy minimum.
    const activeRatio = Math.max(this.CANOPY_SPRITES / this.sprites.length,
                                 Math.min(1, 0.22 + cloudD * 0.78));
    const activeCount = Math.floor(this.sprites.length * activeRatio);

    const drift   = this.windSpeed * dt * 10.0;
    const overcast = Math.max(0, Math.min(1, cloudD * 0.75 + stormD * 0.45));
    const shade    = 1.0 - (overcast * 0.22 + stormD * 0.10);
    const alphaBase = 0.13 + cloudD * 0.38;

    for (let i = 0; i < this.sprites.length; i++) {
      const e = this.sprites[i];
      const s = e.sprite;
      if (i >= activeCount) { s.isVisible = false; continue; }

      s.isVisible = true;

      if (i < this.CANOPY_SPRITES) {
        // Camera-anchored: slow drift anchored to camera position.
        const radius = e.baseSize * 1.6;           // re-use baseSize as rough scale
        const angle  = e.phase * 1.23;
        const drift2 = this.elapsed * this.windSpeed * 14.0 * e.driftScale;
        s.position.x = camX + Math.sin(angle) * radius + this.windX * drift2;
        s.position.z = camZ + Math.cos(angle) * radius + this.windZ * drift2;
        s.position.y = e.baseY - stormD * 120 + Math.sin(this.elapsed * 0.10 + e.phase) * 40;
      } else {
        // World-drifting bank sprite — advects with wind, wraps at edges.
        s.position.x += this.windX * drift * e.driftScale;
        s.position.z += this.windZ * drift * e.driftScale;
        s.position.y  = e.baseY - stormD * 240 + Math.sin(this.elapsed * 0.08 + e.phase) * 65;

        if (s.position.x - camX >  this.WRAP_RANGE) s.position.x -= this.WRAP_SPAN;
        if (camX - s.position.x >  this.WRAP_RANGE) s.position.x += this.WRAP_SPAN;
        if (s.position.z - camZ >  this.WRAP_RANGE) s.position.z -= this.WRAP_SPAN;
        if (camZ - s.position.z >  this.WRAP_RANGE) s.position.z += this.WRAP_SPAN;
      }

      s.angle += e.spin * dt;

      const pulse = 0.96 + Math.sin(this.elapsed * 0.18 + e.phase) * 0.04;
      s.size = e.baseSize * (0.90 + cloudD * 0.22) * pulse;

      const alpha = Math.min(0.72, alphaBase + stormD * 0.05);
      s.color = new Color4(0.97 * shade, 0.98 * shade, 1.00 * shade, alpha);
    }
  }

  private tickStormLayer(dt: number, camX: number, camZ: number): void {
    if (!this.stormParticles) return;

    const cloudD = Math.max(0, Math.min(1, this.cloudiness));
    const stormD = Math.max(0, Math.min(1, this.storminess));

    this.stormEmitter.x = camX;
    this.stormEmitter.z = camZ;
    this.stormEmitter.y = 820 - stormD * 180;

    const severity = Math.max(0, Math.min(1, (cloudD - 0.74) * 1.55 + stormD * 1.05));
    if (severity < 0.12 || (!this.stormPrecipitation && stormD < 0.75)) {
      this.stormParticles.emitRate = 0;
      return;
    }

    const gpuFactor = this.stormUsesGpu ? 1.0 : 0.36;
    this.stormParticles.emitRate = (16 + severity * 820) * gpuFactor;

    this.stormParticles.minSize = 28 + severity * 14;
    this.stormParticles.maxSize = 82 + severity * 48;

    const alphaA = 0.01 + severity * 0.06;
    const alphaB = 0.005 + severity * 0.035;
    this.stormParticles.color1 = new Color4(0.76, 0.80, 0.88, alphaA);
    this.stormParticles.color2 = new Color4(0.58, 0.64, 0.74, alphaB);

    const driftPush = this.windSpeed * (0.010 + severity * 0.006);
    this.stormParticles.direction1.set(this.windX * driftPush - 0.12, 0.00, this.windZ * driftPush - 0.12);
    this.stormParticles.direction2.set(this.windX * driftPush + 0.12, 0.04, this.windZ * driftPush + 0.12);

    this.stormParticles.minEmitPower = 0.02 + severity * 0.03;
    this.stormParticles.maxEmitPower = 0.08 + severity * 0.08;

    // Time modulation to avoid static fog plate.
    this.stormParticles.updateSpeed = 0.008 + severity * 0.006 + Math.sin(this.elapsed * 0.35) * 0.0012;
  }

  // --------------------------------------------------------------------------
  // Layer E: rain streaks
  // --------------------------------------------------------------------------

  private initRainLayer(scene: Scene): void {
    this.rainTexture = this.buildRainTexture(scene);

    // Always use the CPU particle system for rain: GPUParticleSystem does not
    // support non-uniform minScaleX/minScaleY, which are essential for the
    // elongated streak appearance. 12 000 capacity lets a full storm fill the
    // screen with dense, driving rain.
    this.rainParticles = new ParticleSystem('rain', 12_000, scene);
    this.rainUsesGpu = false;

    const ps = this.rainParticles;
    ps.particleTexture = this.rainTexture;
    ps.emitter = this.rainEmitter;

    // Spread emitters in a 400 m × 400 m square at a fixed height above the
    // emitter point.  The emitter itself tracks the camera (see tickRainLayer).
    ps.minEmitBox = new Vector3(-200, 0, -200);
    ps.maxEmitBox = new Vector3( 200, 0,  200);

    // Direction is predominantly downward; wind component is set each tick.
    // Fast fall (~55 m/s) with a short lifetime so streaks rip past the camera
    // and recycle quickly — real rain reads as fast, not drifting. From the
    // emitter at +130 m: 55 m/s × ~3 s ≈ 165 m, reaching the water before expiry.
    ps.direction1 = new Vector3(-0.03, -1, -0.03);
    ps.direction2 = new Vector3( 0.03, -1,  0.03);
    // Driving rain: very fast fall (~70–100 m/s) and short life so streaks tear
    // down the screen. From +130 m they cross the visible band in well under a
    // second, reading as hard, beating rain rather than a drift.
    ps.minEmitPower = 70;
    ps.maxEmitPower = 100;
    ps.minLifeTime  = 1.8;
    ps.maxLifeTime  = 2.6;

    // Bright translucent white. STANDARD (alpha) blending — see blendMode below —
    // composites the streaks OVER the water, so they stay visible even against a
    // pale, near-white storm sea (additive white was invisible there).
    ps.color1    = new Color4(0.88, 0.92, 0.98, 0.55);
    ps.color2    = new Color4(0.80, 0.86, 0.95, 0.40);
    ps.colorDead = new Color4(0.80, 0.86, 0.95, 0.0);

    // Thin, long streaks: tiny scaleX = a fine vertical line; large scaleY
    // stretches it into a fast motion-blurred streak. Wide size/scale ranges so
    // drops vary from small fine threads to longer, fatter streaks (per-particle
    // random) — avoids the uniform "every drop identical" look.
    ps.minSize   = 2.5;
    ps.maxSize   = 9.0;
    ps.minScaleX = 0.04;
    ps.maxScaleX = 0.14;
    ps.minScaleY = 2.4;
    ps.maxScaleY = 6.2;

    // STANDARD alpha blending: streaks composite OVER the water with their own
    // opacity, so they read clearly against both the dark sky and a pale sea.
    // (Additive washed out completely over bright, near-white storm water.)
    ps.blendMode   = ParticleSystem.BLENDMODE_STANDARD;
    ps.gravity     = Vector3.Zero();  // velocity comes from direction × emitPower
    ps.updateSpeed = 0.016;
    ps.emitRate    = 0;

    // Group 3 renders after ocean + terrain (groups 0–2) so additive blending
    // composites correctly over water.  Without this call, Babylon.js would
    // clear the depth buffer before group 3, making rain appear in front of the
    // ship.  Keeping the depth buffer lets rain depth-test against the hull.
    scene.setRenderingAutoClearDepthStencil(3, false);
    ps.renderingGroupId = 3;
    ps.start();
  }

  /**
   * Thin, crisp vertical rain streak.  A tall narrow texture (8×64) filled
   * per-pixel: a sharp horizontal Gaussian (so the streak is a fine line, not a
   * blob) multiplied by a vertical profile that fades softly at both ends and
   * tapers toward the top — reading as a motion-blurred falling drop.
   */
  private buildRainTexture(scene: Scene): DynamicTexture {
    const w = 8, h = 64;
    const tex = new DynamicTexture('rainTex', { width: w, height: h }, scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const img = ctx.createImageData(w, h);

    const cx = (w - 1) / 2;
    const sigmaX = 0.85;           // horizontal tightness — small = fine line
    for (let y = 0; y < h; y++) {
      // Vertical profile: ramp in over the first 18%, taper out over the last
      // 35% (heavier head, trailing tail — a streak with direction of travel).
      const v = y / (h - 1);
      const headIn  = Math.min(1, v / 0.18);
      const tailOut = 1 - Math.max(0, (v - 0.65) / 0.35);
      const vert = Math.max(0, headIn * tailOut);
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / sigmaX;
        const horiz = Math.exp(-dx * dx);          // sharp Gaussian across width
        // Raise to a power to crush the soft feathered edge: this keeps the
        // bright core but kills the faint translucent halo that was only visible
        // against dark backgrounds (the "outline" over the islands).
        const a = Math.min(1, Math.pow(horiz * vert, 1.8));
        const i = (y * w + x) * 4;
        img.data[i]     = 225;   // bright neutral blue-white
        img.data[i + 1] = 236;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    tex.update();
    return tex;
  }

  private tickRainLayer(dt: number, camX: number, camZ: number): void {
    if (!this.rainParticles) return;

    // Smoothly blend toward target intensity (faster ramp-up than ramp-down).
    const lerpRate = this.precipIntensity < this.targetPrecipIntensity ? 0.9 : 0.55;
    this.precipIntensity += (this.targetPrecipIntensity - this.precipIntensity) *
      Math.min(1, dt * lerpRate);

    // Drive the ocean's surface rain-ripple normals (covers the dry case too).
    this.oceanService.setRainIntensity(this.precipIntensity);
    // Drive the continuous rain-patter ambience.
    this.updateRainAmbience(this.precipIntensity);

    const camera = this.sceneService.camera;
    const camY = camera?.position.y ?? 0;

    // Keep emitter directly above the camera so rain falls around the player.
    // 130 m height + ~55 m/s × ~3 s ≈ 165 m fall — reaches the water surface
    // before the particle expires.
    this.rainEmitter.x = camX;
    this.rainEmitter.y = camY + 130;
    this.rainEmitter.z = camZ;

    const intens = this.precipIntensity;
    if (intens < 0.005) {
      this.rainParticles.emitRate = 0;
      return;
    }

    // Emit rate: drizzle ≈ 120/s, rain ≈ 600/s, extreme storm ≈ 2 000/s.
    // 2 000 × lifetime 5 s = 10 000 simultaneous particles — at 5 000 capacity
    // the oldest recycle quickly, keeping the screen dense with streaks.
    const gustFactor = intens > 0.75
      ? (0.85 + 0.15 * Math.sin(this.elapsed * 0.7 + 1.3))
      : 1.0;
    // Drizzle ≈ 250/s, rain ≈ 2 100/s, full storm ≈ 5 000/s. At 12 000 capacity
    // and ~2.2 s life the screen saturates with streaks during a storm.
    this.rainParticles.emitRate = (200 + intens * 4800) * gustFactor;

    // Wind direction tilts the rain.  At windSpeed = 20 m/s with factor 0.022
    // the lateral velocity is ≈ 0.44 m/s per m/s of downward velocity,
    // producing a noticeable ~24° tilt during a gale.
    const tilt = this.windSpeed * 0.022;
    const jitter = 0.06;
    this.rainParticles.direction1 = new Vector3(
      this.windX * tilt - jitter, -1, this.windZ * tilt - jitter,
    );
    this.rainParticles.direction2 = new Vector3(
      this.windX * tilt + jitter, -1, this.windZ * tilt + jitter,
    );

    // Rotate each newly-emitted particle so its long axis aligns with the
    // screen-space fall direction.  Without this the drop sprite is always
    // drawn upright even when the wind tilts the trajectory sideways.
    //
    // Project the 3-D velocity (windX*tilt, -1, windZ*tilt) onto the camera's
    // right and up axes to get the 2-D screen-space direction, then compute
    // the angle from "pointing downward on screen" (angle = 0 = no rotation).
    if (camera) {
      const wm = camera.getWorldMatrix();
      const camRight = Vector3.TransformNormal(new Vector3(1, 0, 0), wm);
      const camUp    = Vector3.TransformNormal(new Vector3(0, 1, 0), wm);
      const screenX  = this.windX * tilt * camRight.x - camRight.y + this.windZ * tilt * camRight.z;
      const screenY  = this.windX * tilt * camUp.x    - camUp.y    + this.windZ * tilt * camUp.z;
      const dropAngle = Math.atan2(screenX, -screenY);
      this.rainParticles.minInitialRotation = dropAngle - 0.05;
      this.rainParticles.maxInitialRotation = dropAngle + 0.05;
    }

    // Alpha scales with intensity: light drizzle → heavy, near-opaque storm
    // streaks (standard blending, so higher alpha = more visible, not glowing).
    const alphaA = 0.34 + intens * 0.50;
    const alphaB = 0.26 + intens * 0.42;
    this.rainParticles.color1 = new Color4(0.88, 0.92, 0.98, alphaA);
    this.rainParticles.color2 = new Color4(0.80, 0.86, 0.95, alphaB);
  }

  // --------------------------------------------------------------------------
  // Layer F: lens-rain post-process
  // --------------------------------------------------------------------------

  private initLensRain(): void {
    const camera = this.sceneService.camera;
    const engine = this.sceneService.engine;
    if (!camera || !engine) return;

    const useWgsl = this.sceneService.isWebGPU;
    // Register the shader source in the store the engine reads from.
    if (useWgsl) {
      ShaderStore.ShadersStoreWGSL['lensRainPixelShader'] = LENS_RAIN_WGSL;
    } else {
      ShaderStore.ShadersStore['lensRainPixelShader'] = LENS_RAIN_GLSL;
    }

    this.lensRain = new PostProcess(
      'lensRain',
      'lensRain',
      ['uTime', 'uIntensity', 'uAspect'],   // uniforms
      null,                                  // samplers (textureSampler is implicit)
      1.0,                                   // full-resolution
      camera,
      2,                                     // BILINEAR sampling — smooth refraction
      engine,
      false,                                 // not reusable
      null,                                  // defines
      0,                                     // textureType: unsigned byte
      undefined,                             // default postprocess vertex shader
      undefined,
      false,
      undefined,
      useWgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    );

    this.lensRain.onApply = (effect) => {
      effect.setFloat('uTime', this.elapsed);
      effect.setFloat('uIntensity', this.precipIntensity);
      const w = engine.getRenderWidth() || 1;
      const h = engine.getRenderHeight() || 1;
      effect.setFloat('uAspect', w / h);
    };
  }

  // --------------------------------------------------------------------------
  // Lightning + thunder
  // --------------------------------------------------------------------------

  private tickLightning(dt: number): void {
    // Storm "energy": the stronger of smoothed storminess and rain intensity.
    const storm = Math.max(this.storminess, this.precipIntensity);

    // Trigger strikes only in real storms; cadence shortens as the storm builds.
    if (storm > 0.4) {
      this.lightningCooldown -= dt;
      if (this.lightningCooldown <= 0) this.strikeLightning(storm);
    }

    // Drive the flash envelope.
    if (this.flashActive) {
      const te = this.elapsed - this.flashStart;
      if (te > 0.7) {
        this.flashActive = false;
        this.sceneService.setLightningFlash(0);
      } else {
        this.sceneService.setLightningFlash(this.computeFlash(te) * (0.6 + 0.4 * storm));
      }
    }

    // Fire the delayed thunder for the most recent strike.
    if (this.pendingThunder && this.elapsed >= this.pendingThunder.at) {
      this.playThunder(this.pendingThunder.vol);
      this.pendingThunder = null;
    }
  }

  /** Multi-peak flash curve: a sharp snap, then one or two fading flickers. */
  private computeFlash(te: number): number {
    if (te < 0) return 0;
    let l = Math.exp(-te / 0.05);
    if (te > 0.10) l += 0.8 * Math.exp(-(te - 0.10) / 0.07);
    if (te > 0.24) l += 0.5 * Math.exp(-(te - 0.24) / 0.11);
    return Math.min(1, l);
  }

  private strikeLightning(storm: number): void {
    this.flashStart  = this.elapsed;
    this.flashActive = true;

    // Next strike: 7–28 s, shorter in heavier storms.
    this.lightningCooldown = 7 + Math.random() * 21 * (1.3 - storm);

    // "Distance" 0 (close) → 1 (far): sets the thunder delay (≈ sound travel) and
    // its loudness. Determ. randomness is fine here — varies the storm naturally.
    const dist  = Math.random();
    const delay = 0.4 + dist * 5.5;                       // seconds after the flash
    const vol   = (0.35 + 0.65 * (1 - dist)) * Math.min(1, storm + 0.25);
    this.pendingThunder = { at: this.elapsed + delay, vol };
  }

  private ensureSfxCtx(): AudioContext {
    if (!this.sfxCtx) {
      this.sfxCtx = new AudioContext();
      this.sfxMaster = this.sfx.createMaster(this.sfxCtx);
    }
    return this.sfxCtx;
  }

  /** Light, continuous rain-patter bed: looping filtered noise scaled by intensity. */
  private updateRainAmbience(intensity: number): void {
    // Don't create audio nodes until there's meaningful rain.
    if (intensity < 0.01 && !this.rainNoiseStarted) return;
    const ctx = this.ensureSfxCtx();
    if (ctx.state === 'suspended') ctx.resume();

    if (!this.rainNoiseStarted) {
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // Band-limit the noise to the hissy "patter" range.
      const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 600;
      const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass';  lpf.frequency.value = 7000;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(hpf); hpf.connect(lpf); lpf.connect(g); g.connect(this.sfxMaster ?? ctx.destination);
      src.start();
      this.rainGain = g;
      this.rainNoiseStarted = true;
    }

    if (this.rainGain) {
      const target = Math.min(1, intensity) * 0.14;   // kept light
      this.rainGain.gain.setTargetAtTime(target, ctx.currentTime, 0.25);
    }
  }

  /** Procedural thunder: filtered noise with a rolling, decaying rumble. */
  private playThunder(vol: number): void {
    const ctx = this.ensureSfxCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;

    const dur = 3.0 + (1 - vol) * 3.0;   // distant thunder rolls longer
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Lowpass sweeping down → deep, dark rumble. Closer thunder opens brighter.
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.setValueAtTime(300 + vol * 700, t);
    lpf.frequency.exponentialRampToValueAtTime(70, t + dur);
    lpf.Q.value = 0.4;

    const g = ctx.createGain();
    const peak = 0.9 * Math.max(0.05, Math.min(1, vol));
    g.gain.setValueAtTime(0.0001, t);
    // Sharp crack for close strikes, soft build for distant ones.
    if (vol > 0.6) g.gain.exponentialRampToValueAtTime(peak, t + 0.03);
    else           g.gain.linearRampToValueAtTime(peak * 0.6, t + 0.2);
    // A few rolling swells.
    let tt = t + 0.25;
    for (let k = 0; k < 4 && tt < t + dur - 0.4; k++) {
      const p = Math.max(0.001, peak * (0.35 + Math.random() * 0.6));
      g.gain.exponentialRampToValueAtTime(p, tt + 0.22);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, p * 0.4), tt + 0.5);
      tt += 0.45 + Math.random() * 0.5;
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(lpf); lpf.connect(g); g.connect(this.sfxMaster ?? ctx.destination);
    src.start(t); src.stop(t + dur);
  }
}
