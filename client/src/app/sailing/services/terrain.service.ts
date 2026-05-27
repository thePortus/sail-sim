import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  Mesh,
  MeshBuilder,
  VertexBuffer,
  Color3,
  Color4,
  Texture,
  DynamicTexture,
  StandardMaterial,
  TransformNode,
  Quaternion,
  Scene,
  InstancedMesh,
  DirectionalLight,
} from '@babylonjs/core';
import { Settings } from '../../app.settings';
import { TerrainManifest, TerrainWorldBounds } from '../models';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { createSpsTreeArchetype } from '../utils/sps-tree-generator';

type TreePatch = {
  root: TransformNode;
  centerX: number;
  centerZ: number;
  density: number;
  count: number;
};

@Injectable({ providedIn: 'root' })
export class TerrainService {
  private readonly CHUNK_CONCURRENCY = 8;
  private readonly CHUNK_RETRIES = 2;
  private http = inject(HttpClient);
  private sceneService = inject(SceneService);
  private oceanService = inject(OceanService);

  private manifest: TerrainManifest | null = null;
  private heightfield: Uint16Array | null = null;
  private terrainMesh: Mesh | null = null;
  private terrainMaterial: StandardMaterial | null = null;
  private terrainTextures: DynamicTexture[] = [];
  private treePrototypeMeshes: Mesh[] = [];
  private treePatches: TreePatch[] = [];
  private treeInstances: InstancedMesh[] = [];
  private treeCullingObserver: any = null;
  private terrainShadowTexture: DynamicTexture | null = null;
  private terrainShadowObserver: any = null;
  private terrainShadowFrame = 0;
  private shadowQualityLevel = 2;

  private readonly TERRAIN_SHADOW_RES = 128;
  private readonly TERRAIN_SHADOW_WORLD_SIZE = 7000;
  private terrainShadowSteps = 22;
  private terrainShadowUpdateEvery = 4;

  async init(): Promise<void> {
    if (!this.manifest || !this.heightfield) {
      const manifest = await firstValueFrom(
        this.http.get<TerrainManifest>(`${Settings.apiUrl}terrain/manifest`),
      );

      this.manifest = manifest;
      this.heightfield = new Uint16Array(manifest.width * manifest.height);
      await this.loadAllChunks();
    }

    this.buildTerrainMesh();
  }

  isReady(): boolean {
    return !!this.manifest && !!this.heightfield;
  }

  dispose(): void {
    this.disposeFoliage();
    if (this.terrainShadowObserver) {
      this.sceneService.scene.onBeforeRenderObservable.remove(this.terrainShadowObserver);
      this.terrainShadowObserver = null;
    }
    this.terrainShadowTexture?.dispose();
    this.terrainShadowTexture = null;
    this.terrainMesh?.dispose();
    this.terrainMesh = null;
    this.terrainMaterial?.dispose();
    this.terrainMaterial = null;
    for (const texture of this.terrainTextures) {
      texture.dispose();
    }
    this.terrainTextures = [];
  }

  getManifest(): TerrainManifest | null {
    return this.manifest;
  }

  getWorldBounds(): TerrainWorldBounds {
    return this.manifest?.worldBounds ?? {
      minX: -25000,
      maxX: 25000,
      minZ: -25000,
      maxZ: 25000,
    };
  }

  getElevation(worldX: number, worldZ: number): number {
    if (!this.manifest || !this.heightfield) return 0;

    const { width, height, worldBounds, quantizationLevels, targetPeakElevation } = this.manifest;
    const px = ((worldX - worldBounds.minX) / (worldBounds.maxX - worldBounds.minX)) * (width - 1);
    const pz = ((worldBounds.maxZ - worldZ) / (worldBounds.maxZ - worldBounds.minZ)) * (height - 1);

    const x0 = Math.floor(px);
    const z0 = Math.floor(pz);
    const x1 = Math.min(width - 1, x0 + 1);
    const z1 = Math.min(height - 1, z0 + 1);

    const tx = px - x0;
    const tz = pz - z0;

    const h00 = this.sampleQuantized(x0, z0);
    const h10 = this.sampleQuantized(x1, z0);
    const h01 = this.sampleQuantized(x0, z1);
    const h11 = this.sampleQuantized(x1, z1);

    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    const hq = h0 + (h1 - h0) * tz;

    return (hq / quantizationLevels) * targetPeakElevation;
  }

