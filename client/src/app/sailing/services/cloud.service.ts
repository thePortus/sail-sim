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
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
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

@Injectable({ providedIn: 'root' })
export class CloudService {
  private sceneService = inject(SceneService);
  private oceanService = inject(OceanService);

  private scene: Scene | null = null;
  private beforeRenderObserver: Observer<Scene> | null = null;

  // Layer B: sprite cloud masses
  private spriteManager: SpriteManager | null = null;
  private sprites: CloudSpriteEntry[] = [];

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
    this.initSpriteLayer(scene);
    this.initStormLayer(scene);
    this.initRainLayer(scene);
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

    this.tickSprites(dt, camX, camZ);
    this.tickStormLayer(dt, camX, camZ);
    this.tickRainLayer(dt, camX, camZ);

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
    // elongated streak appearance.  5 000 CPU particles is plenty for a
    // convincing effect and still runs comfortably at 60 fps.
    this.rainParticles = new ParticleSystem('rain', 5_000, scene);
    this.rainUsesGpu = false;

    const ps = this.rainParticles;
    ps.particleTexture = this.rainTexture;
    ps.emitter = this.rainEmitter;

    // Spread emitters in a 400 m × 400 m square at a fixed height above the
    // emitter point.  The emitter itself tracks the camera (see tickRainLayer).
    ps.minEmitBox = new Vector3(-200, 0, -200);
    ps.maxEmitBox = new Vector3( 200, 0,  200);

    // Direction is predominantly downward; wind component is set each tick.
    // emitPower × direction gives particle velocity — 20 m/s downward with a
    // slight spread means streaks fall ~100 m in 5 s, from emitter at +110 m.
    ps.direction1 = new Vector3(-0.04, -1, -0.04);
    ps.direction2 = new Vector3( 0.04, -1,  0.04);
    ps.minEmitPower = 18;
    ps.maxEmitPower = 24;
    ps.minLifeTime  = 4.0;
    ps.maxLifeTime  = 5.5;

    // Rain-drop colour: bright blue-white, clearly visible against the sea.
    ps.color1    = new Color4(0.82, 0.90, 0.98, 0.80);
    ps.color2    = new Color4(0.76, 0.85, 0.96, 0.68);
    ps.colorDead = new Color4(0.76, 0.85, 0.96, 0.0);

    // Non-uniform scale: slightly elongated drops, not long thin streaks.
    // Base size 3–5 m; scaleX makes them somewhat narrow, scaleY adds a
    // modest vertical stretch so they read as falling drops, not blobs.
    // At 100 m distance a 4 m base × scaleY 1.8 = 7.2 m tall particle
    // spans ~40 px — clearly a drop, not a multi-metre streak.
    ps.minSize   = 3.0;
    ps.maxSize   = 5.0;
    ps.minScaleX = 0.28;
    ps.maxScaleX = 0.45;
    ps.minScaleY = 1.4;
    ps.maxScaleY = 2.2;

    // Additive blending brightens rain over the ocean without occluding it.
    ps.blendMode   = ParticleSystem.BLENDMODE_ADD;
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
   * Soft oval drop texture — wider than a pure streak so it reads as a
   * raindrop rather than a thin line.  Radial gradient with a slight vertical
   * stretch: transparent edge → bright blue-white centre.
   */
  private buildRainTexture(scene: Scene): DynamicTexture {
    const w = 16, h = 24;
    const tex = new DynamicTexture('rainTex', { width: w, height: h }, scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, w, h);

    // Elliptical radial gradient: centre of the oval is slightly above middle
    // (teardrop bias — heavier at the bottom like a real falling drop).
    const cx = w / 2, cy = h * 0.42;
    const rx = w / 2, ry = h * 0.48;   // semi-axes of the oval
    const maxR = Math.max(rx, ry);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx / maxR, ry / maxR);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, maxR);
    g.addColorStop(0.00, 'rgba(230,242,255,0.95)');
    g.addColorStop(0.35, 'rgba(210,232,255,0.75)');
    g.addColorStop(0.68, 'rgba(190,218,255,0.35)');
    g.addColorStop(1.00, 'rgba(180,210,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, maxR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    tex.update();
    return tex;
  }

  private tickRainLayer(dt: number, camX: number, camZ: number): void {
    if (!this.rainParticles) return;

    // Smoothly blend toward target intensity (faster ramp-up than ramp-down).
    const lerpRate = this.precipIntensity < this.targetPrecipIntensity ? 0.9 : 0.55;
    this.precipIntensity += (this.targetPrecipIntensity - this.precipIntensity) *
      Math.min(1, dt * lerpRate);

    const camera = this.sceneService.camera;
    const camY = camera?.position.y ?? 0;

    // Keep emitter directly above the camera so rain falls around the player.
    // 110 m height + ~22 m/s × 5 s ≈ 110 m fall — just enough to reach the
    // water surface before the particle expires.
    this.rainEmitter.x = camX;
    this.rainEmitter.y = camY + 110;
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
      ? (0.88 + 0.12 * Math.sin(this.elapsed * 0.7 + 1.3))
      : 1.0;
    this.rainParticles.emitRate = (120 + intens * 1880) * gustFactor;

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

    // Alpha scales with intensity: drizzle is light, storm is heavy and opaque.
    const alphaA = 0.45 + intens * 0.40;
    const alphaB = 0.35 + intens * 0.38;
    this.rainParticles.color1 = new Color4(0.82, 0.90, 0.98, alphaA);
    this.rainParticles.color2 = new Color4(0.76, 0.85, 0.96, alphaB);
  }
}
