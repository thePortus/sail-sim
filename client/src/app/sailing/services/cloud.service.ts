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

  // Weather-driven state
  private cloudiness = 0.25;
  private targetCloudiness = 0.25;
  private storminess = 0;
  private targetStorminess = 0;
  private windX = 0;
  private windZ = 1;
  private windSpeed = 8;
  private stormPrecipitation = false;

  private elapsed = 0;
  private initialized = false;

  private readonly SPRITE_CAPACITY = 260;
  private readonly WRAP_RANGE = 26000;
  private readonly WRAP_SPAN = 52000;

  init(): void {
    if (this.initialized) return;

    const scene = this.sceneService.scene;
    if (!scene) return;

    this.scene = scene;
    this.initSpriteLayer(scene);
    this.initStormLayer(scene);

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

    // Wind comes FROM bearing, cloud advection moves TO opposite direction.
    const bearingRad = ((weather.wind.fromBearingDeg + 180) % 360) * Math.PI / 180;
    this.windX = Math.sin(bearingRad);
    this.windZ = Math.cos(bearingRad);
    this.windSpeed = Math.max(2, weather.wind.speed);
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

    this.scene = null;
    this.initialized = false;
  }

  // --------------------------------------------------------------------------
  // Layer B: sprite cloud masses
  // --------------------------------------------------------------------------

  private initSpriteLayer(scene: Scene): void {
    const spriteImage = this.buildCloudSpriteImage();
    this.spriteManager = new SpriteManager('cloudSpriteManager', spriteImage, this.SPRITE_CAPACITY, 256, scene);
    this.spriteManager.renderingGroupId = 0;

    // Order matters: low-cloudiness states activate earliest entries first,
    // so near rings must be generated first to ensure visible overhead sprites.
    const rings = [2200, 3800, 6200, 9800, 14800, 21200, 28600];

    let created = 0;
    for (let r = 0; r < rings.length && created < this.SPRITE_CAPACITY; r++) {
      const ring = rings[r];
      const count = r < 3 ? 44 + r * 12 : 24 + r * 8;
      for (let i = 0; i < count && created < this.SPRITE_CAPACITY; i++, created++) {
        const a = (i / count) * Math.PI * 2 + r * 0.17;
        const jitter = (Math.sin(i * 1.7 + r) * 0.5 + 0.5) * (r < 3 ? 900 : 1800);
        const x = Math.sin(a) * ring + Math.cos(a * 1.9) * jitter;
        const z = Math.cos(a) * ring + Math.sin(a * 1.3) * jitter;

        const altitudeBand = r % 3;
        const y = 1180 + altitudeBand * 430 + (i % 4) * 110 + (r < 2 ? -80 : 0);

        const sprite = new Sprite(`cloudSprite_${created}`, this.spriteManager);
        sprite.position.set(x, y, z);
        sprite.size = (r < 3 ? 1060 : 940) + (i % 7) * 150 + altitudeBand * 120;
        sprite.cellIndex = 0;
        sprite.isVisible = false;
        sprite.color = new Color4(1, 1, 1, 0);
        sprite.angle = (i % 13) * 0.18;

        this.sprites.push({
          sprite,
          baseY: y,
          baseSize: sprite.size,
          driftScale: 0.22 + altitudeBand * 0.07,
          phase: created * 0.37,
          spin: ((i % 9) - 4) * 0.0022,
        });
      }
    }
  }

  private buildCloudSpriteImage(): string {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

    ctx.clearRect(0, 0, size, size);

    const puffs = [
      { x: 0.25, y: 0.52, r: 0.20 },
      { x: 0.42, y: 0.45, r: 0.24 },
      { x: 0.58, y: 0.50, r: 0.23 },
      { x: 0.74, y: 0.56, r: 0.20 },
      { x: 0.50, y: 0.62, r: 0.22 },
    ];

    for (const p of puffs) {
      const cx = p.x * size;
      const cy = p.y * size;
      const rr = p.r * size;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
      g.addColorStop(0.30, 'rgba(250,252,255,0.88)');
      g.addColorStop(0.64, 'rgba(238,244,252,0.34)');
      g.addColorStop(1.0, 'rgba(225,235,250,0.0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Break radial symmetry to avoid obvious circular fog blobs.
    for (let i = 0; i < 28; i++) {
      const x = (Math.sin(i * 1.73) * 0.5 + 0.5) * size;
      const y = (Math.cos(i * 1.21) * 0.28 + 0.58) * size;
      const w = 16 + (i % 7) * 8;
      const h = 8 + (i % 5) * 6;
      ctx.fillStyle = `rgba(255,255,255,${0.02 + (i % 4) * 0.01})`;
      ctx.beginPath();
      ctx.ellipse(x, y, w, h, i * 0.37, 0, Math.PI * 2);
      ctx.fill();
    }

    return canvas.toDataURL('image/png');
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
  }

  private tickSprites(dt: number, camX: number, camZ: number): void {
    const cloudD = Math.max(0, Math.min(1, this.cloudiness));
    const stormD = Math.max(0, Math.min(1, this.storminess));
    const activeRatio = Math.max(0.24, Math.min(1, 0.26 + cloudD * 0.74));
    const activeCount = Math.floor(this.sprites.length * activeRatio);

    const drift = this.windSpeed * dt * 10.0;
    const overcast = Math.max(0, Math.min(1, cloudD * 0.75 + stormD * 0.45));
    const shade = 1.0 - (overcast * 0.24 + stormD * 0.12);
    const alphaBase = 0.14 + cloudD * 0.40;

    for (let i = 0; i < this.sprites.length; i++) {
      const e = this.sprites[i];
      const s = e.sprite;
      if (i >= activeCount) {
        s.isVisible = false;
        continue;
      }

      s.isVisible = true;

      s.position.x += this.windX * drift * e.driftScale;
      s.position.z += this.windZ * drift * e.driftScale;
      s.position.y = e.baseY - stormD * 260 + Math.sin(this.elapsed * 0.09 + e.phase) * 75;
      s.angle += e.spin * dt;

      if (s.position.x - camX > this.WRAP_RANGE) s.position.x -= this.WRAP_SPAN;
      if (camX - s.position.x > this.WRAP_RANGE) s.position.x += this.WRAP_SPAN;
      if (s.position.z - camZ > this.WRAP_RANGE) s.position.z -= this.WRAP_SPAN;
      if (camZ - s.position.z > this.WRAP_RANGE) s.position.z += this.WRAP_SPAN;

      const pulse = 0.94 + Math.sin(this.elapsed * 0.22 + e.phase) * 0.06;
      s.size = e.baseSize * (0.88 + cloudD * 0.26) * pulse;

      const alpha = alphaBase + stormD * 0.05;
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
}