  isOnLand(worldX: number, worldZ: number): boolean {
    return this.getElevation(worldX, worldZ) > 0.02;
  }

  nearestSpawn(worldX: number, worldZ: number): { spawnX: number; spawnZ: number; heading: number } {
    const manifest = this.manifest;
    if (!manifest || !manifest.spawns.length) {
      return { spawnX: 0, spawnZ: 0, heading: 270 };
    }

    let best = manifest.spawns[0];
    let bestDist = Infinity;
    for (const s of manifest.spawns) {
      const dx = worldX - s.x;
      const dz = worldZ - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist) {
        bestDist = d2;
        best = s;
      }
    }

    if (!this.isOnLand(best.x, best.z)) {
      return { spawnX: best.x, spawnZ: best.z, heading: best.heading };
    }

    // Spawn points from content can drift onto land as terrain evolves.
    // Search concentric rings for nearest navigable water.
    const maxRadius = 2000;
    const radiusStep = 60;
    const angles = 48;

    for (let radius = radiusStep; radius <= maxRadius; radius += radiusStep) {
      for (let i = 0; i < angles; i++) {
        const a = (i / angles) * Math.PI * 2;
        const x = best.x + Math.cos(a) * radius;
        const z = best.z + Math.sin(a) * radius;
        if (this.isOnLand(x, z)) continue;

        const heading = (Math.atan2(best.x - x, best.z - z) * 180 / Math.PI + 360) % 360;
        return { spawnX: x, spawnZ: z, heading };
      }
    }

