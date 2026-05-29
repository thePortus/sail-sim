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
  TransformNode,
  Quaternion,
  Scene,
  InstancedMesh,
  DirectionalLight,
} from '@babylonjs/core';
import { CustomMaterial } from '@babylonjs/materials';
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

  // Computed once after chunk load; drives beach grading + underwater depth.
  // distToLand[i] = heightfield cells from water cell i to nearest land cell.
  // depthLUT[d]   = seabed Y (metres) at d cells from shore.
  private coastData: {
    distToLand: Uint16Array;
    cellSizeM:  number;
    depthLUT:   Float32Array;
    harbors:    Array<{ x: number; z: number; score: number }>;
  } | null = null;
  private terrainMesh: Mesh | null = null;
  private terrainMaterial: CustomMaterial | null = null;
  private terrainTextures: Texture[] = [];
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

  // Shore proximity map: camera-centred 128×128 texture whose R channel
  // stores "how close this water pixel is to the nearest land" (0=open ocean,
  // 1=waterline).  Updated in two fast passes — see updateShoreMap().
  private shoreMapTexture: DynamicTexture | null = null;
  private shoreMapObserver: any = null;
  private shoreMapFrame = 0;
  private readonly SHORE_MAP_RES = 128;          // 128×128 → ~15 m/texel at 2000 m
  private readonly SHORE_MAP_WORLD_SIZE = 2000;  // ±1000 m — tighter = finer texels

  async init(): Promise<void> {
    if (!this.manifest || !this.heightfield) {
      const manifest = await firstValueFrom(
        this.http.get<TerrainManifest>(`${Settings.apiUrl}terrain/manifest`),
      );

      this.manifest = manifest;
      this.heightfield = new Uint16Array(manifest.width * manifest.height);
      await this.loadAllChunks();
      // Grade beaches and compute coastal distance data while heightfield
      // is still fresh.  Must run before buildTerrainMesh so that
      // getElevation(), tree placement, and the mesh all see consistent values.
      this.coastData = this.applyCoastalGrading();
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
    if (this.shoreMapObserver) {
      this.sceneService.scene.onBeforeRenderObservable.remove(this.shoreMapObserver);
      this.shoreMapObserver = null;
    }
    this.shoreMapTexture?.dispose();
    this.shoreMapTexture = null;
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
    // Cap at 1500 → ~33 m/polygon at 50 km.  The 0.42 multiplier always
    // exceeds the cap for any source ≥ 3600 px, so the cap is the only knob.
    // 1500×1500 ≈ 4.5 M triangles — good balance of quality and GPU cost.
    // Raising to 2000 (8 M triangles) halved framerate on mid-range hardware;
    // the normal-map micro-detail compensates visually.
    const subdivisions = Math.max(
      420,
      Math.min(1500, Math.floor(Math.max(manifest.width, manifest.height) * 0.42)),
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
    const numVerts   = (subdivisions + 1) * (subdivisions + 1);
    const gridW      = subdivisions + 1;
    const colors: number[] = [];

    // ── Pass 1: sample heightfield → raw vertex Y values ─────────────────────
    // underwaterY[i] stores the seabed depth (≤ 0) for ocean vertices,
    // pre-computed here so the smoothing write-back can reuse it cheaply.
    const rawY       = new Float32Array(numVerts);
    const underwaterY = new Float32Array(numVerts);
    for (let i = 0; i < numVerts; i++) {
      const wx = centerX + positions[i * 3];
      const wz = centerZ + positions[i * 3 + 2];
      rawY[i] = this.getElevation(wx, wz);
      if (rawY[i] > 0) {
        positions[i * 3 + 1] = rawY[i];
      } else {
        underwaterY[i]        = this.sampleUnderwaterDepth(wx, wz);
        positions[i * 3 + 1] = underwaterY[i];
      }
    }

    // ── Pass 2: Iterative Gaussian 3×3 smoothing on land heights ─────────────
    // Three consecutive passes of the 1-2-1 kernel are equivalent to a single
    // ~7-wide Gaussian — enough to round off coarse polygon steps on hillsides
    // and cliffs without flattening genuine peaks.
    // Ocean-floor vertices (y ≤ 0) are held fixed throughout and excluded from
    // neighbour averages so the waterline is never dragged downward.
    //
    // BEACH PROTECTION: any land vertex whose rawY sits in the coastal-grading
    // zone (0 < rawY ≤ BEACH_H_M) must never be raised by smoothing.  Without
    // this guard, mountain neighbours at 200–500 m pull the 5 m beach cells up
    // to 200–400 m after three passes, putting them in the rock biome and
    // hiding the sandy texture entirely.  The clamp below preserves the beach
    // profile while still letting the kernel round off genuine cliffs.
    const SMOOTH_PASSES = 3;
    const BEACH_H_M = 5.0;   // must match applyCoastalGrading BEACH_H
    // Work on a copy so rawY stays intact for biome colour sampling below.
    let currentY = rawY.slice();
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      const nextY = new Float32Array(numVerts);
      for (let gz = 0; gz < gridW; gz++) {
        for (let gx = 0; gx < gridW; gx++) {
          const ci = gz * gridW + gx;
          const cy = currentY[ci];
          if (cy <= 0) { nextY[ci] = cy; continue; }   // keep ocean fixed

          let sum = 0, wt = 0;
          for (let dz = -1; dz <= 1; dz++) {
            const nz = gz + dz;
            if (nz < 0 || nz >= gridW) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = gx + dx;
              if (nx < 0 || nx >= gridW) continue;
              const ny = currentY[nz * gridW + nx];
              if (ny <= 0) continue;                    // don't blend in ocean
              const w = (2 - Math.abs(dx)) * (2 - Math.abs(dz)); // 1-2-1 kernel
              sum += ny * w;
              wt  += w;
            }
          }
          const smoothed = wt > 0 ? sum / wt : cy;
          // Beach cells: smoothing may only lower (blend out polygon steps toward
          // water), never raise.  Mountain neighbours must not contaminate them.
          nextY[ci] = (rawY[ci] > 0 && rawY[ci] <= BEACH_H_M)
            ? Math.min(rawY[ci], smoothed)
            : smoothed;
        }
      }
      currentY = nextY;
    }

    // Write smoothed Y back and build vertex colours (colours use rawY so
    // biome bands stay aligned with the source heightfield, not the smoothed mesh).
    // Ocean vertices use the pre-computed exponential depth rather than a flat plane.
    for (let i = 0; i < numVerts; i++) {
      positions[i * 3 + 1] = currentY[i] > 0 ? currentY[i] : underwaterY[i];
    }

    for (let i = 0; i < numVerts; i++) {
      const elev = rawY[i];
      if (elev <= 0) {
        colors.push(0.06, 0.14, 0.28, 1.0);
      } else {
        const t = elev / manifest.targetPeakElevation;
        let r = 0.18, g = 0.35, b = 0.14;
        if      (t < 0.03) { r = 0.78; g = 0.71; b = 0.54; }
        else if (t < 0.25) { r = 0.22; g = 0.44; b = 0.16; }
        else if (t < 0.55) { r = 0.34; g = 0.30; b = 0.22; }
        else if (t < 0.80) { r = 0.24; g = 0.21; b = 0.19; }
        else               { r = 0.16; g = 0.14; b = 0.14; }
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
    // NOTE: the terrain is intentionally NOT added as a shadow caster. At this
    // world scale the far shadow cascades have huge texels, so the terrain
    // shadowing itself produced moving diagonal moiré (self-shadow acne) on
    // steep slopes, worst at noon. Leaving it out of the shadow map means it can
    // never self-shadow. It still RECEIVES shadows (trees, boat) via
    // receiveShadows below, and large-scale terrain shadows are handled by the
    // dedicated raymarched terrainShadowMask system.
    this.sceneService.excludeFromGlow(mesh);
    mesh.receiveShadows = true;

    this.terrainMesh = mesh;
    // Let the scene occlude the sun against our heightfield (stops the sun disk
    // shining through mountains at dawn/dusk).
    this.sceneService.setTerrainHeightSampler((x, z) => this.getElevation(x, z));
    this.buildTreeFoliage(scene, manifest);
    this.setupTerrainShadowMask(scene);
    this.setupShoreMap(scene);
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

  // ── Shore elevation map ───────────────────────────────────────────────────

  private setupShoreMap(scene: Scene): void {
    if (this.shoreMapTexture) return;

    this.shoreMapTexture = new DynamicTexture(
      'shoreElevationMap',
      { width: this.SHORE_MAP_RES, height: this.SHORE_MAP_RES },
      scene,
      false,
    );
    this.shoreMapTexture.hasAlpha = false;

    this.updateShoreMap();

    // Update every 10 frames (~167 ms at 60 fps).  The two-pass optimisation
    // makes each run < 5 ms, so more frequent ticks keep the map smooth.
    this.shoreMapObserver = scene.onBeforeRenderObservable.add(() => {
      this.shoreMapFrame++;
      if (this.shoreMapFrame % 10 !== 0) return;
      this.updateShoreMap();
    });
  }

  // Returns true if the raw heightfield cell nearest to (wx, wz) is land.
  // Uses nearest-neighbour sampling (one Uint16Array read, zero interpolation)
  // — ~8× faster than getElevation().  Ocean pixels are stored as exactly 0
  // in the quantized heightfield so a simple "> 0" check is reliable.
  private isLandRaw(wx: number, wz: number): boolean {
    const m  = this.manifest!;
    const hf = this.heightfield!;
    const px = Math.round(((wx - m.worldBounds.minX) / (m.worldBounds.maxX - m.worldBounds.minX)) * (m.width  - 1));
    const pz = Math.round(((m.worldBounds.maxZ - wz)  / (m.worldBounds.maxZ - m.worldBounds.minZ)) * (m.height - 1));
    return hf[Math.max(0, Math.min(m.height - 1, pz)) * m.width + Math.max(0, Math.min(m.width - 1, px))] > 0;
  }

  private updateShoreMap(): void {
    const texture = this.shoreMapTexture;
    const camera  = this.sceneService.camera;
    if (!texture || !camera || !this.manifest || !this.heightfield) return;

    const cx = camera.position.x;
    const cz = camera.position.z;
    const size = this.SHORE_MAP_WORLD_SIZE;
    const half = size * 0.5;
    const res  = this.SHORE_MAP_RES;
    const worldPerTexel = size / (res - 1);

    // ── Pass 1: build flat boolean land-grid via nearest-neighbour heightfield
    // reads (one Uint16Array access per pixel, no bilinear interpolation).
    // 128×128 = 16 384 reads vs the old ~4.2 M getElevation() calls → ~145× faster.
    const isLandGrid = new Uint8Array(res * res);
    for (let py = 0; py < res; py++) {
      const wz = (cz + half) - py * worldPerTexel;
      for (let px = 0; px < res; px++) {
        if (this.isLandRaw((cx - half) + px * worldPerTexel, wz)) {
          isLandGrid[py * res + px] = 1;
        }
      }
    }

    // ── Pass 2: proximity encoding via pure integer grid searches.
    // No further world-space computations or function calls — just array indexing.
    const MAX_STEPS = 8;
    const DIRS: [number, number][] = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
      [-1,-1], [-1, 1], [1,-1], [1, 1],
    ];

    const ctx = texture.getContext();
    const imageData = ctx.getImageData(0, 0, res, res);
    const data = imageData.data;

    let ptr = 0;
    for (let py = 0; py < res; py++) {
      for (let px = 0; px < res; px++) {
        let encoded: number;
        if (isLandGrid[py * res + px]) {
          // Land pixel — full proximity (terrain mesh covers ocean here anyway).
          encoded = 1.0;
        } else {
          // Water pixel — find closest land in 8 directions.
          let minDist = MAX_STEPS;
          for (const [dx, dz] of DIRS) {
            if (minDist <= 1) break;   // can't get any closer
            for (let step = 1; step < minDist; step++) {
              const nx = px + dx * step;
              const ny = py + dz * step;
              if (nx < 0 || nx >= res || ny < 0 || ny >= res) break;
              if (isLandGrid[ny * res + nx]) { minDist = step; break; }
            }
          }
          // proximity: 1 = 1 texel from land, 0 = MAX_STEPS+ texels from land.
          encoded = Math.max(0, 1.0 - (minDist - 1) / (MAX_STEPS - 1));
        }

        const v = Math.round(encoded * 255);
        data[ptr++] = v;    // R channel
        data[ptr++] = 0;    // G
        data[ptr++] = 0;    // B
        data[ptr++] = 255;  // A
      }
    }

    ctx.putImageData(imageData, 0, 0);
    texture.update();
    this.oceanService.setShoreMap(texture, cx, cz, size);
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

  private buildTerrainMaterial(scene: any, manifest: TerrainManifest): CustomMaterial {
    this.terrainMaterial?.dispose();
    this.terrainMaterial = null;
    for (const texture of this.terrainTextures) {
      texture.dispose();
    }
    this.terrainTextures = [];

    // Procedural macro-albedo — used as a large-scale tonal luminance modifier
    // in the shader (±25 % brightness variation across the terrain surface).
    // It is no longer the primary colour source; the tiling textures are.
    const { albedoTexture } = this.createTerrainTextures(scene, manifest);
    this.terrainTextures.push(albedoTexture);

    // ── CustomMaterial: extends StandardMaterial with injected GLSL ──────────
    // Keeps Babylon's full lighting / shadow / SSAO / DoF pipeline while
    // replacing the diffuse colour with triplanar texture splatting.
    const material = new CustomMaterial('terrain_mat', scene);
    material.diffuseTexture  = albedoTexture;   // macro tonal tint map
    material.emissiveColor   = Color3.Black();
    material.disableLighting = false;
    material.specularColor   = Color3.Black();  // fully matte
    material.specularPower   = 256;

    // ── Helper: load a server-generated terrain map (png) ────────────────────
    const loadTerrainTex = (path: string, label: string): Texture => {
      const tex = new Texture(
        `${Settings.apiUrl}${path}`, scene,
        false, true, Texture.LINEAR_LINEAR_MIPLINEAR,
        null,
        () => console.info(`[Terrain] ${label} not found — run build:terrain to generate it`),
      );
      this.terrainTextures.push(tex);
      return tex;
    };

    // Macro normal map: the normal_map.png has coastal wave marks baked from the
    // original terrain geometry.  Those marks create moving diffuse stripes as the
    // sun sweeps overhead — confirmed by red-specular debug (stripes were diffuse,
    // not specular).  Fix: replace the real map with a 2×2 flat/neutral normal map
    // (all pixels 128,128,255 = straight-up normal, zero perturbation).  This keeps
    // Babylon's bumpTexture shader path active so Fragment_Custom_Diffuse compiles,
    // but contributes nothing to the lighting.  Swap back to the real map once it is
    // regenerated from the beach-graded heightfield.
    const neutralNormal = new DynamicTexture(
      'neutralNormal', { width: 2, height: 2 }, scene, false,
    );
    (neutralNormal.getContext() as unknown as CanvasRenderingContext2D)
      .fillStyle = 'rgb(128,128,255)';
    (neutralNormal.getContext() as unknown as CanvasRenderingContext2D)
      .fillRect(0, 0, 2, 2);
    neutralNormal.update();
    neutralNormal.level = 1.0;
    material.bumpTexture = neutralNormal;
    this.terrainTextures.push(neutralNormal);

    // Still load the real map so it exists on disk and the 404 warning stays quiet
    loadTerrainTex('terrain/normal-map', 'normal_map.png');

    // AO map — multiplies final lighting so valleys / depressions look darker.
    const aoTex = loadTerrainTex('terrain/ao-map', 'ao_map.png');
    material.lightmapTexture        = aoTex;
    material.useLightmapAsShadowmap = true;

    // ── Tiling tile textures (Polyhaven CC0, download:terrain-tiles) ─────────
    // Each biome has a diffuse tile that repeats at a per-material world scale.
    // wrapU/V defaults to WRAP in Babylon — explicitly set for clarity.
    const loadTile = (name: string): Texture => {
      const tex = new Texture(
        `${Settings.apiUrl}terrain/tile/${name}`, scene,
        false, false, Texture.LINEAR_LINEAR_MIPLINEAR,
        null,
        () => console.warn(`[Terrain] Tile '${name}' not found — run: npm run download:terrain-tiles`),
      );
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      this.terrainTextures.push(tex);
      return tex;
    };

    const sandTex    = loadTile('sand_diff');      // coast_sand_01 — warm golden beach sand
    const grassTex   = loadTile('grass_diff');
    const grass2Tex  = loadTile('grass2_diff');   // aerial_grass_rock — blended with grass
    const gravelTex  = loadTile('gravel_diff');
    const rockTex    = loadTile('rock_diff');
    const rock2Tex   = loadTile('rock2_diff');    // rock_face_03 — blended with rock
    const snowTex    = loadTile('snow_diff');
    // Normal maps — downloaded by download:terrain-tiles
    const sandNorTex  = loadTile('sand_nor');
    const grassNorTex = loadTile('grass_nor');
    const rockNorTex  = loadTile('rock_nor');

    // ── Declare shader uniforms ───────────────────────────────────────────────
    material.AddUniform('uPeakH',       'float',     null);
    material.AddUniform('uSandDiff',    'sampler2D', null);
    material.AddUniform('uGrassDiff',   'sampler2D', null);
    material.AddUniform('uGrass2Diff',  'sampler2D', null);
    material.AddUniform('uGravelDiff',  'sampler2D', null);
    material.AddUniform('uRockDiff',    'sampler2D', null);
    material.AddUniform('uRock2Diff',   'sampler2D', null);
    material.AddUniform('uSnowDiff',    'sampler2D', null);
    material.AddUniform('uSandNor',     'sampler2D', null);
    material.AddUniform('uGrassNor',    'sampler2D', null);
    material.AddUniform('uRockNor',     'sampler2D', null);

    // Peak height from config — used in shader to normalise vPositionW.y → [0,1]
    const peakH = manifest.targetPeakElevation ?? 920;

    // ── GLSL injection: triplanar splatting ───────────────────────────────────
    // Runs after the diffuse texture (macro albedo) is sampled into baseColor,
    // before Babylon's lighting / bump / fog calculations.
    //
    // Strategy:
    //   • vPositionW.y / peakH  → normalised elevation h ∈ [0,1]
    //   • 1 − nW.y              → slope  ∈ [0 (flat), 1 (cliff)]
    //   • abs(nW) ^ 6 normalised → triplanar weights (sharp at axis crossings)
    //   • Each tiling texture sampled from all 3 world-space planes, blended
    //   • Result tinted by macro-albedo luminance for large-scale variation


    material.Fragment_Custom_Diffuse(`
      // ── 1. Macro tonal modifier from procedural albedo ────────────────────
      float macroLum = dot(baseColor.rgb, vec3(0.299, 0.587, 0.114));
      float macroMod = 0.75 + macroLum * 0.50;  // [0.75 .. 1.25]

      // ── 2. Triplanar blend weights ────────────────────────────────────────
      vec3 nW   = normalize(vNormalW);
      vec3 triW = abs(nW);
      triW      = triW * triW * triW * triW * triW * triW;  // pow 6 — no built-in
      triW     /= (triW.x + triW.y + triW.z);               // normalise to sum = 1

      // ── 3. Elevation & slope ──────────────────────────────────────────────
      float h     = clamp(vPositionW.y / uPeakH, 0.0, 1.0);
      float slope = 1.0 - clamp(nW.y, 0.0, 1.0);

      // ── 4. Biome blend weights (mirrors CPU paintTerrainAlbedoTexture) ────
      //
      // Shore proximity override: anything within SHORE_H metres of sea level
      // (including all of the beach zone and the seabed) gets a strong sand
      // boost that overrides the height-normalised calculation.  This acts as
      // a safety net so that even if smoothing or bilinear sampling edges a
      // beach vertex slightly above the sand threshold, it still reads as sand.
      // uPeakH is 920 m so SHORE_H / uPeakH ≈ 0.011 — well below the normal
      // sand ceiling of 0.085.
      // shoreW: 1.0 at sea-level/below, 0.0 at 10 m and above.
      // max() with hSand means beach and seabed always show sand even if the
      // normalised h ended up slightly too high due to mesh smoothing.
      float shoreW  = clamp(1.0 - vPositionW.y / 10.0, 0.0, 1.0);
      float hSand   = clamp(1.0 - h / 0.085, 0.0, 1.0);
      // sandSlopeFactor: near sea level (y < 15 m) the slope penalty is fully
      // removed so sand shows even on steep beach/cliff transition vertices.
      // Above 15 m the normal slope penalty returns so mountain rock faces still
      // look rocky on steep slopes.
      float sandSlopeFactor = mix(1.0, clamp(1.0 - slope * 1.25, 0.0, 1.0),
                                  smoothstep(0.0, 15.0, vPositionW.y));
      float wSand   = max(hSand, shoreW) * sandSlopeFactor;
      float wGrass  = clamp((h - 0.035) / 0.28, 0.0, 1.0) * clamp(1.0 - slope * 0.95, 0.0, 1.0);
      float wGravel = clamp((h - 0.20)  / 0.52, 0.0, 1.0) * clamp(0.25 + slope * 1.5,  0.0, 1.0);
      float wRock   = clamp((h - 0.34)  / 0.54, 0.0, 1.0) * clamp(0.22 + slope * 1.7,  0.0, 1.0);
      float wSnow   = clamp((h - 0.68)  / 0.22, 0.0, 1.0) * clamp(1.0 - slope * 0.55,  0.0, 1.0);
      float wTotal  = max(0.0001, wSand + wGrass + wGravel + wRock + wSnow);
      wSand   /= wTotal;  wGrass  /= wTotal;  wGravel /= wTotal;
      wRock   /= wTotal;  wSnow   /= wTotal;

      // ── 5. UV warp — ZEROED for diagnostic ───────────────────────────────────
      // Testing whether the warp computation is the source of moving stripe bands.
      vec2 wFineYZ=vec2(0.0), wFineXZ=vec2(0.0), wFineXY=vec2(0.0);
      vec2 wCoarseYZ=vec2(0.0), wCoarseXZ=vec2(0.0), wCoarseXY=vec2(0.0);

      // ── 6. Texture-variety blend noise ───────────────────────────────────
      // Slow sinusoidal values (period ~880–1460 m) that smoothly mix each
      // biome's two textures across the terrain.  Different axes and phases so
      // grass and rock patches don't coincide.
      // (Sand uses a single texture — see section 7 comment.)
      float rMix = cos(vPositionW.z * 0.0071 + vPositionW.x * 0.0043) * 0.5 + 0.5;
      float gMix = sin(vPositionW.x * 0.0055 + vPositionW.z * 0.0031) * 0.5 + 0.5;

      // ── 7. Multi-scale triplanar sampling with UV warp ───────────────────
      // Each biome blends a FINE triplanar layer (detail scale) with a COARSE
      // layer (3–4× larger, often a different texture) to suppress tiling.
      // Rock and grass each have a SECOND fine texture that blends in via the
      // slow noise above, breaking monotony across large mountain faces.

      // Sand — 15 m fine triplanar (coast_sand_01)  +  55 m coarse XZ.
      // Warmed by vec3(1.12, 1.04, 0.82) so the beach reads as golden sand
      // rather than the neutral-grey tone the raw Polyhaven texture has in
      // overcast / ambient lighting.  Clamped to [0,1] in section 8.
      vec3 sandFine =
          texture2D(uSandDiff, vPositionW.yz * 0.067 + wFineYZ).rgb * triW.x +
          texture2D(uSandDiff, vPositionW.xz * 0.067 + wFineXZ).rgb * triW.y +
          texture2D(uSandDiff, vPositionW.xy * 0.067 + wFineXY).rgb * triW.z;
      vec3 sandRaw = sandFine * 0.65
                   + texture2D(uSandDiff, vPositionW.xz * 0.018 + wCoarseXZ).rgb * 0.35;
      // Warm tint: coast_sand_01 ~[0.55,0.52,0.50] → ~[0.66,0.56,0.40]
      // A sandy tan-gold rather than grey stone.  coast_sand_01 has no directional
      // grain so it won't produce stripe artefacts under moving sunlight.
      vec3 sandC = clamp(sandRaw * vec3(1.20, 1.08, 0.80), 0.0, 1.0);

      // Grass — 20 m fine tri blending forrest_ground_01 ↔ aerial_grass_rock
      //       + 75 m coarse XZ (forrest_ground_01 as tonal anchor)
      vec3 grassF1 =
          texture2D(uGrassDiff,  vPositionW.yz * 0.050 + wFineYZ).rgb * triW.x +
          texture2D(uGrassDiff,  vPositionW.xz * 0.050 + wFineXZ).rgb * triW.y +
          texture2D(uGrassDiff,  vPositionW.xy * 0.050 + wFineXY).rgb * triW.z;
      vec3 grassF2 =
          texture2D(uGrass2Diff, vPositionW.yz * 0.044 + wFineYZ).rgb * triW.x +
          texture2D(uGrass2Diff, vPositionW.xz * 0.044 + wFineXZ).rgb * triW.y +
          texture2D(uGrass2Diff, vPositionW.xy * 0.044 + wFineXY).rgb * triW.z;
      vec3 grassFine = mix(grassF1, grassF2, gMix);
      vec3 grassC = grassFine * 0.65
                  + texture2D(uGrassDiff, vPositionW.xz * 0.013 + wCoarseXZ).rgb * 0.35;

      // Gravel — 25 m fine tri  +  50 m coarse ROCK tri (cross-texture)
      vec3 gravFine =
          texture2D(uGravelDiff, vPositionW.yz * 0.040 + wFineYZ).rgb * triW.x +
          texture2D(uGravelDiff, vPositionW.xz * 0.040 + wFineXZ).rgb * triW.y +
          texture2D(uGravelDiff, vPositionW.xy * 0.040 + wFineXY).rgb * triW.z;
      vec3 gravMacro =
          texture2D(uRockDiff, vPositionW.yz * 0.020 + wCoarseYZ).rgb * triW.x +
          texture2D(uRockDiff, vPositionW.xz * 0.020 + wCoarseXZ).rgb * triW.y +
          texture2D(uRockDiff, vPositionW.xy * 0.020 + wCoarseXY).rgb * triW.z;
      vec3 gravC = gravFine * 0.55 + gravMacro * 0.45;

      // Rock — 12/14 m fine tri blending rock_face ↔ rock_face_03 (different grain)
      //       + 40 m coarse GRAVEL tri (cross-texture macro, unchanged)
      vec3 rockF1 =
          texture2D(uRockDiff,  vPositionW.yz * 0.083 + wFineYZ).rgb * triW.x +
          texture2D(uRockDiff,  vPositionW.xz * 0.083 + wFineXZ).rgb * triW.y +
          texture2D(uRockDiff,  vPositionW.xy * 0.083 + wFineXY).rgb * triW.z;
      vec3 rockF2 =
          texture2D(uRock2Diff, vPositionW.yz * 0.071 + wFineYZ).rgb * triW.x +
          texture2D(uRock2Diff, vPositionW.xz * 0.071 + wFineXZ).rgb * triW.y +
          texture2D(uRock2Diff, vPositionW.xy * 0.071 + wFineXY).rgb * triW.z;
      vec3 rockFine = mix(rockF1, rockF2, rMix);
      vec3 rockMacro =
          texture2D(uGravelDiff, vPositionW.yz * 0.025 + wCoarseYZ).rgb * triW.x +
          texture2D(uGravelDiff, vPositionW.xz * 0.025 + wCoarseXZ).rgb * triW.y +
          texture2D(uGravelDiff, vPositionW.xy * 0.025 + wCoarseXY).rgb * triW.z;
      vec3 rockC = rockFine * 0.55 + rockMacro * 0.45;

      // Snow — 30 m fine tri  +  100 m coarse XZ (same tex)
      vec3 snowFine =
          texture2D(uSnowDiff, vPositionW.yz * 0.033 + wFineYZ).rgb * triW.x +
          texture2D(uSnowDiff, vPositionW.xz * 0.033 + wFineXZ).rgb * triW.y +
          texture2D(uSnowDiff, vPositionW.xy * 0.033 + wFineXY).rgb * triW.z;
      vec3 snowC = snowFine * 0.70
                 + texture2D(uSnowDiff, vPositionW.xz * 0.010 + wCoarseXZ).rgb * 0.30;

      // ── 8. Weighted blend + macro tonal modulation ────────────────────────
      vec3 splatC = sandC*wSand + grassC*wGrass + gravC*wGravel
                  + rockC*wRock + snowC*wSnow;

      baseColor.rgb = clamp(splatC * macroMod, 0.0, 1.0);

      // ── 9. Tiled normal-map perturbation (modifies normalW for lighting) ──
      // Sample grass + rock normal maps with the same triplanar UVs and warp
      // used for diffuse.  Blend by biome weight, then add to the existing
      // normalW so tiling surface detail stacks on top of the macro bump map.
      //
      // Triplanar reorientation (OpenGL normal map: R=+U, G=+V, B=+N):
      //   YZ plane (surface normal ≈ +X):  (b, r, g)  in world XYZ
      //   XZ plane (surface normal ≈ +Y):  (r, b, g)  in world XYZ
      //   XY plane (surface normal ≈ +Z):  (r, g, b)  in world XYZ
      //
      // Strength 0.40 — strong enough to see per-biome surface character;
      // not so strong that it fights the large-scale terrain bump map.

      // Sand normals — triplanar at fine scale (same UVs as sandF1)
      // Beach faces are near-horizontal so XZ plane dominates, but full triplanar
      // handles the rare case of sand on a slope correctly.
      vec3 snYZ = texture2D(uSandNor, vPositionW.yz * 0.067 + wFineYZ).rgb * 2.0 - 1.0;
      vec3 snXZ = texture2D(uSandNor, vPositionW.xz * 0.067 + wFineXZ).rgb * 2.0 - 1.0;
      vec3 snXY = texture2D(uSandNor, vPositionW.xy * 0.067 + wFineXY).rgb * 2.0 - 1.0;
      vec3 snWorld = normalize(
          vec3(snYZ.b, snYZ.r, snYZ.g) * triW.x +
          vec3(snXZ.r, snXZ.b, snXZ.g) * triW.y +
          vec3(snXY.r, snXY.g, snXY.b) * triW.z
      );

      // Grass normals — triplanar at fine scale (same UVs as grassF1)
      vec3 gnYZ = texture2D(uGrassNor, vPositionW.yz * 0.050 + wFineYZ).rgb * 2.0 - 1.0;
      vec3 gnXZ = texture2D(uGrassNor, vPositionW.xz * 0.050 + wFineXZ).rgb * 2.0 - 1.0;
      vec3 gnXY = texture2D(uGrassNor, vPositionW.xy * 0.050 + wFineXY).rgb * 2.0 - 1.0;
      vec3 gnWorld = normalize(
          vec3(gnYZ.b, gnYZ.r, gnYZ.g) * triW.x +
          vec3(gnXZ.r, gnXZ.b, gnXZ.g) * triW.y +
          vec3(gnXY.r, gnXY.g, gnXY.b) * triW.z
      );

      // Rock normals — triplanar at fine scale (blended rock scale ~12/14 m)
      vec3 rnYZ = texture2D(uRockNor, vPositionW.yz * 0.083 + wFineYZ).rgb * 2.0 - 1.0;
      vec3 rnXZ = texture2D(uRockNor, vPositionW.xz * 0.083 + wFineXZ).rgb * 2.0 - 1.0;
      vec3 rnXY = texture2D(uRockNor, vPositionW.xy * 0.083 + wFineXY).rgb * 2.0 - 1.0;
      vec3 rnWorld = normalize(
          vec3(rnYZ.b, rnYZ.r, rnYZ.g) * triW.x +
          vec3(rnXZ.r, rnXZ.b, rnXZ.g) * triW.y +
          vec3(rnXY.r, rnXY.g, rnXY.b) * triW.z
      );

      // Per-biome normal blend — each biome gets its own surface character:
      //   sand   → coast_sand_01 normals (ripple grain, gentle bumps)
      //   grass  → forrest_ground_01 normals (leaf litter, organic micro-detail)
      //   gravel/rock/snow → rock_face normals (hard angular surface detail)
      vec3 tileNorm = normalize(
          snWorld * wSand +
          gnWorld * wGrass +
          rnWorld * (wGravel + wRock + wSnow)
      );

      // Tiled normal maps zeroed while we verify that no second stripe source
      // remains after the neutral bumpTexture fix.  Restore once confirmed clean.
      float normStrength = 0.0;
      normalW = normalize(normalW + tileNorm * normStrength);
    `);

    // ── Bind uniforms every draw call ─────────────────────────────────────────
    material.onBindObservable.add(() => {
      const fx = material.getEffect();
      if (!fx) return;
      fx.setFloat('uPeakH', peakH);
      fx.setTexture('uSandDiff',   sandTex);
      fx.setTexture('uGrassDiff',  grassTex);
      fx.setTexture('uGrass2Diff', grass2Tex);
      fx.setTexture('uGravelDiff', gravelTex);
      fx.setTexture('uRockDiff',   rockTex);
      fx.setTexture('uRock2Diff',  rock2Tex);
      fx.setTexture('uSnowDiff',   snowTex);
      fx.setTexture('uSandNor',    sandNorTex);
      fx.setTexture('uGrassNor',   grassNorTex);
      fx.setTexture('uRockNor',    rockNorTex);
    });

    this.terrainMaterial = material;
    return material;
  }

  // ── Coastal grading ───────────────────────────────────────────────────────

  /**
   * Runs once after chunks load.  Does three things:
   *
   * 1. Two-pass Manhattan distance transform → distToWater (land→sea distance)
   *    and distToLand (sea→land distance), both in heightfield cells.
   *
   * 2. Beach grading: caps each land cell within BEACH_M metres of water to a
   *    concave height profile — turns cliffs at the waterline into sandy slopes.
   *    Only ever LOWERS cells, never raises them.
   *
   * 3. Builds a depth LUT for the underwater-slope helper, and runs lightweight
   *    harbor-cove detection (results logged and returned for future use).
   *
   * Returns the coast data structure consumed by buildTerrainMesh().
   */
  private applyCoastalGrading(): NonNullable<TerrainService['coastData']> {
    const { width, height, worldBounds, quantizationLevels, targetPeakElevation } = this.manifest!;
    const hf       = this.heightfield!;
    const n        = width * height;
    const cellSizeM = (worldBounds.maxX - worldBounds.minX) / (width - 1);

    // ── 1. Distance transforms ────────────────────────────────────────────────
    const MAX16  = 0xFFFF;
    const distW  = new Uint16Array(n).fill(MAX16);   // land cell → nearest water
    const distL  = new Uint16Array(n).fill(MAX16);   // water cell → nearest land

    for (let i = 0; i < n; i++) {
      if (hf[i] === 0) distW[i] = 0;
      else             distL[i] = 0;
    }

    // Forward pass (top-left → bottom-right)
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const i = z * width + x;
        let dw = distW[i], dl = distL[i];
        if (x > 0)      { const j = i-1;     dw = Math.min(dw, distW[j]+1); dl = Math.min(dl, distL[j]+1); }
        if (z > 0)      { const j = i-width;  dw = Math.min(dw, distW[j]+1); dl = Math.min(dl, distL[j]+1); }
        distW[i] = dw;  distL[i] = dl;
      }
    }
    // Backward pass (bottom-right → top-left)
    for (let z = height-1; z >= 0; z--) {
      for (let x = width-1; x >= 0; x--) {
        const i = z * width + x;
        let dw = distW[i], dl = distL[i];
        if (x < width-1)  { const j = i+1;     dw = Math.min(dw, distW[j]+1); dl = Math.min(dl, distL[j]+1); }
        if (z < height-1) { const j = i+width;  dw = Math.min(dw, distW[j]+1); dl = Math.min(dl, distL[j]+1); }
        distW[i] = dw;  distL[i] = dl;
      }
    }

    // ── 2. Beach grading ──────────────────────────────────────────────────────
    // BEACH_M:  width of the coastal grading zone in world metres.
    //           At ~33 m/mesh-vertex this is ~6 mesh polygons — clearly visible
    //           as a sandy shelf.  Wider = more beach, flatter small islands.
    // BEACH_H:  maximum height (m) at the inner edge of the beach zone.
    //           slope ≈ BEACH_H / BEACH_M = 5/200 = 2.5 % — very walkable.
    // PROFILE:  exponent < 1 → concave curve: flat near water, gently rising
    //           inland.  A natural beach cross-section.
    const BEACH_M   = 200;
    const BEACH_H   = 5.0;
    const PROFILE   = 0.55;
    const beachCells = Math.ceil(BEACH_M / cellSizeM);
    const maxBeachQ  = Math.round((BEACH_H / targetPeakElevation) * quantizationLevels);

    for (let i = 0; i < n; i++) {
      if (hf[i] === 0) continue;                     // skip ocean
      const d = distW[i];
      if (d >= beachCells) continue;                 // outside beach zone
      const t   = d / beachCells;                    // 0 = waterline, 1 = inner edge
      const cap = Math.round(Math.pow(t, PROFILE) * maxBeachQ);
      if (hf[i] > cap) hf[i] = cap;
    }

    // distW goes out of scope here and will be GC'd.

    // ── 3. Underwater depth LUT ───────────────────────────────────────────────
    // Exponential dropoff: water deepens steeply just past the beach then
    // levels off.  Boats sailing close to an island always have clearance;
    // only intentional beaching (sailing onto land) causes grounding.
    //
    // FULL_DEPTH: maximum seabed depth in metres (12 m → ample for any boat).
    // DROPOFF_M:  e-folding distance. At DROPOFF_M from shore the seabed is
    //             at 63 % of full depth; at 3× DROPOFF_M it is at 95 %.
    //   dist=0   → y =  0 m (waterline)
    //   dist= 60 → y ≈ -3.0 m
    //   dist=180 → y ≈ -7.6 m
    //   dist=360 → y ≈-10.9 m
    //   dist=600 → y ≈-11.8 m  (near full depth)
    const FULL_DEPTH = 12.0;
    const DROPOFF_M  = 150.0;
    const dropoffCells = DROPOFF_M / cellSizeM;
    const lutLen   = Math.min(MAX16, Math.ceil(1800 / cellSizeM) + 2);
    const depthLUT = new Float32Array(lutLen);
    for (let d = 0; d < lutLen; d++) {
      depthLUT[d] = -FULL_DEPTH * (1 - Math.exp(-d / dropoffCells));
    }

    // ── 4. Harbor cove detection ──────────────────────────────────────────────
    const harbors = this.detectHarborCandidates(distL, cellSizeM);

    return { distToLand: distL, cellSizeM, depthLUT, harbors };
  }

  /**
   * Detects concave coastline sections (coves / natural harbors) by casting
   * rays outward from each near-shore water cell and measuring how many
   * directions are enclosed by land.
   *
   * A true cove → many rays blocked.  Open water → few rays blocked.
   * Returns up to 15 candidates sorted by enclosure score, in world coords.
   * Results are logged at info level; no ports are built at this stage.
   */
  private detectHarborCandidates(
    distToLand: Uint16Array,
    cellSizeM: number,
  ): Array<{ x: number; z: number; score: number }> {
    const { width, height, worldBounds } = this.manifest!;
    const hf = this.heightfield!;

    // Only check water cells within this many metres of land
    const NEAR_SHORE_M = 180;
    const nearCells    = Math.ceil(NEAR_SHORE_M / cellSizeM);

    // Cast this many rays from each candidate; check out to ENCLOSURE_M
    const RAYS        = 16;
    const ENCLOSURE_M = 600;
    const encCells    = Math.ceil(ENCLOSURE_M / cellSizeM);

    const scores = new Float32Array(width * height);
    for (let z = 1; z < height - 1; z++) {
      for (let x = 1; x < width - 1; x++) {
        const i = z * width + x;
        if (hf[i] > 0) continue;                  // land
        if (distToLand[i] > nearCells) continue;  // too far from shore

        let hits = 0;
        for (let r = 0; r < RAYS; r++) {
          const angle = (r / RAYS) * Math.PI * 2;
          const dx = Math.cos(angle);
          const dz = Math.sin(angle);
          for (let step = 4; step <= encCells; step += 3) {
            const nx = Math.round(x + dx * step);
            const nz = Math.round(z + dz * step);
            if (nx < 0 || nx >= width || nz < 0 || nz >= height) break;
            if (hf[nz * width + nx] > 0) { hits++; break; }
          }
        }
        scores[i] = hits / RAYS;
      }
    }

    // Non-maximum suppression in 5×5 window
    const MIN_SCORE   = 0.30;  // at least 30 % of rays blocked → enclosed enough
    const CLUSTER_M   = 800;
    const clusterCells = Math.ceil(CLUSTER_M / cellSizeM);

    const raw: Array<{ ix: number; iz: number; s: number }> = [];
    for (let z = 2; z < height - 2; z++) {
      for (let x = 2; x < width - 2; x++) {
        const s = scores[z * width + x];
        if (s < MIN_SCORE) continue;
        let isMax = true;
        outer: for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dz === 0) continue;
            if (scores[(z + dz) * width + (x + dx)] > s) { isMax = false; break outer; }
          }
        }
        if (isMax) raw.push({ ix: x, iz: z, s });
      }
    }

    raw.sort((a, b) => b.s - a.s);

    const kept: typeof raw = [];
    for (const c of raw) {
      const tooClose = kept.some(k =>
        Math.hypot((k.ix - c.ix) * cellSizeM, (k.iz - c.iz) * cellSizeM) < CLUSTER_M,
      );
      if (!tooClose) kept.push(c);
      if (kept.length >= 15) break;
    }

    const result = kept.map(({ ix, iz, s }) => ({
      x: worldBounds.minX + (ix / (width  - 1)) * (worldBounds.maxX - worldBounds.minX),
      z: worldBounds.maxZ - (iz / (height - 1)) * (worldBounds.maxZ - worldBounds.minZ),
      score: s,
    }));

    console.info(
      `[Terrain] ${result.length} harbor candidate(s):`,
      result.map(h => `(${Math.round(h.x)}, ${Math.round(h.z)}) enc=${h.score.toFixed(2)}`).join(' | '),
    );
    return result;
  }

  /**
   * Returns the seabed Y position (metres, ≤ 0) for an ocean vertex at the
   * given world position, using the pre-computed exponential depth LUT.
   * Falls back to the old flat -2.2 m if coast data is not yet ready.
   */
  private sampleUnderwaterDepth(worldX: number, worldZ: number): number {
    const cd = this.coastData;
    const m  = this.manifest;
    if (!cd || !m) return -2.2;

    const { width, height, worldBounds } = m;
    const px  = Math.round(((worldX - worldBounds.minX) / (worldBounds.maxX - worldBounds.minX)) * (width  - 1));
    const pz  = Math.round(((worldBounds.maxZ - worldZ)  / (worldBounds.maxZ - worldBounds.minZ)) * (height - 1));
    const idx = Math.max(0, Math.min(height - 1, pz)) * width + Math.max(0, Math.min(width - 1, px));
    const d   = cd.distToLand[idx];
    return d < cd.depthLUT.length ? cd.depthLUT[d] : cd.depthLUT[cd.depthLUT.length - 1];
  }

  private createTerrainTextures(scene: any, manifest: TerrainManifest): {
    albedoTexture: DynamicTexture;
  } {
    // 4096 is the output canvas size.  The biome + grain loop runs at 2048×2048
    // (24 m/texel — 2× sharper biome boundaries than the old 1024 strategy)
    // then scales to 4096 via drawImage.  Three-octave fBm grain is baked
    // directly into the biome pass so no separate grain canvas is needed.
    // Total ≈ 700 ms during the "Surveying the coastline…" loading step.
    const size = 4096;
    const albedoTexture = new DynamicTexture('terrain_albedo_texture', { width: size, height: size }, scene, true, Texture.LINEAR_LINEAR_MIPLINEAR, undefined, false);

    albedoTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    albedoTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.paintTerrainAlbedoTexture(albedoTexture, manifest);

    return { albedoTexture };
  }

  private paintTerrainAlbedoTexture(texture: DynamicTexture, manifest: TerrainManifest): void {
    // Cast to browser's native 2D context — Babylon's ICanvasRenderingContext
    // abstraction omits imageSmoothingEnabled/Quality and drawImage(HTMLCanvasElement).
    // We are always in a browser here so the cast is safe.
    const mainCtx = texture.getContext() as unknown as CanvasRenderingContext2D;
    const size    = mainCtx.canvas.width;   // 4096
    const peak    = Math.max(1, manifest.targetPeakElevation);

    // ── Pass 1: biome macro-palette at 2048 × 2048, scaled to 4096 ─────────────
    // THREE-OCTAVE VALUE NOISE
    // hashNoise(u * N, …) at 2048 canvas gives white noise regardless of N — the
    // ×43758 magnifier before frac() destroys spatial correlation for any Δu.
    // Precompute three small hash lattices and bilinearly interpolate (classic
    // "value noise"): fully smooth, no Math.sin in the inner loop.
    //
    //   lat1  S=180 → patch period ≈ 50 000/180 ≈ 278 m  (coarse mineral zone colour)
    //   lat2  S=580 → patch period ≈ 50 000/580 ≈  86 m  (medium rock-face variation)
    //   lat3  S=820 → patch period ≈ 50 000/820 ≈  61 m  (fine detail within faces)
    //
    // Precompute cost: 181²+581²+821² ≈ 1.04 M hash calls, ~10 ms total — done
    // once before the pixel loop.  Per-pixel cost: 12 array reads, zero trig.
    const BIOME_RES = 2048;

    const L1 = 180, L1n = L1 + 1;
    const L2 = 580, L2n = L2 + 1;
    const L3 = 820, L3n = L3 + 1;
    const lat1 = new Float32Array(L1n * L1n);
    const lat2 = new Float32Array(L2n * L2n);
    const lat3 = new Float32Array(L3n * L3n);
    for (let j = 0; j < L1n; j++)
      for (let i = 0; i < L1n; i++)
        lat1[j * L1n + i] = this.hashNoise(i * 3.71, j * 7.23 + 4.17);
    for (let j = 0; j < L2n; j++)
      for (let i = 0; i < L2n; i++)
        lat2[j * L2n + i] = this.hashNoise(i * 5.31 + 91.7, j * 11.13 + 23.9);
    for (let j = 0; j < L3n; j++)
      for (let i = 0; i < L3n; i++)
        lat3[j * L3n + i] = this.hashNoise(i * 8.17 + 37.3, j * 4.91 + 66.1);

    // Smooth bilinear value-noise sampler — smoothstep in both axes.
    const vn1 = (u: number, v: number): number => {
      const x = u * L1, y = v * L1;
      const xi = Math.min(L1 - 1, x | 0), yi = Math.min(L1 - 1, y | 0);
      const xf = x - xi, yf = y - yi;
      const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
      const b = yi * L1n + xi;
      const h00 = lat1[b], h10 = lat1[b + 1], h01 = lat1[b + L1n], h11 = lat1[b + L1n + 1];
      return h00 + (h10 - h00) * sx + (h01 - h00) * sy + (h00 - h10 - h01 + h11) * sx * sy;
    };
    const vn2 = (u: number, v: number): number => {
      const x = u * L2, y = v * L2;
      const xi = Math.min(L2 - 1, x | 0), yi = Math.min(L2 - 1, y | 0);
      const xf = x - xi, yf = y - yi;
      const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
      const b = yi * L2n + xi;
      const h00 = lat2[b], h10 = lat2[b + 1], h01 = lat2[b + L2n], h11 = lat2[b + L2n + 1];
      return h00 + (h10 - h00) * sx + (h01 - h00) * sy + (h00 - h10 - h01 + h11) * sx * sy;
    };
    const vn3 = (u: number, v: number): number => {
      const x = u * L3, y = v * L3;
      const xi = Math.min(L3 - 1, x | 0), yi = Math.min(L3 - 1, y | 0);
      const xf = x - xi, yf = y - yi;
      const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
      const b = yi * L3n + xi;
      const h00 = lat3[b], h10 = lat3[b + 1], h01 = lat3[b + L3n], h11 = lat3[b + L3n + 1];
      return h00 + (h10 - h00) * sx + (h01 - h00) * sy + (h00 - h10 - h01 + h11) * sx * sy;
    };

    const tmpCanvas  = document.createElement('canvas');
    tmpCanvas.width  = BIOME_RES;
    tmpCanvas.height = BIOME_RES;
    const tmpCtx  = tmpCanvas.getContext('2d')!;
    const biomeId = tmpCtx.createImageData(BIOME_RES, BIOME_RES);
    const bd      = biomeId.data;

    for (let y = 0; y < BIOME_RES; y++) {
      const v = y / (BIOME_RES - 1);
      for (let x = 0; x < BIOME_RES; x++) {
        const u = x / (BIOME_RES - 1);
        const hMeters = this.sampleElevationMeters(u, v);
        const h       = this.clamp01(hMeters / peak);
        const slope   = this.sampleSlope(u, v);

        // ── Smooth value noise (from precomputed lattices above the loop) ────────
        const n1 = vn1(u, v);   // ~278 m smooth patches — coarse mineral zone
        const n2 = vn2(u, v);   // ~86 m smooth patches  — medium rock-face tone
        const n3 = vn3(u, v);   // ~61 m smooth patches  — fine face detail

        // Medium scale dominates so rock faces show 60–90 m variation patches.
        const colorVar = n1 * 0.22 + n2 * 0.48 + n3 * 0.30;

        // Geological strata bands, organically distorted by smooth noise.
        const strata = Math.sin(h * 8.0 + n1 * 3.0 + n2 * 2.0) * 0.5 + 0.5;

        // Tonal: ±19 % brightness swing driven by genuine spatial variation.
        const tonal  = 0.86 + strata * 0.09 + (colorVar - 0.5) * 0.38;

        let sandW   = this.clamp01(1.0 - h / 0.085)     * this.clamp01(1.0 - slope * 1.25);
        let grassW  = this.clamp01((h - 0.035) / 0.28)  * this.clamp01(1.0 - slope * 0.95);
        let soilW   = this.clamp01((h - 0.10)  / 0.35)  * this.clamp01(1.0 - slope * 0.42);
        let gravelW = this.clamp01((h - 0.20)  / 0.52)  * this.clamp01(0.25 + slope * 1.5);
        let rockW   = this.clamp01((h - 0.34)  / 0.54)  * this.clamp01(0.22 + slope * 1.7);
        let snowW   = this.clamp01((h - 0.68)  / 0.22)  * this.clamp01(1.0 - slope * 0.55);

        // Smooth noise modulates biome weight boundaries → organic blobs at
        // 60–280 m scale break the elevation-locked biome lines.
        grassW  *= 0.68 + n1 * 0.62;
        soilW   *= 0.64 + n2 * 0.72;
        gravelW *= 0.55 + n2 * 0.90;
        rockW   *= 0.68 + strata * 0.32 + n2 * 0.30;
        snowW   *= 0.80 + n1 * 0.26;

        const total = Math.max(0.0001, sandW + grassW + soilW + gravelW + rockW + snowW);
        sandW   /= total;  grassW  /= total;  soilW  /= total;
        gravelW /= total;  rockW   /= total;  snowW  /= total;

        const sand   = [0.78, 0.73, 0.62];
        const grass  = [0.23, 0.43, 0.19];
        const soil   = [0.40, 0.31, 0.23];
        const snow   = [0.88, 0.89, 0.90];

        // Dynamic rock colour: n2 (86 m) is the PRIMARY driver so a 400–600 m
        // mountain face shows 4–6 distinct colour patches rather than one uniform
        // tone.  n1 (278 m) adds a broad warm/cool zone tendency; n3 (61 m) adds
        // fine variation at the top.  Extremes: warm iron-oxide ↔ cool basalt.
        const rockT = this.clamp01(n2 * 0.65 + n1 * 0.25 + n3 * 0.10);
        const rock = [
          0.50 * rockT + 0.20 * (1 - rockT),   // R: rust 0.50 ↔ basalt 0.20
          0.35 * rockT + 0.22 * (1 - rockT),   // G: 0.35 ↔ 0.22
          0.19 * rockT + 0.40 * (1 - rockT),   // B: 0.19 ↔ basalt 0.40
        ];

        // Dynamic gravel: n3 (61 m) primary, n2 (86 m) secondary — ensures
        // gravel/talus patches are finer-grained than rock face patches.
        // Sandy limestone [0.56,0.49,0.33] ↔ slate [0.32,0.35,0.50].
        const gravT = this.clamp01(n3 * 0.55 + n2 * 0.35 + n1 * 0.10);
        const gravel = [
          0.56 * gravT + 0.32 * (1 - gravT),
          0.49 * gravT + 0.35 * (1 - gravT),
          0.33 * gravT + 0.50 * (1 - gravT),
        ];

        // Mix base colour from biome weights and apply tonal brightness.
        const r = this.clamp01((sand[0]*sandW + grass[0]*grassW + soil[0]*soilW + gravel[0]*gravelW + rock[0]*rockW + snow[0]*snowW) * tonal);
        const g = this.clamp01((sand[1]*sandW + grass[1]*grassW + soil[1]*soilW + gravel[1]*gravelW + rock[1]*rockW + snow[1]*snowW) * tonal);
        const b = this.clamp01((sand[2]*sandW + grass[2]*grassW + soil[2]*soilW + gravel[2]*gravelW + rock[2]*rockW + snow[2]*snowW) * tonal);

        const off = (y * BIOME_RES + x) * 4;
        bd[off]     = Math.round(r * 255);
        bd[off + 1] = Math.round(g * 255);
        bd[off + 2] = Math.round(b * 255);
        bd[off + 3] = 255;
      }
    }

    // Scale biome map from 1024 → 4096 using the browser's bicubic resampler.
    tmpCtx.putImageData(biomeId, 0, 0);
    mainCtx.imageSmoothingEnabled = true;
    mainCtx.imageSmoothingQuality = 'high';
    mainCtx.drawImage(tmpCanvas, 0, 0, size, size);

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
