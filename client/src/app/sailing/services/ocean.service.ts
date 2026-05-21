import { Injectable, inject } from '@angular/core';
import { MeshBuilder, Vector2, Mesh, Texture, Color3 } from '@babylonjs/core';
import { WaterMaterial } from '@babylonjs/materials';
import { SceneService } from './scene.service';
import { SeaConditions, Wind } from '../models';

@Injectable({ providedIn: 'root' })
export class OceanService {
  private sceneService = inject(SceneService);

  private waterMat!: WaterMaterial;
  private oceanMesh!: Mesh;

  init(): void {
    const { scene } = this.sceneService;

    // More subdivisions give smoother vertex-displacement wave geometry.
    this.oceanMesh = MeshBuilder.CreateGround('ocean', {
      width:        200000,
      height:       200000,
      subdivisions: 96,
    }, scene);

    this.waterMat = new WaterMaterial('waterMat', scene, new Vector2(1024, 1024));
    this.waterMat.backFaceCulling  = true;

    // Bump texture drives the normal map that makes the surface look detailed.
    // bumpHeight is the key lever: higher = more visible micro-ripple texture.
    this.waterMat.bumpTexture      = new Texture('https://playground.babylonjs.com/textures/waterbump.png', scene);
    this.waterMat.windForce        = -12;
    this.waterMat.waveHeight       = 0.4;
    this.waterMat.bumpHeight       = 2.8;     // was 0.35 — much more surface detail
    this.waterMat.waveLength       = 0.06;    // shorter wavelength = more visible ripple tiling
    this.waterMat.colorBlendFactor = 0.12;
    this.waterMat.waterColor       = new Color3(0.04, 0.16, 0.30);
    this.waterMat.waterColor2      = new Color3(0.06, 0.20, 0.38);

    // Register sky for reflections / refractions
    const skyMesh = this.sceneService.getSkyMesh();
    if (skyMesh) this.waterMat.addToRenderList(skyMesh);

    this.oceanMesh.material = this.waterMat;
  }

  /** Called each time weather updates — makes sea react to wind/storm. */
  updateWeather(wind: Wind, sea: SeaConditions): void {
    if (!this.waterMat) return;

    // waveHeight capped so the boat never sinks below the surface geometry.
    this.waterMat.waveHeight  = Math.min(0.5, 0.08 + sea.choppiness * 0.38);
    this.waterMat.windForce   = -(6 + wind.speed * 0.35);
    // Shorter waveLength in storms = choppier high-frequency ripple detail.
    this.waterMat.waveLength  = Math.max(0.03, 0.07 - sea.choppiness * 0.03);
    // bumpHeight is the main driver of visible surface texture.
    // Calm: 2.2 (gentle micro-ripples), Storm: 5.5 (dramatically textured surface).
    this.waterMat.bumpHeight  = 2.2 + sea.choppiness * 3.3;
    this.waterMat.windDirection = new Vector2(wind.x / wind.speed, wind.z / wind.speed);
  }

  /** Expose ocean mesh so island service can add it to water reflection list. */
  addToRenderList(mesh: any): void {
    this.waterMat?.addToRenderList(mesh);
  }

  getOceanMesh(): Mesh {
    return this.oceanMesh;
  }
}
