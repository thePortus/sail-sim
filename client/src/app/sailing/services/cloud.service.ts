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
};

@Injectable({ providedIn: 'root' })
export class CloudService {
  private sceneService = inject(SceneService);

  private texture: DynamicTexture | null = null;
  private cloudSystems: CloudSystem[] = [];
  private cloudiness = 0.2;
  private targetCloudiness = 0.2;
  private windX = 0;
  private windZ = 1;
  private windSpeed = 8;
  private elapsed = 0;
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    const scene = this.sceneService.scene;
    if (!scene) return;

    this.texture = this.buildCloudTexture(scene);

    const centers = [
      new Vector3(-9000, 2200, -8000),
      new Vector3( 7000, 2000, -6000),
      new Vector3(-5000, 2400,  5000),
      new Vector3( 9000, 2100,  7000),
      new Vector3(-2000, 1900, 12000),
      new Vector3(12000, 2300, -1500),
    ];

    centers.forEach((center, index) => {
      const system = new ParticleSystem(`cloud_ps_${index}`, 220, scene);
      system.particleTexture = this.texture!;
      system.emitter = center.clone();
      system.minEmitBox = new Vector3(-1400, -180, -1400);
      system.maxEmitBox = new Vector3( 1400,  180,  1400);
      system.color1 = new Color4(1.0, 1.0, 1.0, 0.78);
      system.color2 = new Color4(0.96, 0.98, 1.0, 0.56);
      system.colorDead = new Color4(1.0, 1.0, 1.0, 0.0);
      system.minSize = 24;
      system.maxSize = 86;
      system.minLifeTime = 18;
      system.maxLifeTime = 45;
      system.minEmitPower = 0.10;
      system.maxEmitPower = 0.40;
      system.direction1 = new Vector3(-0.2, 0.01, -0.2);
      system.direction2 = new Vector3( 0.2, 0.05,  0.2);
      system.gravity = Vector3.Zero();
      system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      system.updateSpeed = 0.016;
      system.emitRate = 28 + index * 2;
      system.start();

      this.cloudSystems.push({
        system,
        emitter: system.emitter as Vector3,
        baseEmitter: center,
        driftScale: 0.18 + index * 0.03,
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
    this.cloudiness += (this.targetCloudiness - this.cloudiness) * Math.min(1, dt * 0.55);

    const drift = this.windSpeed * dt * 6.0;
    for (const cloud of this.cloudSystems) {
      cloud.emitter.x += this.windX * drift * cloud.driftScale;
      cloud.emitter.z += this.windZ * drift * cloud.driftScale;
      cloud.emitter.y = cloud.baseEmitter.y + Math.sin(this.elapsed * 0.12 + cloud.baseEmitter.x * 0.0001) * 80;

      if (cloud.emitter.x > 26000) cloud.emitter.x = -26000;
      if (cloud.emitter.x < -26000) cloud.emitter.x = 26000;
      if (cloud.emitter.z > 26000) cloud.emitter.z = -26000;
      if (cloud.emitter.z < -26000) cloud.emitter.z = 26000;

      cloud.system.emitRate = 8 + this.cloudiness * 55;
      const vis = Math.max(0, (this.cloudiness - 0.03) / 0.97);
      cloud.system.color1 = new Color4(1.0, 1.0, 1.0, 0.40 + vis * 0.42);
      cloud.system.color2 = new Color4(0.96, 0.98, 1.0, 0.24 + vis * 0.28);
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