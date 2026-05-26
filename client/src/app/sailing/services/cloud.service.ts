import { Injectable, inject } from '@angular/core';
import {
  Scene, Vector3, Color3, Color4, DynamicTexture, ParticleSystem,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { Weather } from '../models';

type CloudSystem = {
  system: ParticleSystem;
  emitter: Vector3;
  baseEmitter: Vector3;
  driftScale: number;
  layer: number;
};

@Injectable({ providedIn: 'root' })
export class CloudService {
  private sceneService = inject(SceneService);

  private texture: DynamicTexture | null = null;
  private cloudSystems: CloudSystem[] = [];
  private cloudiness = 0.2;
  private targetCloudiness = 0.2;
  private precipStrength = 0;
  private windX = 0;
  private windZ = 1;
  private windSpeed = 8;
  private elapsed = 0;
  private initialized = false;

  private readonly CLOUD_SPAN = 32000;
  private readonly CLOUD_WRAP_RANGE = 22000;

  init(): void {
    if (this.initialized) return;
    const scene = this.sceneService.scene;
    if (!scene) return;

    this.texture = this.buildCloudTexture(scene);

    const centers: Vector3[] = [];
    const rings = [7000, 12000, 17000, 22000];
    for (let r = 0; r < rings.length; r++) {
      const radius = rings[r];
      const count = 6 + r * 2;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + r * 0.19;
        const jitter = (i % 2 === 0 ? 1 : -1) * (900 + r * 180);
        const x = Math.sin(a) * radius + Math.cos(a * 1.7) * jitter;
        const z = Math.cos(a) * radius + Math.sin(a * 1.3) * jitter;
        const y = 1750 + r * 220 + (i % 3) * 170;
        centers.push(new Vector3(x, y, z));
      }
    }

    centers.forEach((center, index) => {
      const layer = index % 3;
      const system = new ParticleSystem(`cloud_ps_${index}`, 520, scene);
      system.particleTexture = this.texture!;
      system.emitter = center.clone();
      const span = 1800 + layer * 500;
      system.minEmitBox = new Vector3(-span, -240, -span);
      system.maxEmitBox = new Vector3( span,  240,  span);
      system.color1 = new Color4(1.0, 1.0, 1.0, 0.72);
      system.color2 = new Color4(0.94, 0.97, 1.0, 0.50);
      system.colorDead = new Color4(1.0, 1.0, 1.0, 0.0);
      system.minSize = 30 + layer * 6;
      system.maxSize = 112 + layer * 14;
      system.minLifeTime = 24 + layer * 5;
      system.maxLifeTime = 62 + layer * 8;
      system.minEmitPower = 0.10;
      system.maxEmitPower = 0.34;
      system.direction1 = new Vector3(-0.14, 0.005, -0.14);
      system.direction2 = new Vector3( 0.14, 0.03,   0.14);
      system.gravity = Vector3.Zero();
      system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      system.updateSpeed = 0.016;
      system.emitRate = 50 + layer * 8;
      system.start();

      this.cloudSystems.push({
        system,
        emitter: system.emitter as Vector3,
        baseEmitter: center,
        driftScale: 0.16 + layer * 0.05,
        layer,
      });
    });

    scene.registerBeforeRender(() => {
      const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
      this.tick(dt);
    });

    this.initialized = true;
  }

  updateWeather(weather: Weather): void {
    this.targetCloudiness = Math.max(0, Math.min(1, weather.cloudiness));
    if (weather.precipitation === 'storm') this.precipStrength = 1.0;
    else if (weather.precipitation === 'rain') this.precipStrength = 0.72;
    else if (weather.precipitation === 'drizzle') this.precipStrength = 0.40;
    else this.precipStrength = 0;
    const bearingRad = ((weather.wind.fromBearingDeg + 180) % 360) * Math.PI / 180;
    this.windX = Math.sin(bearingRad);
    this.windZ = Math.cos(bearingRad);
    this.windSpeed = Math.max(2, weather.wind.speed);
  }

  dispose(): void {
    for (const { system } of this.cloudSystems) system.dispose();
    this.cloudSystems = [];
    this.texture?.dispose();
    this.texture = null;
    this.initialized = false;
  }

  private tick(dt: number): void {
    this.elapsed += dt;
    this.cloudiness += (this.targetCloudiness - this.cloudiness) * Math.min(1, dt * 0.70);

    const density = Math.max(0, Math.min(1, this.cloudiness * 0.78 + this.precipStrength * 0.36));
    const overcast = Math.max(0, Math.min(1, this.cloudiness * 0.65 + this.precipStrength * 0.55));
    const camera = this.sceneService.camera;
    const camX = camera?.position.x ?? 0;
    const camZ = camera?.position.z ?? 0;

    const drift = this.windSpeed * dt * 6.0;
    for (const cloud of this.cloudSystems) {
      cloud.emitter.x += this.windX * drift * cloud.driftScale;
      cloud.emitter.z += this.windZ * drift * cloud.driftScale;
      const layerDip = cloud.layer * 120 + this.precipStrength * 240;
      cloud.emitter.y = cloud.baseEmitter.y - layerDip + Math.sin(this.elapsed * 0.12 + cloud.baseEmitter.x * 0.0001) * 95;

      // Keep cloud banks around the active camera so coverage remains dense everywhere.
      if (cloud.emitter.x - camX > this.CLOUD_WRAP_RANGE) cloud.emitter.x -= this.CLOUD_SPAN;
      if (camX - cloud.emitter.x > this.CLOUD_WRAP_RANGE) cloud.emitter.x += this.CLOUD_SPAN;
      if (cloud.emitter.z - camZ > this.CLOUD_WRAP_RANGE) cloud.emitter.z -= this.CLOUD_SPAN;
      if (camZ - cloud.emitter.z > this.CLOUD_WRAP_RANGE) cloud.emitter.z += this.CLOUD_SPAN;

      const layerBoost = cloud.layer === 0 ? 1.24 : cloud.layer === 1 ? 1.0 : 0.82;
      cloud.system.emitRate = (30 + density * 250) * layerBoost;

      const shade = 1.0 - (overcast * 0.22 + this.precipStrength * 0.10);
      const alphaA = 0.28 + density * 0.58;
      const alphaB = 0.16 + density * 0.42;
      cloud.system.color1 = new Color4(0.96 * shade, 0.97 * shade, 1.00 * shade, alphaA);
      cloud.system.color2 = new Color4(0.86 * shade, 0.90 * shade, 0.96 * shade, alphaB);
    }
  }

  private buildCloudTexture(scene: Scene): DynamicTexture {
    const size = 128;
    const texture = new DynamicTexture('cloudPuffTex', { width: size, height: size }, scene, false);
    texture.hasAlpha = true;
    const ctx = texture.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const grd = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    grd.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    grd.addColorStop(0.34, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.68, 'rgba(245,248,255,0.32)');
    grd.addColorStop(1.0, 'rgba(240,245,255,0.0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    texture.update();
    return texture;
  }
}