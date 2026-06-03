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
  StandardMaterial,
  Matrix,
  VertexData,
} from '@babylonjs/core';
import { CustomMaterial } from '@babylonjs/materials';
import { Settings } from '../../app.settings';
import { TerrainManifest, TerrainWorldBounds } from '../models';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { createSpsTreeArchetype } from '../utils/sps-tree-generator';
import {
  createRockProto, createGrassProto, createBeachGrassProto,
  createDriftwoodProto, createDeadTreeProto,
} from '../utils/scatter-generator';

type TreePatch = {
  root: TransformNode;
  centerX: number;
  centerZ: number;
  density: number;
  count: number;
};

// Camera-local ground-scatter pool (thin-instanced). Instances are placed on a
// deterministic world grid but only within `radius` of the camera, and refilled
// as the camera moves — so the world's 50 km span gets dense, visible cover near
// the player without billions of instances.
type ScatterType = {
  proto: Mesh;
  instances: InstancedMesh[];   // reused camera-local pool (grows to peak need)
  poolMax: number;
  cellSize: number;     // world grid spacing (m) — controls density
  radius: number;       // how far from the camera to populate (m)
  seed: number;
  gate: (h: number, slope: number) => number;
  scale: (r: number) => { sx: number; sy: number; sz: number };
  embed: number;
  tilt: number;
  alignSlope: number;
  lastX: number;
  lastZ: number;
  logged: boolean;
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
  private scatterMeshes: Mesh[] = [];   // thin-instanced ground scatter prototypes
  private scatterTypes: ScatterType[] = [];
  private scatterObserver: any = null;
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
    // Distant forests = the green CANOPY painted into the terrain shader (§8d); there are
    // NO 3-D forest trees (rendering 42k of them, even near-culled, was the FPS wall). The
    // ONLY real 3-D trees are sparse PALMS dotted along the beaches, rendered only within
    // ~200 m of the camera — so you get actual trees + shadows when you land on a shore for
    // almost no cost (few exist, fewer enabled). buildTreeFoliage (forest trees) is unused.
    this.buildBeachPalms(scene, manifest);
    // Ground scatter (rocks/grass/driftwood/dead trees) is implemented but
    // DISABLED pending a live debug: placement works (instances are created with
    // valid positions, per console logs) but nothing renders via either thin
    // instances or InstancedMesh — needs in-scene inspection to diagnose.
    // To re-enable: this.buildGroundScatter(scene, manifest);
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
    // Also drive the cascaded shadow MAP (was previously never wired to this slider).
    this.sceneService.setShadowMapQuality(level);
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
      // Cast shadows: adding the prototype as a caster makes all its instances
      // cast into the cascaded shadow map, so trees drop shadows on the terrain
      // (which already receiveShadows). Far patches are setEnabled(false) by the
      // patch culling, so only nearby trees pay the shadow-render cost.
      this.sceneService.shadowGenerator?.addShadowCaster(prototype, true);
    }

    // Small patches so the near-camera cull is fine-grained (a 2300 m patch would
    // pop a huge block of trees in/out at once). Full placement density is kept —
    // only a few nearby patches are ever enabled at a time, so total count is cheap.
    const patchSize = 350;
    const gridX = 480;
    const gridZ = 480;
    const hardCap = 42000;
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
        const chance = wooded * (0.34 + patchDensity * 1.0);
        const accept = this.hashNoise(u * 63.7 + 7.3, v * 63.7 + 53.2);
        if (accept > chance) continue;

        const worldX = bounds.minX + u * worldWidth;
        const worldZ = bounds.maxZ - v * worldDepth;
        const y = this.getElevation(worldX, worldZ);
        if (y <= 0.2) continue;

        const slope = this.sampleSlope(u, v);
        if (slope > 0.6) continue;

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
        // Trees never move — freeze the world matrix and stop bounding-info syncs
        // so Babylon doesn't recompute transforms/bounds for tens of thousands of
        // instances every frame (pure CPU win, no visual change).
        instance.freezeWorldMatrix();
        instance.doNotSyncBoundingInfo = true;
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

  /**
   * Ground scatter (grass, rocks, beach grass, driftwood, dead trees). Each prop
   * type is one thin-instanced mesh whose instances are placed on a deterministic
   * world grid but only within `radius` of the camera, and refilled as the camera
   * moves. This gives dense, visible cover near the player across the 50 km world
   * without astronomical instance counts. (Deterministic placement = no shimmer.)
   */
  private buildGroundScatter(scene: Scene, manifest: TerrainManifest): void {
    const mk = (
      proto: Mesh,
      cfg: Omit<ScatterType, 'proto' | 'instances' | 'lastX' | 'lastZ' | 'logged'>,
    ): ScatterType => {
      proto.isVisible = false;        // source mesh — only its instances are drawn
      proto.isPickable = false;
      proto.position.set(0, -10000, 0);
      this.sceneService.excludeFromGlow(proto);
      this.scatterMeshes.push(proto);
      return { proto, instances: [], lastX: NaN, lastZ: NaN, logged: false, ...cfg };
    };

    this.scatterTypes = [
      mk(createGrassProto('scatter_grass', scene), {
        poolMax: 6000, cellSize: 5, radius: 450, seed: 11,
        gate: (h, s) => (h > 0.04 && h < 0.5 && s < 0.34)
          ? Math.exp(-Math.pow((h - 0.22) / 0.18, 2)) * this.clamp01(1 - s * 2.2) : 0,
        scale: r => { const k = 0.55 + r * 0.8; return { sx: k, sy: k * (0.8 + r * 0.6), sz: k }; },
        embed: 0.0, tilt: 0.12, alignSlope: 0.0,
      }),
      mk(createRockProto('scatter_rock', scene), {
        poolMax: 2500, cellSize: 13, radius: 700, seed: 23,
        gate: (h, s) => (h > 0.02) ? this.clamp01(s * 1.3 + Math.max(0, h - 0.45) * 1.2) * 0.55 : 0,
        scale: r => { const k = 0.5 + r * r * 2.4; return { sx: k * (0.8 + r * 0.5), sy: k * (0.55 + r * 0.4), sz: k * (0.8 + r * 0.5) }; },
        embed: 0.35, tilt: 0.4, alignSlope: 0.3,
      }),
      mk(createBeachGrassProto('scatter_beachgrass', scene), {
        poolMax: 3500, cellSize: 6, radius: 450, seed: 37,
        gate: (h, s) => (h > 0.006 && h < 0.06 && s < 0.2) ? 0.85 : 0,
        scale: r => { const k = 0.7 + r * 0.9; return { sx: k * 0.8, sy: k * (1.0 + r * 0.7), sz: k * 0.8 }; },
        embed: 0.0, tilt: 0.14, alignSlope: 0.0,
      }),
      mk(createDriftwoodProto('scatter_driftwood', scene), {
        poolMax: 1200, cellSize: 14, radius: 450, seed: 53,
        gate: (h, s) => (h > 0.001 && h < 0.055 && s < 0.22) ? 0.5 : 0,
        scale: r => { const k = 1.1 + r * 1.3; return { sx: k, sy: k, sz: k }; },
        embed: 0.12, tilt: 0.3, alignSlope: 0.0,
      }),
      mk(createDeadTreeProto('scatter_deadtree', scene), {
        poolMax: 1200, cellSize: 18, radius: 800, seed: 71,
        gate: (h, s) => (h > 0.58 && h < 0.86 && s < 0.5) ? 0.3 : 0,
        scale: r => { const k = 0.8 + r * 0.8; return { sx: k, sy: k, sz: k }; },
        embed: 0.05, tilt: 0.18, alignSlope: 0.15,
      }),
    ];

    this.scatterObserver = scene.onBeforeRenderObservable.add(() => this.updateScatter());
    this.updateScatter();
  }

  /** Refill any scatter pool whose camera has moved more than half a cell. */
  private updateScatter(): void {
    const cam = this.sceneService.camera;
    if (!cam || !this.manifest) return;
    const camX = cam.position.x;
    const camZ = cam.position.z;
    for (const s of this.scatterTypes) {
      const threshold = (s.cellSize * 0.5) ** 2;
      const moved = (camX - s.lastX) ** 2 + (camZ - s.lastZ) ** 2;
      if (Number.isFinite(s.lastX) && moved < threshold) continue;
      s.lastX = camX;
      s.lastZ = camZ;
      this.repopulateScatter(s, camX, camZ);
    }
  }

  /** Fill a scatter pool from the deterministic world grid within radius of the camera. */
  private repopulateScatter(s: ScatterType, camX: number, camZ: number): void {
    const bounds = this.manifest!.worldBounds;
    const worldWidth = bounds.maxX - bounds.minX;
    const worldDepth = bounds.maxZ - bounds.minZ;
    const cs = s.cellSize;
    const R = s.radius;
    const R2 = R * R;
    const ix0 = Math.floor((camX - R) / cs);
    const ix1 = Math.floor((camX + R) / cs);
    const iz0 = Math.floor((camZ - R) / cs);
    const iz1 = Math.floor((camZ + R) / cs);
    let count = 0;

    for (let iz = iz0; iz <= iz1 && count < s.poolMax; iz++) {
      for (let ix = ix0; ix <= ix1 && count < s.poolMax; ix++) {
        const jx = this.hashNoise(ix * 0.137 + s.seed, iz * 0.131 + s.seed * 0.7);
        const jz = this.hashNoise(ix * 0.149 + s.seed * 1.7, iz * 0.127 + s.seed);
        const worldX = ix * cs + jx * cs;
        const worldZ = iz * cs + jz * cs;
        const dx = worldX - camX;
        const dz = worldZ - camZ;
        if (dx * dx + dz * dz > R2) continue;

        const u = (worldX - bounds.minX) / worldWidth;
        const v = (bounds.maxZ - worldZ) / worldDepth;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;

        const h = this.sampleNormalizedHeight(u, v);
        const slope = this.sampleSlope(u, v);
        const weight = s.gate(h, slope);
        if (weight <= 0) continue;
        if (this.hashNoise(ix * 7.31 + s.seed, iz * 5.17 + s.seed * 2.1) > weight) continue;

        const y = this.getElevation(worldX, worldZ);
        if (y <= 0.05) continue;

        const r = this.hashNoise(ix * 3.7 + s.seed, iz * 2.3 + s.seed * 3.3);
        const sc = s.scale(r);
        const yaw = this.hashNoise(ix * 1.1 + s.seed * 5, iz * 1.3 + s.seed) * Math.PI * 2;
        const tiltAmt = s.tilt + slope * s.alignSlope * 2.0;
        const tiltX = (this.hashNoise(ix * 0.7 + s.seed, iz * 0.9) - 0.5) * tiltAmt;
        const tiltZ = (this.hashNoise(ix * 0.9 + s.seed * 7, iz * 0.7 + 9) - 0.5) * tiltAmt;

        // Reuse an existing instance from the pool, or grow it on demand.
        let inst = s.instances[count];
        if (!inst) {
          inst = s.proto.createInstance(`${s.proto.name}_${count}`);
          inst.isPickable = false;
          s.instances.push(inst);
        }
        inst.position.set(worldX, y - sc.sy * s.embed, worldZ);
        inst.scaling.set(sc.sx, sc.sy, sc.sz);
        inst.rotationQuaternion = Quaternion.RotationYawPitchRoll(yaw, tiltX, tiltZ);
        inst.setEnabled(true);
        count++;
      }
    }

    // Disable any leftover instances from a previous (denser) refill.
    for (let i = count; i < s.instances.length; i++) s.instances[i].setEnabled(false);

    if (!s.logged) {
      console.log(`[Terrain] Scatter '${s.proto.name}': ${count} instances within ${R}m of camera (${camX.toFixed(0)}, ${camZ.toFixed(0)}).`);
      s.logged = true;
    }
  }

  /**
   * Sparse PALMS scattered along the beaches, rendered only within ~200 m of the camera
   * (the updateTreePatchVisibility cull). Replaces the old forest-biome trees entirely:
   * far fewer instances total (~2k vs 42k), placed only on the shoreline band, so the
   * per-frame residual is tiny and only a handful are ever enabled at once.
   */
  private buildBeachPalms(scene: Scene, manifest: TerrainManifest): void {
    const bounds = manifest.worldBounds;
    const worldWidth = bounds.maxX - bounds.minX;
    const worldDepth = bounds.maxZ - bounds.minZ;

    const palm = this.buildPalmMesh(scene);
    palm.isVisible = false;
    palm.isPickable = false;
    palm.position.set(0, -10000, 0);
    palm.renderingGroupId = 2;   // CRITICAL: terrain/ocean/vessel are all group 2 with depth-
                                 // clear disabled; a default group-0 mesh renders first and then
                                 // gets buried behind the terrain. THIS was why palms were
                                 // invisible — not placement, instancing, freeze, or the mesh.
    this.sceneService.excludeFromGlow(palm);
    this.sceneService.shadowGenerator?.addShadowCaster(palm, true);
    this.treePrototypeMeshes = [palm];

    const patchSize = 150;     // fine patches → tight near-camera culling
    const gridX = 600;         // denser sampling so thin beach strips get hit
    const gridZ = 600;
    const hardCap = 60000;     // safety only — must NOT be hit, or placement clusters in
                               // the first-scanned region. Density is controlled by chance.
    const patchMap = new Map<string, TreePatch>();
    let placed = 0;

    for (let gz = 0; gz < gridZ && placed < hardCap; gz++) {
      for (let gx = 0; gx < gridX && placed < hardCap; gx++) {
        const u = (gx + this.hashNoise(gx * 0.63 + 13.7, gz * 0.71 + 5.1) * 0.9) / gridX;
        const v = (gz + this.hashNoise(gx * 0.49 + 17.9, gz * 0.55 + 11.3) * 0.9) / gridZ;
        const worldX = bounds.minX + u * worldWidth;
        const worldZ = bounds.maxZ - v * worldDepth;
        const y = this.getElevation(worldX, worldZ);
        // Sandy coastal zone — widened to catch the actual beaches/dunes (they rise
        // higher and steeper than a flat strip), not just rare flat lagoon spots.
        if (y < 0.3 || y > 20.0) continue;
        if (this.sampleSlope(u, v) > 0.9) continue;
        // Density: enough that beaches you approach reliably have palms within the cull
        // radius, but kept well under the cap so placement stays uniform (no clustering).
        if (this.hashNoise(u * 131.7 + 3.1, v * 131.7 + 9.4) > 0.30) continue;

        const inst = palm.createInstance(`tree_palm_${placed}`);
        const r = this.hashNoise(worldX * 0.0017 + 2.1, worldZ * 0.0017 + 8.4);
        inst.position.set(worldX, y, worldZ);
        inst.scaling.setAll(0.8 + r * 0.7);
        inst.rotation.y = this.hashNoise(worldX * 0.0021 + 101.9, worldZ * 0.0021 + 44.8) * Math.PI * 2;
        inst.rotation.z = (this.hashNoise(worldX * 0.003 + 5.0, worldZ * 0.003 + 1.0) - 0.5) * 0.22; // slight lean
        inst.isPickable = false;

        const patchX = Math.floor((worldX - bounds.minX) / patchSize);
        const patchZ = Math.floor((worldZ - bounds.minZ) / patchSize);
        const key = `${patchX}:${patchZ}`;
        let patch = patchMap.get(key);
        if (!patch) {
          patch = {
            root: new TransformNode(`tree_patch_${key}`, scene),
            centerX: bounds.minX + (patchX + 0.5) * patchSize,
            centerZ: bounds.minZ + (patchZ + 0.5) * patchSize,
            density: 0.5, count: 0,
          };
          patchMap.set(key, patch);
          this.treePatches.push(patch);
        }
        inst.parent = patch.root;
        // NOTE: deliberately NOT calling freezeWorldMatrix()/doNotSyncBoundingInfo here —
        // that leaves the instance's bounding box stale at the prototype's location, so the
        // frustum culler skips it and the palm never renders. There are few palms (near-
        // culled), so normal per-frame bounding is cheap.
        patch.count += 1;
        this.treeInstances.push(inst);
        placed += 1;
      }
    }

    this.treeCullingObserver = scene.onBeforeRenderObservable.add(() => this.updateTreePatchVisibility());
    this.updateTreePatchVisibility();
    console.log(`[Terrain] Placed ${placed} beach palms across ${this.treePatches.length} patches.`);
  }

  /** Low-poly stylised palm: a tapered, slightly tapering trunk + a crown of drooping
   *  fronds. Vertex-coloured (brown trunk, green fronds) and merged into one mesh so it
   *  instances cheaply. */
  private buildPalmMesh(scene: Scene): Mesh {
    const trunkBase = new Color4(0.42, 0.31, 0.19, 1);
    const trunkTop  = new Color4(0.55, 0.43, 0.28, 1);
    const frondBase = new Color4(0.11, 0.33, 0.12, 1);
    const frondTip  = new Color4(0.33, 0.58, 0.24, 1);
    const cocoCol   = new Color4(0.33, 0.24, 0.14, 1);

    const TRUNK_H = 9;
    const CROWN_Y = TRUNK_H;

    // Trunk: tapered, with height subdivisions (so it can curve subtly) + ring shading.
    const trunk = MeshBuilder.CreateCylinder('palm_trunk', {
      height: TRUNK_H, diameterBottom: 0.85, diameterTop: 0.34, tessellation: 8, subdivisions: 6,
    }, scene);
    trunk.bakeTransformIntoVertices(Matrix.Translation(0, TRUNK_H / 2, 0));  // base at y = 0
    this.setMeshColorGradientY(trunk, trunkBase, trunkTop, 0, TRUNK_H);
    const parts: Mesh[] = [trunk];

    // Fronds: two drooping rings of tapered leaves (narrow base → wide middle → point).
    const makeFrond = (ring: number, idx: number): Mesh => {
      const len = 6.0 - ring * 0.8 + (idx % 2) * 0.5;
      const hw = 0.85;
      const m = new Mesh(`palm_frond_${ring}_${idx}`, scene);
      const positions = [
        -hw * 0.28, 0,          0,    // 0 base L
         hw * 0.28, 0,          0,    // 1 base R
        -hw,        len * 0.42, 0,    // 2 mid L
         hw,        len * 0.42, 0,    // 3 mid R
         0,         len,        0,    // 4 tip
      ];
      const indices = [0, 2, 3, 0, 3, 1, 2, 4, 3];
      const uvs = [0.5, 0, 0.5, 0, 0, 0.4, 1, 0.4, 0.5, 1];
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, indices, normals);
      const vd = new VertexData();
      vd.positions = positions; vd.indices = indices; vd.normals = normals; vd.uvs = uvs;
      vd.applyToMesh(m);
      // Per-vertex gradient: dark green at the base → bright at the tip.
      const tPer = [0, 0, 0.42, 0.42, 1];
      const cols: number[] = [];
      for (const t of tPer) {
        cols.push(
          frondBase.r + (frondTip.r - frondBase.r) * t,
          frondBase.g + (frondTip.g - frondBase.g) * t,
          frondBase.b + (frondTip.b - frondBase.b) * t,
          1,
        );
      }
      m.setVerticesData(VertexBuffer.ColorKind, cols);
      return m;
    };

    const RINGS = 2;
    const PER_RING = 6;
    for (let ring = 0; ring < RINGS; ring++) {
      for (let i = 0; i < PER_RING; i++) {
        const f = makeFrond(ring, i);
        f.rotation.x = (ring === 0 ? 0.70 : 1.45) + (i % 2) * 0.15;          // upper ring up, lower droops
        f.rotation.y = (i / PER_RING) * Math.PI * 2 + ring * (Math.PI / PER_RING);  // offset rings
        f.position.set(0, CROWN_Y, 0);
        parts.push(f);
      }
    }

    // Coconuts: a small cluster tucked under the crown.
    for (let i = 0; i < 4; i++) {
      const c = MeshBuilder.CreateSphere(`palm_coco_${i}`, { diameter: 0.5, segments: 4 }, scene);
      const a = (i / 4) * Math.PI * 2;
      c.bakeTransformIntoVertices(
        Matrix.Translation(Math.cos(a) * 0.42, CROWN_Y - 0.5, Math.sin(a) * 0.42),
      );
      this.setMeshColor(c, cocoCol);
      parts.push(c);
    }

    const palm = Mesh.MergeMeshes(parts, true, true)!;
    palm.name = 'tree_palm';   // 'tree_' prefix → excluded from ocean reflection/refraction RTTs
    const mat = new StandardMaterial('palmMat', scene);
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;          // fronds visible from both sides
    palm.material = mat;
    palm.useVertexColors = true;
    return palm;
  }

  /** Paints a single flat colour into a mesh's vertex-colour buffer. */
  private setMeshColor(m: Mesh, c: Color4): void {
    const pos = m.getVerticesData(VertexBuffer.PositionKind);
    if (!pos) return;
    const n = pos.length / 3;
    const cols = new Array<number>(n * 4);
    for (let i = 0; i < n; i++) {
      cols[i * 4] = c.r; cols[i * 4 + 1] = c.g; cols[i * 4 + 2] = c.b; cols[i * 4 + 3] = c.a;
    }
    m.setVerticesData(VertexBuffer.ColorKind, cols);
  }

  /** Paints a base→top vertical colour gradient into a mesh's vertex-colour buffer. */
  private setMeshColorGradientY(m: Mesh, cBase: Color4, cTop: Color4, yMin: number, yMax: number): void {
    const pos = m.getVerticesData(VertexBuffer.PositionKind);
    if (!pos) return;
    const n = pos.length / 3;
    const span = Math.max(1e-3, yMax - yMin);
    const cols = new Array<number>(n * 4);
    for (let i = 0; i < n; i++) {
      const t = Math.max(0, Math.min(1, (pos[i * 3 + 1] - yMin) / span));
      cols[i * 4]     = cBase.r + (cTop.r - cBase.r) * t;
      cols[i * 4 + 1] = cBase.g + (cTop.g - cBase.g) * t;
      cols[i * 4 + 2] = cBase.b + (cTop.b - cBase.b) * t;
      cols[i * 4 + 3] = 1;
    }
    m.setVerticesData(VertexBuffer.ColorKind, cols);
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
      // Beach palms render within ~1000 m of the camera (distant forest look is the shader
      // canopy). They batch as instances so a long beach is cheap; tree shadows still clip
      // at shadowMaxZ (~200 m), so only near palms pay shadow cost.
      const cullRadius = 1000;
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
        leafClusters: 18,    // halved (perf): fewer, larger leaves keep the canopy
        leafSizeMin: 0.74,   // scaled up ~1.35× to preserve coverage
        leafSizeMax: 1.41,
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
        leafClusters: 14,
        leafSizeMin: 0.54,
        leafSizeMax: 0.97,
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
        leafClusters: 17,
        leafSizeMin: 0.70,
        leafSizeMax: 1.27,
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
        leafClusters: 15,
        leafSizeMin: 0.62,
        leafSizeMax: 1.13,
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
        leafClusters: 13,
        leafSizeMin: 0.46,
        leafSizeMax: 0.86,
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

    // Trees from just above the waterline (sparse beach growth) up through rocky
    // upper slopes, only excluded from the very peaks and near-vertical faces.
    if (h < 0.004 || h > 0.85) return 0;
    if (slope > 0.62) return 0;

    const beachFade  = this.clamp01((h - 0.004) / 0.04);   // sprinkle down onto the sand
    const alpineFade = this.clamp01((0.85 - h) / 0.22);    // thin out toward the peaks
    const slopeFade  = this.clamp01((0.62 - slope) / 0.34);
    const meadowBand = Math.exp(-Math.pow((h - 0.25) / 0.24, 2));

    // Moisture: forests cluster in wet zones (matching the shader's lush grass),
    // thinning out on dry/exposed ground so the trees and the ground agree.
    const bounds = this.manifest!.worldBounds;
    const wx = bounds.minX + u * (bounds.maxX - bounds.minX);
    const wz = bounds.maxZ - v * (bounds.maxZ - bounds.minZ);
    const wetF = this.clamp01((this.terrainMoisture(wx, wz) - 0.25) / 0.53);
    const moistFactor = 0.6 + 0.9 * wetF;

    // Lush in the meadow band but with a solid floor so rocky/upper slopes still
    // carry a real scattering of trees rather than going bare.
    return this.clamp01(beachFade * alpineFade * slopeFade * (0.5 + 0.5 * meadowBand) * moistFactor);
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

    if (this.scatterObserver && this.sceneService.scene) {
      this.sceneService.scene.onBeforeRenderObservable.remove(this.scatterObserver);
      this.scatterObserver = null;
    }
    for (const mesh of this.scatterMeshes) {
      mesh.material?.dispose();
      mesh.dispose();
    }
    this.scatterMeshes = [];
    this.scatterTypes = [];
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
    material.AddUniform('uHazeColor',   'vec3',      null);   // aerial-perspective tint (= sky/fog colour)
    material.AddUniform('uCloudCoverage', 'float',   null);   // cloud-shadow strength (matches ocean)
    material.AddUniform('uSunDir',        'vec3',    null);   // unit vector toward the sun
    material.AddUniform('uCloudTime',     'float',   null);   // drives cloud-shadow drift

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
      // ── 0. Noise-dithered waterline dissolve ──────────────────────────────
      // The beach edge stipples away into the sea over its first ~1.3 m: a world-space noise
      // discards more pixels the closer they are to the waterline, and the discarded pixels
      // reveal the shallow water behind — so the shoreline cross-fades terrain → sea with a
      // ragged, natural edge instead of a clean line. Stays in the OPAQUE pass (discard, not
      // alpha-blend) so there's no transparent-sorting cost. Faded out just below the
      // waterline so the submerged seabed stays intact in the refraction RTT.
      float dStipple  = fract(sin(dot(floor(vPositionW.xz * 64.0), vec2(127.1, 311.7))) * 43758.5453);
      float dDissolve = (1.0 - smoothstep(0.0, 0.6, vPositionW.y))
                      * smoothstep(-0.25, 0.04, vPositionW.y) * 0.92;
      if (dStipple < dDissolve) { discard; }

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
      // Snow: wavy noise-jittered snowline (not a flat contour), bare on steep
      // faces (snow slides off → rock pokes through), and less on warm/sun-facing
      // aspects. warmDir is FIXED (not the live sun) so snow cover is stable
      // through the day rather than melting/reforming as the sun moves.
      float snowJitter = sin(vPositionW.x * 0.0040 + vPositionW.z * 0.0031) * 0.040
                       + sin(vPositionW.x * 0.0017 - vPositionW.z * 0.0023) * 0.050;
      float snowElev   = clamp((h - (0.66 + snowJitter)) / 0.16, 0.0, 1.0);
      float snowSlope  = clamp(1.0 - slope * 2.2, 0.0, 1.0);
      vec3  warmDir    = normalize(vec3(0.55, 0.35, 0.35));
      float snowAspect = 1.0 - clamp(dot(nW, warmDir), 0.0, 1.0) * 0.55;
      float wSnow   = snowElev * snowSlope * snowAspect;

      // ── 4b. Moisture: low-frequency field (matches CPU terrainMoisture) so wet
      // regions read lush (grass) and dry/exposed regions read barren (gravel/
      // rock). Large ~6–10 km features mean whole islands lean wet or dry, with a
      // smaller octave adding within-island variation.
      float moist = 0.5
        + 0.34 * sin(vPositionW.x * 0.00080 + 1.3)
        + 0.24 * sin(vPositionW.z * 0.00095 - 0.7)
        + 0.18 * sin((vPositionW.x - vPositionW.z) * 0.00060 + 2.1)
        + 0.12 * sin((vPositionW.x * 0.7 + vPositionW.z * 1.1) * 0.0022 - 1.1);
      float wetF = smoothstep(0.25, 0.78, clamp(moist, 0.0, 1.0));
      wGrass  *= 0.35 + 1.30 * wetF;   // lush when wet, sparse when dry
      wGravel *= 1.45 - 0.75 * wetF;   // bare scree dominates dry ground
      wRock   *= 1.25 - 0.40 * wetF;

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

      // ── 8b. Sedimentary strata on steep rock faces ────────────────────────
      // Horizontal banding by elevation (warped so it isn't ruler-straight),
      // gated to steep + rocky surfaces so beaches/meadows stay clean. Reads as
      // layered rock strata, giving cliffs structure instead of flat colour.
      float strataGate = smoothstep(0.18, 0.45, slope) * clamp(wRock + wGravel, 0.0, 1.0);
      if (strataGate > 0.001) {
        float warp  = sin(vPositionW.x * 0.030 + vPositionW.z * 0.021) * 1.6
                    + sin(vPositionW.x * 0.011 - vPositionW.z * 0.014) * 2.4;
        float band1 = sin(vPositionW.y * 0.55 + warp);
        float band2 = sin(vPositionW.y * 1.70 + warp * 0.6);   // finer sub-layers
        float strata = (band1 * 0.7 + band2 * 0.3) * 0.5 + 0.5; // 0..1
        // Subtle banding (~±12%) so it reads as rock character on moderate slopes
        // rather than hard contour lines.
        baseColor.rgb *= mix(1.0, 0.88 + 0.24 * strata, strataGate);
      }

      // ── 8c. Wet sand / tide line ──────────────────────────────────────────
      // Sand near the waterline is damp: darker + slightly desaturated (the main
      // wet-sand cue), with a faint fresnel sheen toward the sky colour to fake
      // the wet gloss. Strongest at the water, fading up the beach over ~3.5 m;
      // the ocean's shoreline foam sits on top of this band.
      // Only darken the wet sand ABOVE the waterline. Below it, the seabed is darkened by the
      // ocean's own shallow shading; double-darkening it there makes the submerged sand read
      // darker than this wet band and leaves a line at the seam. belowFade kills it underwater
      // so both sides land on the same tone where they meet.
      float wetBand = (1.0 - smoothstep(0.0, 3.5, vPositionW.y))
                    * smoothstep(-1.0, 0.3, vPositionW.y) * wSand;
      if (wetBand > 0.001) {
        float wetLum = dot(baseColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3  wetCol = mix(baseColor.rgb, vec3(wetLum), 0.25) * 0.82;  // lightly damp (was 0.62 — too dark, made the dissolve stipple read as black specks)
        baseColor.rgb = mix(baseColor.rgb, wetCol, wetBand);
        vec3  Vw   = normalize(vEyePosition.xyz - vPositionW);
        float fres = pow(1.0 - clamp(dot(Vw, nW), 0.0, 1.0), 4.0);
        baseColor.rgb += uHazeColor * (fres * wetBand * 0.35);             // wet sheen
      }

      // ── 8d. Forest canopy (fakes dense forest as terrain shading) ─────────
      // Replaces the 42k 3-D tree instances that were the entire FPS bottleneck.
      // Forests are only ever seen from hundreds of metres away, so a shaded green
      // canopy painted on the hillside is indistinguishable from individual trees —
      // at zero mesh / zero shadow-caster cost. Wooded where mid-elevation + gentle
      // slope + moist, broken into organic clumps with bare gaps.
      float fElev  = smoothstep(0.045, 0.11, h) * (1.0 - smoothstep(0.60, 0.72, h));
      float fSlope = clamp(1.0 - slope * 1.45, 0.0, 1.0);
      float fMoist = smoothstep(0.30, 0.60, moist);
      float fpw = sin(vPositionW.x * 0.0021 + vPositionW.z * 0.0013)
                + sin(vPositionW.z * 0.0026 - vPositionW.x * 0.0009 + 2.0)
                + sin((vPositionW.x + vPositionW.z) * 0.0015 - 1.0);
      float fPatch  = smoothstep(-0.2, 1.1, fpw);
      float forestF = clamp(fElev * fSlope * fMoist * fPatch, 0.0, 1.0);

      if (forestF > 0.003) {
        // Canopy colour: deep green, mottled by a finer clump noise, greener when wet.
        float mott = sin(vPositionW.x * 0.045) * sin(vPositionW.z * 0.045) * 0.5 + 0.5;
        vec3  canopyDark = mix(vec3(0.07, 0.15, 0.06), vec3(0.10, 0.20, 0.07), wetF);
        vec3  canopyLit  = mix(vec3(0.14, 0.27, 0.11), vec3(0.20, 0.34, 0.14), wetF);
        vec3  canopyCol  = mix(canopyDark, canopyLit, mott);
        baseColor.rgb = mix(baseColor.rgb, canopyCol, forestF * 0.94);

        // Lumpy canopy normal so treetops catch the sun and valleys self-shade —
        // dimensional forest relief with no shadow map. Gradient of a mid-freq noise.
        vec2  cq  = vPositionW.xz * 0.085;
        float c0  = sin(cq.x) * sin(cq.y);
        float cgx = (sin(cq.x + 0.15) * sin(cq.y) - c0) / 0.15;
        float cgz = (sin(cq.x) * sin(cq.y + 0.15) - c0) / 0.15;
        normalW = normalize(normalW + vec3(-cgx, 0.0, -cgz) * (forestF * 0.5));
      }

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

      // Tiled normal detail, scaled UP on steep slopes so cliffs/rock faces read
      // rugged while gentle ground stays smooth. (The old "moving stripe" bug was
      // shadow self-shadowing — fixed by removing the terrain as a shadow caster —
      // not these normals, so they're safe to restore.)
      float normStrength = mix(0.28, 0.66, smoothstep(0.12, 0.45, slope));
      normalW = normalize(normalW + tileNorm * normStrength);

      // ── 9b. Fine micro-detail normal (near-field) ─────────────────────────
      // The terrain mesh is too coarse for real sub-metre geometry, so we fake
      // it: a high-frequency ground-normal sample (XZ-planar, reused as a generic
      // detail layer) perturbs normalW everywhere at low strength, so close-up
      // ground reads as subtly bumpy instead of glassy-smooth. Faded out with
      // distance to avoid shimmer/aliasing and keep the cost near the camera.
      float detFade = 1.0 - smoothstep(70.0, 380.0, length(vPositionW - vEyePosition.xyz));
      if (detFade > 0.001) {
        vec3 detN1 = texture2D(uGrassNor, vPositionW.xz * 0.60).rgb * 2.0 - 1.0;
        vec3 detN2 = texture2D(uRockNor,  vPositionW.xz * 1.30).rgb * 2.0 - 1.0;
        vec3 detWorld = normalize(
            vec3(detN1.r, detN1.b, detN1.g) * 0.6 +
            vec3(detN2.r, detN2.b, detN2.g) * 0.4
        );
        normalW = normalize(normalW + detWorld * (0.24 * detFade));
      }
    `);

    // ── Aerial perspective (distance haze) ────────────────────────────────────
    // Applied AFTER lighting (Fragment_Before_FragColor) so the haze is a uniform
    // atmospheric tint rather than something the terrain's own shading/shadows
    // modulate. Far terrain fades toward the sky/fog colour, giving depth and
    // scale; near terrain is untouched. Exponential ramp tuned for the few-hundred-
    // metre → few-kilometre range we actually view at (the scene's global EXP2 fog
    // only bites at ~20 km, far too distant to shape the mountains).
    material.Fragment_Before_FragColor(`
      // ── Cloud shadows (match the ocean's drifting dappled shadow exactly) ──────
      // Same projection + value-noise field + drift as ocean.service so shadows line
      // up across the shoreline. Applied to the lit colour, before the distance haze.
      if (uSunDir.y > 0.03 && uCloudCoverage > 0.02) {
        vec2 cuv = (vPositionW.xz + uSunDir.xz / max(uSunDir.y, 0.2) * 900.0) * 0.004;
        vec2 cdr = vec2(uCloudTime * 0.18, uCloudTime * 0.12);
        vec2 i0 = floor(cuv + cdr);     vec2 f0 = fract(cuv + cdr);
        vec2 i1 = floor(cuv*2.3 - cdr*1.7); vec2 f1 = fract(cuv*2.3 - cdr*1.7);
        // hash-based value noise (matches ocean rVNoise character)
        #define VCH(p) fract(sin(dot((p), vec2(127.1,311.7))) * 43758.5453)
        f0 = f0*f0*(3.0-2.0*f0); f1 = f1*f1*(3.0-2.0*f1);
        float n0 = mix(mix(VCH(i0),VCH(i0+vec2(1.,0.)),f0.x), mix(VCH(i0+vec2(0.,1.)),VCH(i0+vec2(1.,1.)),f0.x), f0.y);
        float n1 = mix(mix(VCH(i1),VCH(i1+vec2(1.,0.)),f1.x), mix(VCH(i1+vec2(0.,1.)),VCH(i1+vec2(1.,1.)),f1.x), f1.y);
        float cf = n0 * 0.6 + n1 * 0.4;
        float cShadow = smoothstep(0.60 - uCloudCoverage * 0.45, 0.70 - uCloudCoverage * 0.30, cf);
        cShadow *= uCloudCoverage * smoothstep(0.03, 0.18, uSunDir.y);
        color.rgb *= 1.0 - cShadow * 0.55;
      }

      float hazeDist = length(vPositionW - vEyePosition.xyz);
      // Lower density (0.00034→0.00020) + a pow(1.4) shaping push the haze ONSET much
      // farther out, so near/mid islands keep their colour & saturation (they were
      // washing toward the fog tint — grey/orange at dawn, desaturated by day — by ~1 km).
      // The high cap (0.96) still lets the MOST distant terrain melt into the sky for a
      // soft hazy silhouette rather than a hard edge.
      float hazeRaw = 1.0 - exp(-hazeDist * 0.00020);
      float hazeF   = clamp(pow(hazeRaw, 1.4), 0.0, 0.96);
      color.rgb = mix(color.rgb, uHazeColor, hazeF);
    `);

    // ── Bind uniforms every draw call ─────────────────────────────────────────
    material.onBindObservable.add(() => {
      const fx = material.getEffect();
      if (!fx) return;
      fx.setFloat('uPeakH', peakH);
      // Haze tint tracks the current sky/fog colour (day/dusk/night/storm aware).
      fx.setColor3('uHazeColor', scene.fogColor);
      // Cloud shadows — pull the SAME coverage, sun dir and clock the ocean uses so the
      // dappled shadows line up exactly across the water/land boundary.
      fx.setVector3('uSunDir', this.sceneService.getSunDirection());
      fx.setFloat('uCloudCoverage', this.oceanService.getCloudCoverage());
      fx.setFloat('uCloudTime', this.oceanService.getOceanTime());
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

  /** Low-frequency moisture field in [0,1] — MUST match the GLSL `moist` in the
   *  terrain material so vegetation (trees) clusters where the shader paints lush
   *  grass. Wet valleys → 1, dry exposed ground → 0. */
  private terrainMoisture(wx: number, wz: number): number {
    const m = 0.5
      + 0.34 * Math.sin(wx * 0.00080 + 1.3)
      + 0.24 * Math.sin(wz * 0.00095 - 0.7)
      + 0.18 * Math.sin((wx - wz) * 0.00060 + 2.1)
      + 0.12 * Math.sin((wx * 0.7 + wz * 1.1) * 0.0022 - 1.1);
    return this.clamp01(m);
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