    return { spawnX: best.x, spawnZ: best.z, heading: best.heading };
  }

  private buildTerrainMesh(): void {
    const scene = this.sceneService.scene;
    const manifest = this.manifest;
    if (!scene || !manifest || !this.heightfield) return;

    if (this.terrainMesh) {
      this.terrainMesh.dispose();
      this.terrainMesh = null;
    }
    this.disposeFoliage();

    const worldWidth = manifest.worldBounds.maxX - manifest.worldBounds.minX;
    const worldDepth = manifest.worldBounds.maxZ - manifest.worldBounds.minZ;
    const centerX = (manifest.worldBounds.minX + manifest.worldBounds.maxX) * 0.5;
    const centerZ = (manifest.worldBounds.minZ + manifest.worldBounds.maxZ) * 0.5;
    const subdivisions = Math.max(
      420,
      Math.min(640, Math.floor(Math.max(manifest.width, manifest.height) * 0.42)),
    );

    const mesh = MeshBuilder.CreateGround('terrain_heightfield', {
      width: worldWidth,
      height: worldDepth,
      subdivisions,
      updatable: true,
    }, scene);
    mesh.position.set(centerX, 0, centerZ);
    mesh.renderingGroupId = 2;

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const numVerts = (subdivisions + 1) * (subdivisions + 1);
    const colors: number[] = [];

    for (let i = 0; i < numVerts; i++) {
      const localX = positions[i * 3];
      const localZ = positions[i * 3 + 2];
      const wx = centerX + localX;
      const wz = centerZ + localZ;

      const elevation = this.getElevation(wx, wz);
      const y = elevation > 0 ? elevation : -2.2;
      positions[i * 3 + 1] = y;

      if (elevation <= 0) {
        colors.push(0.06, 0.14, 0.28, 1.0);
      } else {
        const t = elevation / manifest.targetPeakElevation;
        let r = 0.18;
        let g = 0.35;
        let b = 0.14;

        if (t < 0.03) {
          r = 0.78; g = 0.71; b = 0.54;
        } else if (t < 0.25) {
          r = 0.22; g = 0.44; b = 0.16;
        } else if (t < 0.55) {
          r = 0.34; g = 0.30; b = 0.22;
        } else if (t < 0.80) {
          r = 0.24; g = 0.21; b = 0.19;
        } else {
          r = 0.16; g = 0.14; b = 0.14;
        }
        colors.push(r, g, b, 1.0);
      }
    }

    mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors, false);
    mesh.createNormals(true);
    mesh.refreshBoundingInfo();

    const material = this.buildTerrainMaterial(scene, manifest);
    material.zOffset = 4;
    mesh.material = material;
    mesh.useVertexColors = false;

    this.oceanService.addToRenderList(mesh);
    this.sceneService.shadowGenerator?.addShadowCaster(mesh, true);
    this.sceneService.excludeFromGlow(mesh);
    mesh.receiveShadows = true;

    this.terrainMesh = mesh;
    this.buildTreeFoliage(scene, manifest);
    this.setupTerrainShadowMask(scene);
  }

  private setupTerrainShadowMask(scene: Scene): void {
    if (this.terrainShadowTexture) return;

    // Apply persisted quality before the first update runs.
    const saved = parseInt(localStorage.getItem('shadow-quality') ?? '2', 10);
    this.applyQualityLevel(saved);

    this.terrainShadowTexture = new DynamicTexture(
      'terrainShadowMask',
      { width: this.TERRAIN_SHADOW_RES, height: this.TERRAIN_SHADOW_RES },
      scene,
      false,
    );
    this.terrainShadowTexture.hasAlpha = false;

    this.updateTerrainShadowMask();
    this.terrainShadowObserver = scene.onBeforeRenderObservable.add(() => {
      this.terrainShadowFrame++;
      if (this.terrainShadowFrame % this.terrainShadowUpdateEvery !== 0) return;
      this.updateTerrainShadowMask();
    });
  }

  private updateTerrainShadowMask(): void {
    const texture = this.terrainShadowTexture;
    const camera = this.sceneService.camera;
    if (!texture || !camera || !this.manifest || !this.heightfield) return;

    const sun = this.sceneService.scene.lights.find(
      (l): l is DirectionalLight => l instanceof DirectionalLight && l.name === 'sun',
    );

    const cx = camera.position.x;
    const cz = camera.position.z;
    const size = this.TERRAIN_SHADOW_WORLD_SIZE;

    if (this.shadowQualityLevel === 0 || !sun || sun.direction.y >= -0.01) {
      const clearCtx = texture.getContext();
      clearCtx.fillStyle = 'rgb(0,0,0)';
      clearCtx.fillRect(0, 0, this.TERRAIN_SHADOW_RES, this.TERRAIN_SHADOW_RES);
      texture.update();
      this.oceanService.setTerrainShadowMask(texture, cx, cz, size, 0);
      return;
    }

    const dir = sun.direction.normalizeToNew();
    const marchX = -dir.x;
    const marchZ = -dir.z;
    const rayRisePerMeter = Math.max(0.015, -dir.y);

    const maxDistance = size * 0.80;
    const stepDistance = maxDistance / this.terrainShadowSteps;

    const res = this.TERRAIN_SHADOW_RES;
    const half = size * 0.5;
    const worldPerTexel = size / (res - 1);

    const ctx = texture.getContext();
    const imageData = ctx.getImageData(0, 0, res, res);
    const data = imageData.data;

    let ptr = 0;
    for (let py = 0; py < res; py++) {
      const wz = (cz + half) - py * worldPerTexel;
      for (let px = 0; px < res; px++) {
        const wx = (cx - half) + px * worldPerTexel;
        const ground = this.getElevation(wx, wz);

        let mask = 0;
        if (ground <= 0.2) {
          for (let s = 1; s <= this.terrainShadowSteps; s++) {
            const dist = stepDistance * s;
            const sx = wx + marchX * dist;
            const sz = wz + marchZ * dist;
            const hTerrain = this.getElevation(sx, sz);
            const hRay = rayRisePerMeter * dist;
            if (hTerrain > hRay + 2.0) {
              mask = 1;
              break;
            }
          }
        }

        const v = mask ? 255 : 0;
        data[ptr++] = v;
        data[ptr++] = v;
        data[ptr++] = v;
        data[ptr++] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    texture.update();

    const strength = Math.max(0.25, Math.min(0.9, 0.25 + (1 - Math.max(0, rayRisePerMeter)) * 0.45));
    this.oceanService.setTerrainShadowMask(texture, cx, cz, size, strength);
  }

  // ── Shadow quality ────────────────────────────────────────────────────────

  getShadowQuality(): number {
    return parseInt(localStorage.getItem('shadow-quality') ?? '2', 10);
  }

  setShadowQuality(level: number): void {
    this.applyQualityLevel(level);
    localStorage.setItem('shadow-quality', String(level));
    if (this.terrainShadowTexture) this.updateTerrainShadowMask();
  }

  private applyQualityLevel(level: number): void {
    this.shadowQualityLevel = level;
    switch (level) {
      case 0:  this.terrainShadowSteps =  1; this.terrainShadowUpdateEvery = 999; break;
      case 1:  this.terrainShadowSteps = 12; this.terrainShadowUpdateEvery =   8; break;
      case 2:  this.terrainShadowSteps = 22; this.terrainShadowUpdateEvery =   4; break;
      default: this.terrainShadowSteps = 40; this.terrainShadowUpdateEvery =   1; break;
    }
  }

  private buildTreeFoliage(scene: Scene, manifest: TerrainManifest): void {
    const bounds = manifest.worldBounds;
    const worldWidth = bounds.maxX - bounds.minX;
    const worldDepth = bounds.maxZ - bounds.minZ;

    this.treePrototypeMeshes = this.createTreeArchetypes(scene);
    for (const prototype of this.treePrototypeMeshes) {
      prototype.isVisible = false;
      prototype.position.set(0, -10000, 0);
      this.sceneService.excludeFromGlow(prototype);
    }

    const patchSize = 2300;
    const gridX = 220;
    const gridZ = 220;
    const hardCap = 12000;
    const patchMap = new Map<string, TreePatch>();
    let placed = 0;

    for (let gz = 0; gz < gridZ && placed < hardCap; gz++) {
      for (let gx = 0; gx < gridX && placed < hardCap; gx++) {
        const u = (gx + this.hashNoise(gx * 0.63 + 13.7, gz * 0.71 + 5.1) * 0.9) / gridX;
        const v = (gz + this.hashNoise(gx * 0.49 + 17.9, gz * 0.55 + 11.3) * 0.9) / gridZ;

        const wooded = this.computeWoodedScore(u, v);
        if (wooded <= 0) continue;

        const macro = this.hashNoise(u * 9.5 + 91.7, v * 9.5 + 34.1);
        const patchDensity = this.clamp01(0.1 + macro * 1.1);
        const chance = wooded * (0.09 + patchDensity * 0.64);
        const accept = this.hashNoise(u * 63.7 + 7.3, v * 63.7 + 53.2);
        if (accept > chance) continue;

        const worldX = bounds.minX + u * worldWidth;
        const worldZ = bounds.maxZ - v * worldDepth;
        const y = this.getElevation(worldX, worldZ);
        if (y <= 0.2) continue;

        const slope = this.sampleSlope(u, v);
        if (slope > 0.34) continue;

        const archetypeIndex = this.pickTreeArchetype(u, v, patchDensity);
        const prototype = this.treePrototypeMeshes[archetypeIndex];
        const instance = prototype.createInstance(`tree_${placed}`);

        const scaleRnd = this.hashNoise(worldX * 0.0017 + 2.1, worldZ * 0.0017 + 8.4);
        const scale = 0.85 + scaleRnd * 0.95;
        const yaw = this.hashNoise(worldX * 0.0021 + 101.9, worldZ * 0.0021 + 44.8) * Math.PI * 2;
        const tiltX = (this.hashNoise(worldX * 0.0039 + 19.2, worldZ * 0.0039 + 2.8) - 0.5) * slope * 0.34;
        const tiltZ = (this.hashNoise(worldX * 0.0042 + 71.1, worldZ * 0.0042 + 3.6) - 0.5) * slope * 0.34;

        instance.position.set(worldX, y, worldZ);
        instance.scaling.set(scale, scale, scale);
        instance.rotationQuaternion = Quaternion.RotationYawPitchRoll(yaw, tiltX, tiltZ);
        instance.isPickable = false;

        const patchX = Math.floor((worldX - bounds.minX) / patchSize);
        const patchZ = Math.floor((worldZ - bounds.minZ) / patchSize);
        const patchKey = `${patchX}:${patchZ}`;
        let patch = patchMap.get(patchKey);
        if (!patch) {
          patch = {
            root: new TransformNode(`tree_patch_${patchKey}`, scene),
            centerX: bounds.minX + (patchX + 0.5) * patchSize,
            centerZ: bounds.minZ + (patchZ + 0.5) * patchSize,
            density: patchDensity,
            count: 0,
          };
          patchMap.set(patchKey, patch);
          this.treePatches.push(patch);
        }

        instance.parent = patch.root;
        patch.count += 1;
        patch.density = Math.max(patch.density, patchDensity);
        this.treeInstances.push(instance);
        placed += 1;
      }
    }

    // Frustum-distance patch culling keeps medium-density forests responsive.
    this.treeCullingObserver = scene.onBeforeRenderObservable.add(() => this.updateTreePatchVisibility());
    this.updateTreePatchVisibility();
    console.log(`[Terrain] Generated ${placed} SPS trees across ${this.treePatches.length} patches.`);
  }

  private updateTreePatchVisibility(): void {
    const camera = this.sceneService.camera;
    if (!camera) return;

    const cx = camera.position.x;
    const cz = camera.position.z;

    for (const patch of this.treePatches) {
      const dx = patch.centerX - cx;
      const dz = patch.centerZ - cz;
      const dist2 = dx * dx + dz * dz;
      const cullRadius = patch.density > 0.7 ? 12500 : 9800;
      patch.root.setEnabled(dist2 <= cullRadius * cullRadius);
    }
  }

  private createTreeArchetypes(scene: Scene): Mesh[] {
    const trunkA = new Color4(0.34, 0.25, 0.16, 1);
    const trunkB = new Color4(0.29, 0.22, 0.14, 1);

    return [
      createSpsTreeArchetype('tree_oak', scene, {
        seed: 41,
        trunkHeight: 11,
        trunkRadius: 0.62,
        branchLevels: 3,
        forksPerLevel: 3,
        lengthDecay: 0.63,
        radiusDecay: 0.66,
        forkAngleMin: 0.38,
        forkAngleMax: 0.8,
        bowAmount: 0.08,
        leafClusters: 32,
        leafSizeMin: 0.55,
        leafSizeMax: 1.05,
        leafAspectMin: 0.75,
        leafAspectMax: 1.2,
        branchColor: trunkA,
        leafColor: new Color4(0.17, 0.41, 0.14, 1),
      }),
      createSpsTreeArchetype('tree_pine', scene, {
        seed: 137,
        trunkHeight: 15,
        trunkRadius: 0.42,
        branchLevels: 4,
        forksPerLevel: 2,
        lengthDecay: 0.58,
        radiusDecay: 0.64,
        forkAngleMin: 0.22,
        forkAngleMax: 0.55,
        bowAmount: 0.04,
        leafClusters: 26,
        leafSizeMin: 0.4,
        leafSizeMax: 0.72,
        leafAspectMin: 0.35,
        leafAspectMax: 0.65,
        branchColor: trunkB,
        leafColor: new Color4(0.12, 0.31, 0.12, 1),
      }),
      createSpsTreeArchetype('tree_elm', scene, {
        seed: 303,
        trunkHeight: 10,
        trunkRadius: 0.56,
        branchLevels: 3,
        forksPerLevel: 3,
        lengthDecay: 0.67,
        radiusDecay: 0.69,
        forkAngleMin: 0.45,
        forkAngleMax: 0.9,
        bowAmount: 0.1,
        leafClusters: 30,
        leafSizeMin: 0.52,
        leafSizeMax: 0.95,
        leafAspectMin: 0.8,
        leafAspectMax: 1.25,
        branchColor: trunkA,
        leafColor: new Color4(0.24, 0.47, 0.18, 1),
      }),
      createSpsTreeArchetype('tree_ash', scene, {
        seed: 509,
        trunkHeight: 13,
        trunkRadius: 0.48,
        branchLevels: 3,
        forksPerLevel: 2,
        lengthDecay: 0.65,
        radiusDecay: 0.67,
        forkAngleMin: 0.3,
        forkAngleMax: 0.72,
        bowAmount: 0.07,
        leafClusters: 28,
        leafSizeMin: 0.46,
        leafSizeMax: 0.84,
        leafAspectMin: 0.65,
        leafAspectMax: 1.05,
        branchColor: trunkB,
        leafColor: new Color4(0.19, 0.39, 0.14, 1),
      }),
      createSpsTreeArchetype('tree_spruce', scene, {
        seed: 881,
        trunkHeight: 17,
        trunkRadius: 0.36,
        branchLevels: 4,
        forksPerLevel: 2,
        lengthDecay: 0.55,
        radiusDecay: 0.6,
        forkAngleMin: 0.18,
        forkAngleMax: 0.48,
        bowAmount: 0.03,
        leafClusters: 24,
        leafSizeMin: 0.34,
        leafSizeMax: 0.64,
        leafAspectMin: 0.25,
        leafAspectMax: 0.58,
        branchColor: trunkB,
        leafColor: new Color4(0.1, 0.25, 0.11, 1),
      }),
    ];
  }

  private pickTreeArchetype(u: number, v: number, patchDensity: number): number {
    const n = this.hashNoise(u * 17.1 + patchDensity * 3.2, v * 17.1 + patchDensity * 5.4);
    if (patchDensity > 0.75) return n < 0.58 ? 1 : n < 0.86 ? 4 : 3;
    if (patchDensity < 0.35) return n < 0.5 ? 0 : n < 0.8 ? 2 : 3;
    if (n < 0.22) return 0;
    if (n < 0.44) return 1;
    if (n < 0.64) return 2;
    if (n < 0.84) return 3;
    return 4;
  }

  private computeWoodedScore(u: number, v: number): number {
    const h = this.sampleNormalizedHeight(u, v);
    const slope = this.sampleSlope(u, v);

    if (h < 0.05 || h > 0.62) return 0;
    if (slope > 0.36) return 0;

    const beachFade = this.clamp01((h - 0.05) / 0.08);
    const alpineFade = this.clamp01((0.62 - h) / 0.2);
    const slopeFade = this.clamp01((0.36 - slope) / 0.2);
    const meadowBand = Math.exp(-Math.pow((h - 0.22) / 0.16, 2));

    return this.clamp01(beachFade * alpineFade * slopeFade * (0.35 + 0.65 * meadowBand));
  }

  private disposeFoliage(): void {
    if (this.treeCullingObserver && this.sceneService.scene) {
      this.sceneService.scene.onBeforeRenderObservable.remove(this.treeCullingObserver);
      this.treeCullingObserver = null;
    }

    for (const instance of this.treeInstances) {
      instance.dispose();
    }
    this.treeInstances = [];

    for (const patch of this.treePatches) {
      patch.root.dispose();
    }
    this.treePatches = [];

    for (const prototype of this.treePrototypeMeshes) {
      prototype.dispose();
    }
    this.treePrototypeMeshes = [];
  }

  private buildTerrainMaterial(scene: any, manifest: TerrainManifest): StandardMaterial {
    this.terrainMaterial?.dispose();
    this.terrainMaterial = null;
    for (const texture of this.terrainTextures) {
      texture.dispose();
    }
    this.terrainTextures = [];

    const { albedoTexture } = this.createTerrainTextures(scene, manifest);
    this.terrainTextures.push(albedoTexture);

    const material = new StandardMaterial('terrain_mat', scene);
    material.diffuseTexture = albedoTexture;
    material.specularColor = new Color3(0.02, 0.02, 0.02);
    material.emissiveColor = Color3.Black();
    material.disableLighting = false;

    this.terrainMaterial = material;
    return material;
  }

  private createTerrainTextures(scene: any, manifest: TerrainManifest): {
    albedoTexture: DynamicTexture;
  } {
    const size = 1024;
    const albedoTexture = new DynamicTexture('terrain_albedo_texture', { width: size, height: size }, scene, true, Texture.LINEAR_LINEAR_MIPLINEAR, undefined, false);

    albedoTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    albedoTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.paintTerrainAlbedoTexture(albedoTexture, manifest);

    return { albedoTexture };
  }

  private paintTerrainAlbedoTexture(texture: DynamicTexture, manifest: TerrainManifest): void {
    const context = texture.getContext();
    const width = 1024;
    const height = 1024;
    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    const peak = Math.max(1, manifest.targetPeakElevation);

    for (let y = 0; y < height; y++) {
      const v = y / (height - 1);
      for (let x = 0; x < width; x++) {
        const u = x / (width - 1);
        const hMeters = this.sampleElevationMeters(u, v);
        const h = this.clamp01(hMeters / peak);
        const slope = this.sampleSlope(u, v);

        const macroA = this.hashNoise(u * manifest.width * 0.22, v * manifest.height * 0.22);
        const macroB = this.hashNoise(u * manifest.width * 0.61 + 11.3, v * manifest.height * 0.61 + 7.9);
        const micro = this.hashNoise(u * manifest.width * 4.4 + 31.7, v * manifest.height * 4.4 + 19.1);
        const strata = Math.sin(h * 72.0 + macroA * 8.0) * 0.5 + 0.5;

        let sandW = this.clamp01(1.0 - h / 0.085) * this.clamp01(1.0 - slope * 1.25);
        let grassW = this.clamp01((h - 0.035) / 0.28) * this.clamp01(1.0 - slope * 0.95);
        let soilW = this.clamp01((h - 0.10) / 0.35) * this.clamp01(1.0 - slope * 0.42);
        let gravelW = this.clamp01((h - 0.20) / 0.52) * this.clamp01(0.25 + slope * 1.5);
        let rockW = this.clamp01((h - 0.34) / 0.54) * this.clamp01(0.22 + slope * 1.7);
        let snowW = this.clamp01((h - 0.68) / 0.22) * this.clamp01(1.0 - slope * 0.55);

        grassW *= 0.78 + macroA * 0.44;
        soilW *= 0.74 + macroB * 0.52;
        gravelW *= 0.68 + micro * 0.64;
        rockW *= 0.72 + strata * 0.48;
        snowW *= 0.70 + macroB * 0.38;

        const total = Math.max(0.0001, sandW + grassW + soilW + gravelW + rockW + snowW);
        sandW /= total;
        grassW /= total;
        soilW /= total;
        gravelW /= total;
        rockW /= total;
        snowW /= total;

        const sand = [0.78, 0.73, 0.62];
        const grass = [0.23, 0.43, 0.19];
        const soil = [0.40, 0.31, 0.23];
        const gravel = [0.47, 0.44, 0.39];
        const rock = [0.33, 0.33, 0.35];
        const snow = [0.88, 0.89, 0.90];

        const tonal = 0.86 + strata * 0.18 + (micro - 0.5) * 0.12;

        const r = this.clamp01((sand[0] * sandW + grass[0] * grassW + soil[0] * soilW + gravel[0] * gravelW + rock[0] * rockW + snow[0] * snowW) * tonal);
        const g = this.clamp01((sand[1] * sandW + grass[1] * grassW + soil[1] * soilW + gravel[1] * gravelW + rock[1] * rockW + snow[1] * snowW) * tonal);
        const b = this.clamp01((sand[2] * sandW + grass[2] * grassW + soil[2] * soilW + gravel[2] * gravelW + rock[2] * rockW + snow[2] * snowW) * tonal);

        const offset = (y * width + x) * 4;
        data[offset] = Math.round(r * 255);
        data[offset + 1] = Math.round(g * 255);
        data[offset + 2] = Math.round(b * 255);
        data[offset + 3] = 255;
      }
    }

    context.putImageData(imageData, 0, 0);
    texture.update(false);
  }

  private sampleElevationMeters(u: number, v: number): number {
    const manifest = this.manifest;
    const heightfield = this.heightfield;
    if (!manifest || !heightfield) return 0;

    const px = u * (manifest.width - 1);
    const pz = v * (manifest.height - 1);

    const x0 = Math.floor(px);
    const z0 = Math.floor(pz);
    const x1 = Math.min(manifest.width - 1, x0 + 1);
    const z1 = Math.min(manifest.height - 1, z0 + 1);

    const tx = px - x0;
    const tz = pz - z0;

    const h00 = this.sampleQuantized(x0, z0);
    const h10 = this.sampleQuantized(x1, z0);
    const h01 = this.sampleQuantized(x0, z1);
    const h11 = this.sampleQuantized(x1, z1);

    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    const hq = h0 + (h1 - h0) * tz;

    return (hq / manifest.quantizationLevels) * manifest.targetPeakElevation;
  }

  private sampleNormalizedHeight(u: number, v: number): number {
    const manifest = this.manifest;
    if (!manifest) return 0;
    return this.sampleElevationMeters(u, v) / Math.max(1, manifest.targetPeakElevation);
  }

  private sampleSlope(u: number, v: number): number {
    const manifest = this.manifest;
    if (!manifest) return 0;

    const du = 1 / Math.max(64, manifest.width - 1);
    const dv = 1 / Math.max(64, manifest.height - 1);
    const center = this.sampleNormalizedHeight(u, v);
    const dx = Math.abs(this.sampleNormalizedHeight(this.clamp01(u + du), v) - this.sampleNormalizedHeight(this.clamp01(u - du), v));
    const dz = Math.abs(this.sampleNormalizedHeight(u, this.clamp01(v + dv)) - this.sampleNormalizedHeight(u, this.clamp01(v - dv)));
    return this.clamp01(center * 0.08 + (dx + dz) * 2.6);
  }

  private hashNoise(x: number, y: number): number {
    const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return value - Math.floor(value);
  }

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private async loadAllChunks(): Promise<void> {
    const manifest = this.manifest;
    const heightfield = this.heightfield;
    if (!manifest || !heightfield) return;

    const jobs: Array<{ cz: number; cx: number }> = [];
    for (let cz = 0; cz < manifest.chunkCountZ; cz++) {
      for (let cx = 0; cx < manifest.chunkCountX; cx++) {
        jobs.push({ cz, cx });
      }
    }

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(this.CHUNK_CONCURRENCY, jobs.length) }, async () => {
      while (nextIndex < jobs.length) {
        const job = jobs[nextIndex++];
        await this.loadChunkWithRetry(job.cz, job.cx);
      }
    });

    await Promise.all(workers);
  }

  private async loadChunkWithRetry(cz: number, cx: number): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.CHUNK_RETRIES; attempt++) {
      try {
        await this.loadChunk(cz, cx);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === this.CHUNK_RETRIES) break;
        await this.delay(120 * (attempt + 1));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to load terrain chunk ${cz}/${cx}`);
  }

  private async loadChunk(cz: number, cx: number): Promise<void> {
    const manifest = this.manifest;
    const heightfield = this.heightfield;
    if (!manifest || !heightfield) return;

    const data = await firstValueFrom(
      this.http.get(`${Settings.apiUrl}terrain/chunk/${cz}/${cx}`, {
        responseType: 'arraybuffer',
      }),
    );

    const x0 = cx * manifest.chunkSize;
    const z0 = cz * manifest.chunkSize;
    const chunkW = Math.min(manifest.chunkSize, manifest.width - x0);
    const chunkH = Math.min(manifest.chunkSize, manifest.height - z0);

    const view = new DataView(data);
    let offset = 0;

    for (let z = 0; z < chunkH; z++) {
      for (let x = 0; x < chunkW; x++) {
        const q = view.getUint16(offset, true);
        offset += 2;
        const dstIdx = (z0 + z) * manifest.width + (x0 + x);
        heightfield[dstIdx] = q;
      }
    }
  }

  private sampleQuantized(px: number, pz: number): number {
    const manifest = this.manifest;
    const heightfield = this.heightfield;
    if (!manifest || !heightfield) return 0;

    const x = Math.max(0, Math.min(manifest.width - 1, px));
    const z = Math.max(0, Math.min(manifest.height - 1, pz));
    return heightfield[z * manifest.width + x];
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }
}
