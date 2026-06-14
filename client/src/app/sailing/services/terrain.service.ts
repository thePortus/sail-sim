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
  RawTexture,
  RawTexture2DArray,
  Vector2,
  Vector3,
  Vector4,
  Constants,
} from '@babylonjs/core';
import type { WebGPUEngine } from '@babylonjs/core';
import { CustomMaterial, PBRCustomMaterial } from '@babylonjs/materials';
import { TerrainClipmap } from './terrain/terrain-clipmap';
import { TerrainShadowCompute } from './terrain/terrain-shadow-compute';
import { ShoreMapCompute } from './terrain/shore-map-compute';
import { Settings } from '../../app.settings';
import { TerrainManifest, TerrainWorldBounds, TerrainHarbor } from '../models';
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
  /** Quantized value of the waterline (y = 0); 0 for legacy land-only manifests. See init(). */
  private waterlineQ = 0;
  /** True while the terrain renders into the ocean's seabed (refraction) RTT — the ragged-waterline
   *  discard is switched off there so the revealed seabed stays solid (no clear-colour speckles). */
  private _inRefractionPass = false;
  /** Guards against re-registering the refraction-pass observers on every clipmap rebuild (PBR toggle). */
  private _refractionObserversWired = false;
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
  private terrainMaterialPBR: PBRCustomMaterial | null = null;   // S0 spike: ?terrainpbr path
  // S1b: biome PBR texture arrays (5 layers: 0 sand,1 grass,2 gravel,3 rock,4 snow). One sampler each
  // (vs 5 per map) → fixes the 16-sampler cap. albedo = RGB diffuse; orm = R roughness, G ambient-occl.
  private biomeAlbedoArr: RawTexture2DArray | null = null;
  private biomeOrmArr: RawTexture2DArray | null = null;
  private biomePlaceholderArr: RawTexture2DArray | null = null;
  private splatTex: Texture | null = null;   // S2 control/splat map (RGBA soft biome weights, world-aligned)
  private auxTex: Texture | null = null;     // S4 aux map (R slope, G shoreDist, B wetness, A flow), world-aligned
  private static readonly BIOME_TILES = ['sand', 'grass', 'gravel', 'rock', 'snow'];
  // S3 anti-tiling: the ALBEDO array packs 3 extra variant layers (5/6/7) that the shader cross-fades
  // with the matching core layer over a large-scale noise so no single tile visibly repeats. The ORM
  // array stays at the 5 core layers (variants reuse the base roughness/AO).
  private static readonly ALBEDO_LAYERS = ['sand', 'grass', 'gravel', 'rock', 'snow', 'sand2', 'grass2', 'rock2'];
  private terrainTextures: Texture[] = [];
  private treePrototypeMeshes: Mesh[] = [];
  private treePatches: TreePatch[] = [];
  private treeInstances: InstancedMesh[] = [];
  private treeCullingObserver: any = null;
  private scatterMeshes: Mesh[] = [];   // thin-instanced ground scatter prototypes
  private scatterTypes: ScatterType[] = [];
  private scatterObserver: any = null;
  private terrainShadowTexture: DynamicTexture | null = null;
  private terrainShadowCompute: TerrainShadowCompute | null = null;   // WebGPU path (roadmap P1)
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
      // Quantized waterline level (y = 0). For the signed unified field the waterline sits at a
      // positive quantized value (minElevation < 0); legacy land-only manifests store ocean as 0.
      this.waterlineQ = (manifest.minElevation != null && manifest.maxElevation != null)
        ? Math.round(((0 - manifest.minElevation) / (manifest.maxElevation - manifest.minElevation)) * manifest.quantizationLevels)
        : 0;
      this.heightfield = new Uint16Array(manifest.width * manifest.height);
      await this.loadAllChunks();
      // Grade beaches and compute coastal distance data while heightfield
      // is still fresh.  Must run before buildTerrainMesh so that
      // getElevation(), tree placement, and the mesh all see consistent values.
      this.coastData = this.applyCoastalGrading();
    }

    this.buildTerrainMesh();

  }

  // ── Terrain clipmap (camera-centric LoD, GPU displacement + Sobel normals) ───
  private clipmap: TerrainClipmap | null = null;
  private clipmapObserver: import('@babylonjs/core').Observer<Scene> | null = null;

  /** Build the camera-centric clipmap and render it with the terrain material in clipmap mode
   *  (vertex height displacement + fragment Sobel normals). This IS the terrain render — no static
   *  ground mesh. Enrolls each ring in the ocean RTTs so the seabed feeds the water transparency. */
  private buildClipmap(): void {
    const scene = this.sceneService.scene;
    const cam = this.sceneService.camera;
    const m = this.manifest;
    if (!scene || !cam || !m || !this.heightfield) { return; }

    // Dispose any prior clipmap (e.g. a quality-driven rebuild).
    if (this.clipmapObserver) { scene.onBeforeRenderObservable.remove(this.clipmapObserver); this.clipmapObserver = null; }
    this.clipmap?.dispose();
    this.clipmap = null;

    // PBRCustomMaterial terrain skin (aux-driven PBR) is now the DEFAULT; the Standard skin remains
    // as a fallback ("Off" in Settings → Graphics, persisted in localStorage). URL escape hatches for
    // debugging override the setting: `?noterrainpbr` forces Standard, `?terrainpbr` forces PBR.
    // (Check `noterrainpbr` first — it contains the substring `terrainpbr`.)
    const usePBR = this.isTerrainPBREnabled();
    const mat = usePBR ? this.buildTerrainMaterialPBR(scene, m) : this.buildTerrainMaterial(scene, m, true);
    mat.zOffset = 4;                                          // nudge behind the ocean surface at the waterline

    // Publish the heightfield so the volumetric clouds can march it for terrain occlusion (the clipmap
    // displaces in the vertex shader, which the depth renderers can't see → clouds need the heights).
    // Brokered via scene.metadata so neither service has to depend on the other.
    const meta = (scene.metadata = scene.metadata || {});
    meta.terrainHeightField = this.clipHeightTex ? {
      tex: this.clipHeightTex, bounds: this.clipWBounds, texSize: this.clipTexSize,
      maxAlt: m.maxElevation ?? m.targetPeakElevation,
    } : null;

    this.clipmap = new TerrainClipmap(cam, scene);
    this.clipmap.setMaterial(mat);
    this.clipmap.initializeMeshes();
    this.clipmap.update();
    // Enroll every clipmap mesh in the ocean RTTs (the submerged seabed feeds the depth-based water
    // transparency + refraction + reflection) and exclude from glow. receiveShadows is set in the
    // clipmap; the terrain intentionally does NOT cast shadows (see the old note — self-shadow moiré).
    for (const cm of this.clipmap.allMeshes()) {
      this.oceanService.addToRenderList(cm);
      this.sceneService.excludeFromGlow(cm);
    }

    this.clipmapObserver = scene.onBeforeRenderObservable.add(() => this.sceneService.span('clipmap', () => this.clipmap?.update()));
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
    this.terrainShadowCompute?.dispose();
    this.terrainShadowCompute = null;
    if (this.shoreMapObserver) {
      this.sceneService.scene.onBeforeRenderObservable.remove(this.shoreMapObserver);
      this.shoreMapObserver = null;
    }
    this.shoreMapTexture?.dispose();
    this.shoreMapTexture = null;
    this.shoreMapCompute?.dispose();
    this.shoreMapCompute = null;
    this.shoreLastCx = Infinity;
    this.shoreLastCz = Infinity;
    if (this.clipmapObserver) {
      this.sceneService.scene.onBeforeRenderObservable.remove(this.clipmapObserver);
      this.clipmapObserver = null;
    }
    this.clipmap?.dispose();
    this.clipmap = null;
    this.terrainMesh?.dispose();
    this.terrainMesh = null;
    this.terrainMaterial?.dispose();
    this.terrainMaterial = null;
    for (const texture of this.terrainTextures) {
      texture.dispose();
    }
    this.terrainTextures = [];

    // S1b PBR terrain: these are GPU resources bound to the CURRENT engine, and loadBiomeArrays()
    // early-returns when biomeAlbedoArr is already set. If we don't dispose AND null them here, a
    // return-to-harbour (which disposes the engine) leaves the next session reusing dead-engine
    // texture arrays → "TextureViewDimension::e2D doesn't match expected e2DArray" + a cascade of
    // Invalid BindGroup errors in the prePass / ocean-reflection passes. Null so init() rebuilds.
    this.biomeAlbedoArr?.dispose();      this.biomeAlbedoArr = null;
    this.biomeOrmArr?.dispose();         this.biomeOrmArr = null;
    this.biomePlaceholderArr?.dispose(); this.biomePlaceholderArr = null;
    this.terrainMaterialPBR?.dispose();  this.terrainMaterialPBR = null;
    this.splatTex = null;   // disposed above via terrainTextures; null so it isn't reused stale
    this.auxTex = null;
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

  /** Harbor towns detected during terrain generation (manifest.harbors). Empty array if none. */
  getHarbors(): TerrainHarbor[] {
    return this.manifest?.harbors ?? [];
  }

  getElevation(worldX: number, worldZ: number): number {
    if (!this.manifest || !this.heightfield) return 0;

    const { width, height, worldBounds, quantizationLevels, targetPeakElevation } = this.manifest;
    // Sample with the EXACT texel convention the GPU clipmap uses (`uv * texSize - 0.5`, then floor +
    // fract + per-tap edge clamp). The old `uv * (width-1)` mapping differed from the GPU by `(uv-0.5)`
    // texels — zero at the map centre, ±½ texel toward the edges — so scattered trees/rocks placed via
    // this height drifted off the rendered surface (floating / sunk) away from centre. Matching the GPU
    // here keeps every placement flush with the terrain the player actually sees.
    const ux = (worldX - worldBounds.minX) / (worldBounds.maxX - worldBounds.minX);
    const uz = (worldBounds.maxZ - worldZ) / (worldBounds.maxZ - worldBounds.minZ);
    const px = ux * width - 0.5;
    const pz = uz * height - 0.5;

    const fx0 = Math.floor(px);
    const fz0 = Math.floor(pz);
    // Per-tap clamp to [0, size-1] (GPU clamps i0 and i0+1 independently); weights use the UNCLAMPED
    // fract so the interpolation matches texelFetch + fract(tc) exactly.
    const x0 = Math.min(width - 1,  Math.max(0, fx0));
    const x1 = Math.min(width - 1,  Math.max(0, fx0 + 1));
    const z0 = Math.min(height - 1, Math.max(0, fz0));
    const z1 = Math.min(height - 1, Math.max(0, fz0 + 1));

    const tx = px - fx0;
    const tz = pz - fz0;

    const h00 = this.sampleQuantized(x0, z0);
    const h10 = this.sampleQuantized(x1, z0);
    const h01 = this.sampleQuantized(x0, z1);
    const h11 = this.sampleQuantized(x1, z1);

    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    const hq = h0 + (h1 - h0) * tz;

    // Signed unified field (real-data regions): decode across [minElevation, maxElevation] so the
    // seabed (negative) and land (positive) share one continuous field. Legacy PNG manifests have no
    // minElevation and decode land-only 0..targetPeakElevation.
    const { minElevation, maxElevation } = this.manifest;
    if (minElevation != null && maxElevation != null) {
      return (hq / quantizationLevels) * (maxElevation - minElevation) + minElevation;
    }
    return (hq / quantizationLevels) * targetPeakElevation;
  }

  /** NEAREST-texel elevation — one heightfield read + decode, NO bilinear interpolation (~3–4× cheaper
   *  than getElevation). For SCATTER GATING (elevation-band + slope rejection) where sub-cell precision
   *  doesn't matter; an accepted instance's FINAL placement Y still uses getElevation so it sits flush on
   *  slopes. Same texel convention as getElevation (uv·size − 0.5, rounded) so the two agree at texel centres. */
  getElevationFast(worldX: number, worldZ: number): number {
    const m = this.manifest;
    if (!m || !this.heightfield) return 0;
    const ux = (worldX - m.worldBounds.minX) / (m.worldBounds.maxX - m.worldBounds.minX);
    const uz = (m.worldBounds.maxZ - worldZ) / (m.worldBounds.maxZ - m.worldBounds.minZ);
    const x = Math.round(ux * m.width  - 0.5);
    const z = Math.round(uz * m.height - 0.5);
    const hq = this.sampleQuantized(x, z);   // clamps to edge internally
    return m.minElevation != null && m.maxElevation != null
      ? (hq / m.quantizationLevels) * (m.maxElevation - m.minElevation) + m.minElevation
      : (hq / m.quantizationLevels) * m.targetPeakElevation;
  }

  /** World metres per heightfield texel (~24 m). Scatter uses this as the slope-sampling baseline so a
   *  NEAREST forward difference spans a full texel (otherwise two nearest samples land in the same cell →
   *  a constant 0 slope). One cell over ≈ the same gradient bilinear gives within a cell, so thresholds carry. */
  getCellSizeM(): number {
    const m = this.manifest;
    return m ? (m.worldBounds.maxX - m.worldBounds.minX) / Math.max(1, m.width - 1) : 24;
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

  /**
   * Spawn a brand-new player just off a random town's pier, facing the town — so the game opens with
   * "arriving at a harbour" rather than empty ocean. The shore point + seaward heading come straight
   * from the detected harbor; we step seaward past the pier (length + approach) into open water and
   * face back toward the pier. Falls back to coastalSpawn() if there are no towns / the spot isn't
   * navigable water.
   */
  harborSpawn(): { spawnX: number; spawnZ: number; heading: number } {
    const harbors = this.getHarbors();
    if (!harbors.length) return this.coastalSpawn();
    return this.spawnOffPier(harbors[Math.floor(Math.random() * harbors.length)]);
  }

  /** Spawn just off the NEAREST town's pier to (worldX, worldZ) — used to respawn a sunk player at the
   *  closest harbor. Falls back to coastalSpawn() if there are no towns. */
  nearestHarborSpawn(worldX: number, worldZ: number): { spawnX: number; spawnZ: number; heading: number } {
    const harbors = this.getHarbors();
    if (!harbors.length) return this.coastalSpawn();
    let best = harbors[0], bestD = Infinity;
    for (const h of harbors) {
      const d = (h.x - worldX) ** 2 + (h.z - worldZ) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    return this.spawnOffPier(best);
  }

  /** A navigable point ~55 m off the seaward end of a town's pier, facing back toward it. */
  private spawnOffPier(h: TerrainHarbor): { spawnX: number; spawnZ: number; heading: number } {
    const hr = (h.heading * Math.PI) / 180;     // seaward direction
    const OFF = 55;                              // m off the shore point — clears the pier + pilings
    const spawnX = h.x + Math.sin(hr) * OFF;
    const spawnZ = h.z + Math.cos(hr) * OFF;
    if (this.isOnLand(spawnX, spawnZ)) return this.coastalSpawn();   // safety
    return { spawnX, spawnZ, heading: (h.heading + 180) % 360 };     // face back toward the pier
  }

  /**
   * Pick a navigable spawn point a short way off a coastline — for brand-new players (no saved
   * location) so they begin "arriving at a shore" instead of marooned in open ocean at (0, 0).
   *
   * Reuses the precomputed water→land distance field (the same one `applyCoastalGrading` builds with a
   * signed-aware waterline test — unlike the broken cove detector that read `hf>0` as land). A good
   * coastal spawn is a WATER cell whose distance to the nearest land sits in a target offshore band
   * (close enough to see/reach the coast, far enough not to run aground) and whose seabed is deep
   * enough to float. One cell is chosen at random from all qualifiers so successive new players are
   * spread around the map's coastlines, and the heading is aimed at the nearest land.
   *
   * Falls back to nearestSpawn(0, 0) if the coast data isn't ready or nothing qualifies.
   */
  coastalSpawn(): { spawnX: number; spawnZ: number; heading: number } {
    const m = this.manifest, hf = this.heightfield, cd = this.coastData;
    if (!m || !hf || !cd) return this.nearestSpawn(0, 0);

    const { width, height, worldBounds, quantizationLevels, minElevation, maxElevation } = m;
    const distL = cd.distToLand;
    const cellSizeM = cd.cellSizeM;

    const signed = minElevation != null && maxElevation != null;
    const waterQ = signed
      ? Math.round(((0 - minElevation!) / (maxElevation! - minElevation!)) * quantizationLevels)
      : 0;
    const isWater = (q: number) => (signed ? q <= waterQ : q === 0);
    // Decode a quantized cell to elevation (m). Only meaningful for the signed field (legacy water = 0).
    const elevOf = (q: number) => signed
      ? (q / quantizationLevels) * (maxElevation! - minElevation!) + minElevation!
      : 0;

    // Offshore band + minimum navigable depth.
    const MIN_OFF_M = 60, MAX_OFF_M = 180, MIN_DEPTH_M = 1.5;
    const minCells = Math.max(1, Math.round(MIN_OFF_M / cellSizeM));
    const maxCells = Math.max(minCells + 1, Math.round(MAX_OFF_M / cellSizeM));

    // Collect qualifying water cells (coarse stride bounds cost + reduces clustering).
    const STRIDE = 2;
    const cands: number[] = [];
    for (let z = 1; z < height - 1; z += STRIDE) {
      for (let x = 1; x < width - 1; x += STRIDE) {
        const i = z * width + x;
        const d = distL[i];
        if (d < minCells || d > maxCells) continue;     // outside the offshore band
        const q = hf[i];
        if (!isWater(q)) continue;                       // not navigable water
        if (signed && elevOf(q) > -MIN_DEPTH_M) continue; // too shallow (bar/reef) to float
        cands.push(i);
      }
    }
    if (!cands.length) return this.nearestSpawn(0, 0);

    const cell = cands[Math.floor(Math.random() * cands.length)];
    const cx = cell % width;
    const cz = Math.floor(cell / width);
    const cellToWorld = (ix: number, iz: number) => ({
      x: worldBounds.minX + (ix / (width  - 1)) * (worldBounds.maxX - worldBounds.minX),
      z: worldBounds.maxZ - (iz / (height - 1)) * (worldBounds.maxZ - worldBounds.minZ),
    });
    const { x: spawnX, z: spawnZ } = cellToWorld(cx, cz);

    // Heading: face the nearest land. Cast rays in cell space; the direction whose first land hit is
    // closest wins. Cell +x → world +X; cell +z → world -Z (worldZ = maxZ - iz·range), so a cell-space
    // ray dir (dxc, dzc) toward land maps to world heading atan2(dxc, -dzc).
    let heading = 270, bestLand = Infinity;
    const RAYS = 16, reach = maxCells + minCells;
    for (let r = 0; r < RAYS; r++) {
      const a = (r / RAYS) * Math.PI * 2;
      const dxc = Math.cos(a), dzc = Math.sin(a);
      for (let s = 1; s <= reach; s++) {
        const nx = Math.round(cx + dxc * s), nz = Math.round(cz + dzc * s);
        if (nx < 0 || nx >= width || nz < 0 || nz >= height) break;
        if (!isWater(hf[nz * width + nx])) {             // first land along this ray
          if (s < bestLand) { bestLand = s; heading = (Math.atan2(dxc, -dzc) * 180 / Math.PI + 360) % 360; }
          break;
        }
      }
    }

    return { spawnX, spawnZ, heading };
  }

  private buildTerrainMesh(): void {
    const scene = this.sceneService.scene;
    const manifest = this.manifest;
    if (!scene || !manifest || !this.heightfield) return;

    this.disposeFoliage();

    // The terrain renders as a camera-centric CLIPMAP — flat LOD-ring grids displaced and
    // normal-mapped on the GPU from the heightfield texture — replacing the old static 1500²-cap
    // ground mesh (detail follows the player: crisp near, cheap to the horizon). buildClipmap()
    // also enrolls the rings in the ocean RTTs and sets receiveShadows / glow exclusion. The terrain
    // is intentionally NOT a shadow caster (self-shadow moiré at this world scale); large-scale
    // terrain shadows come from the raymarched terrainShadowMask below.
    this.buildClipmap();
    // Let the scene occlude the sun against our heightfield (stops the sun disk
    // shining through mountains at dawn/dusk).
    this.sceneService.setTerrainHeightSampler((x, z) => this.getElevation(x, z));
    // Distant forests = the green CANOPY painted into the terrain shader (§8d). Beach palms (and
    // now inland forest trees) are handled by the new camera-following ScatterService (thin
    // instances + LoD + quality tiers), so the old per-patch beach-palm system is retired here.
    // this.buildBeachPalms(scene, manifest);   // → ScatterService 'scatter_palms' layer
    // Ground scatter (rocks/grass/driftwood/dead trees) is implemented but
    // DISABLED pending a live debug: placement works (instances are created with
    // valid positions, per console logs) but nothing renders via either thin
    // instances or InstancedMesh — needs in-scene inspection to diagnose.
    // To re-enable: this.buildGroundScatter(scene, manifest);
    this.setupTerrainShadowMask(scene);
    this.setupShoreMap(scene);
  }

  private setupTerrainShadowMask(scene: Scene): void {
    if (this.terrainShadowTexture || this.terrainShadowCompute) return;

    // Apply persisted quality before the first update runs.
    const saved = parseInt(localStorage.getItem('shadow-quality') ?? '2', 10);
    this.applyQualityLevel(saved);

    // WebGPU: raymarch the mask in a compute shader over the GPU-resident heightfield
    // (clipHeightTex) — the CPU version below costs ~360k heightfield samples + canvas
    // ImageData churn per update, and its output is only ever consumed by the GPU.
    // A/B escape hatch: localStorage.setItem('ignis_shadow_gpu','0') + reload forces the
    // CPU path on WebGPU for same-spot FPS comparisons.
    if (this.sceneService.isWebGPU && localStorage.getItem('ignis_shadow_gpu') !== '0') {
      this.terrainShadowCompute = new TerrainShadowCompute(
        scene.getEngine() as WebGPUEngine, this.TERRAIN_SHADOW_RES,
      );
      // Publish synchronously before the first dispatch — same reason as the shore map: the FFT
      // ocean material bakes its shadow define at build time from whether a mask exists. Strength 0
      // keeps the (zero-initialized) contents inert until the first real dispatch lands.
      const cam0 = this.sceneService.camera;
      this.oceanService.setTerrainShadowMask(
        this.terrainShadowCompute.texture, cam0?.position.x ?? 0, cam0?.position.z ?? 0,
        this.TERRAIN_SHADOW_WORLD_SIZE, 0,
      );
      this.updateTerrainShadowMaskGPU();
      this.terrainShadowObserver = scene.onBeforeRenderObservable.add(() => {
        this.terrainShadowFrame++;
        if (this.terrainShadowFrame % this.terrainShadowUpdateEvery !== 0) return;
        this.updateTerrainShadowMaskGPU();
      });
      return;
    }

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

  // Skip-when-static gating: the mask covers a 7 km window at ~55 m/texel, so re-raymarching
  // it (CPU or GPU) is pointless until the camera has drifted a texel's worth or the sun has
  // visibly moved. Anchored at a town with a slow sun this drops updates from ~15/s to ~1/s.
  private shadowLastCx = Infinity;
  private shadowLastCz = Infinity;
  private shadowLastSunDir = new Vector3(0, 0, 0);

  private terrainShadowStale(cx: number, cz: number, dir: Vector3 | null): boolean {
    if (Math.abs(cx - this.shadowLastCx) > 40 || Math.abs(cz - this.shadowLastCz) > 40) return true;
    return dir !== null && Vector3.DistanceSquared(dir, this.shadowLastSunDir) > 0.004 * 0.004;
  }

  private noteTerrainShadowUpdated(cx: number, cz: number, dir: Vector3 | null): void {
    this.shadowLastCx = cx;
    this.shadowLastCz = cz;
    if (dir) this.shadowLastSunDir.copyFrom(dir);
  }

  /** GPU twin of updateTerrainShadowMask: same sun gating + strength curve, compute dispatch
   *  instead of the CPU raymarch. clipHeightTex may not exist yet on the first ticks (it is
   *  created with the terrain material) — we simply retry on the next cadence tick. */
  private updateTerrainShadowMaskGPU(): void {
    const gpu = this.terrainShadowCompute;
    const camera = this.sceneService.camera;
    if (!gpu || !camera || !this.clipHeightTex) return;

    const sun = this.sceneService.scene.lights.find(
      (l): l is DirectionalLight => l instanceof DirectionalLight && l.name === 'sun',
    );

    const cx = camera.position.x;
    const cz = camera.position.z;
    const size = this.TERRAIN_SHADOW_WORLD_SIZE;

    const sunDir = sun ? sun.direction.normalizeToNew() : null;
    if (!this.terrainShadowStale(cx, cz, sunDir)) return;

    // Quality off / sun down: strength 0 makes the ocean ignore the mask contents entirely
    // (terrainShadow = mask * strength), so no clear dispatch is needed.
    if (this.shadowQualityLevel === 0 || !sunDir || sunDir.y >= -0.01) {
      this.oceanService.setTerrainShadowMask(gpu.texture, cx, cz, size, 0);
      this.noteTerrainShadowUpdated(cx, cz, sunDir);
      return;
    }

    const rayRisePerMeter = Math.max(0.015, -sunDir.y);

    const ok = gpu.update(
      this.clipHeightTex, this.clipWBounds, this.clipTexSize,
      cx, cz, size, -sunDir.x, -sunDir.z, rayRisePerMeter, this.terrainShadowSteps,
    );
    if (!ok) return;   // compute shader still compiling — retry next tick (stays stale)

    const strength = Math.max(0.25, Math.min(0.9, 0.25 + (1 - Math.max(0, rayRisePerMeter)) * 0.45));
    this.oceanService.setTerrainShadowMask(gpu.texture, cx, cz, size, strength);
    this.noteTerrainShadowUpdated(cx, cz, sunDir);
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

    const sunDirCheck = sun ? sun.direction.normalizeToNew() : null;
    if (!this.terrainShadowStale(cx, cz, sunDirCheck)) return;
    this.noteTerrainShadowUpdated(cx, cz, sunDirCheck);

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
    if (this.shoreMapTexture || this.shoreMapCompute) return;

    // WebGPU: land scan + proximity search in a compute shader over the GPU-resident heightfield
    // (roadmap P2) — the CPU version below costs ~1M array ops + canvas churn per update. The CPU
    // buoyancy twin (_shoreProx) is refreshed by a small async readback of the same texture, so
    // hull shoaling keeps reading the exact data the vertex shader samples.
    // A/B escape hatch: localStorage.setItem('ignis_shore_gpu','0') + reload forces the CPU path.
    if (this.sceneService.isWebGPU && localStorage.getItem('ignis_shore_gpu') !== '0') {
      this.shoreMapCompute = new ShoreMapCompute(
        scene.getEngine() as WebGPUEngine, this.SHORE_MAP_RES,
      );
      // Publish the texture to the ocean SYNCHRONOUSLY, before the first dispatch. The FFT ocean
      // material bakes '#define HAS_SHORE' (shoaling + refraction) at build time from whether a
      // shore map EXISTS — the CPU path always registered one here, synchronously. Waiting for the
      // async compute-shader compile would let the FFT material build WITHOUT shoaling (waves wash
      // over towns). Content is deterministically black until the first dispatch (WebGPU zero-
      // initializes textures), which just means "open water" for the first few frames.
      const cam0 = this.sceneService.camera;
      this.oceanService.setShoreMap(
        this.shoreMapCompute.texture, cam0?.position.x ?? 0, cam0?.position.z ?? 0,
        this.SHORE_MAP_WORLD_SIZE, (x, z) => this.shoreProximityAt(x, z),
      );
      this.updateShoreMapGPU();
      this.shoreMapObserver = scene.onBeforeRenderObservable.add(() => {
        this.shoreMapFrame++;
        if (this.shoreMapFrame % 10 !== 0) return;
        this.updateShoreMapGPU();
      });
      return;
    }

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

  /** GPU twin of updateShoreMap: one compute dispatch + an async readback for the CPU shoaling
   *  sampler. Skips entirely while the camera sits still (the map depends only on camera x/z). */
  private updateShoreMapGPU(): void {
    const gpu = this.shoreMapCompute;
    const camera = this.sceneService.camera;
    const m = this.manifest;
    if (!gpu || !camera || !m || !this.clipHeightTex) return;

    const cx = camera.position.x;
    const cz = camera.position.z;
    const size = this.SHORE_MAP_WORLD_SIZE;
    const res = this.SHORE_MAP_RES;

    // Static skip: half a texel (~8 m) of drift can't change any texel's land/water rounding.
    if (this._shoreProx && Math.abs(cx - this.shoreLastCx) < 8 && Math.abs(cz - this.shoreLastCz) < 8) return;

    // The quantized land test (hf > waterlineQ) as an exact metre threshold against the
    // dequantized height texture: anything at or below the waterline quantum is water.
    const minE = m.minElevation ?? 0;
    const maxE = m.maxElevation ?? m.targetPeakElevation;
    const qSpan = (maxE - minE) / (m.quantizationLevels || 65535);
    const landThreshold = (this.waterlineQ + 0.5) * qSpan + minE;

    const ok = gpu.update(this.clipHeightTex, this.clipWBounds, this.clipTexSize, cx, cz, size, landThreshold);
    if (!ok) return;   // compute shader still compiling — retry next tick
    this.shoreLastCx = cx;
    this.shoreLastCz = cz;

    this.oceanService.setShoreMap(gpu.texture, cx, cz, size, (x, z) => this.shoreProximityAt(x, z));

    // Refresh the CPU twin from the texture we just wrote (one in-flight readback at a time; it
    // lands 1–2 frames later, harmless for shoaling). Window params are committed WITH the data
    // so shoreProximityAt never mixes a new centre with old contents.
    if (this.shoreReadbackPending) return;
    this.shoreReadbackPending = true;
    gpu.texture.readPixels(undefined, undefined, undefined, undefined, true)?.then((buf) => {
      const px = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      if (!this._shoreProx || this._shoreProx.length !== res * res) this._shoreProx = new Float32Array(res * res);
      // The kernel stores rows Y-flipped (texture v=1 = north, matching the DynamicTexture
      // convention); shoreProximityAt indexes rows north-first — un-flip while copying.
      for (let py = 0; py < res; py++) {
        const src = (res - 1 - py) * res;
        const dst = py * res;
        for (let x = 0; x < res; x++) this._shoreProx[dst + x] = px[(src + x) * 4] / 255;
      }
      this._shoreProxCX = cx; this._shoreProxCZ = cz; this._shoreProxSize = size; this._shoreProxRes = res;
      this.shoreReadbackPending = false;
    }).catch(() => { this.shoreReadbackPending = false; });
  }

  private shoreMapCompute: ShoreMapCompute | null = null;   // WebGPU path (roadmap P2)
  private shoreLastCx = Infinity;
  private shoreLastCz = Infinity;
  private shoreReadbackPending = false;

  // Returns true if the raw heightfield cell nearest to (wx, wz) is land.
  // Uses nearest-neighbour sampling (one Uint16Array read, zero interpolation)
  // — ~8× faster than getElevation().  Ocean pixels are stored as exactly 0
  // in the quantized heightfield so a simple "> 0" check is reliable.
  private isLandRaw(wx: number, wz: number): boolean {
    const m  = this.manifest!;
    const hf = this.heightfield!;
    const px = Math.round(((wx - m.worldBounds.minX) / (m.worldBounds.maxX - m.worldBounds.minX)) * (m.width  - 1));
    const pz = Math.round(((m.worldBounds.maxZ - wz)  / (m.worldBounds.maxZ - m.worldBounds.minZ)) * (m.height - 1));
    // Land = quantized height strictly above the waterline (waterlineQ is 0 for legacy manifests, a
    // positive level for the signed unified field).
    return hf[Math.max(0, Math.min(m.height - 1, pz)) * m.width + Math.max(0, Math.min(m.width - 1, px))] > this.waterlineQ;
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

    // CPU twin of the texture: the ocean's buoyancy sampler needs the SAME shore proximity the vertex
    // shader reads, so the hull bobs with the shore-attenuated (shoaling-flattened) waves.
    if (!this._shoreProx || this._shoreProx.length !== res * res) { this._shoreProx = new Float32Array(res * res); }
    const prox = this._shoreProx;
    this._shoreProxCX = cx; this._shoreProxCZ = cz; this._shoreProxSize = size; this._shoreProxRes = res;

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

        prox[py * res + px] = encoded;   // CPU copy → ocean buoyancy shore attenuation (see below)
        const v = Math.round(encoded * 255);
        data[ptr++] = v;    // R channel
        data[ptr++] = 0;    // G
        data[ptr++] = 0;    // B
        data[ptr++] = 255;  // A
      }
    }

    ctx.putImageData(imageData, 0, 0);
    texture.update();
    this.oceanService.setShoreMap(texture, cx, cz, size, (x, z) => this.shoreProximityAt(x, z));
  }

  // Backing store for the CPU shore-proximity twin (mirrors the painted shore-map window).
  private _shoreProx: Float32Array | null = null;
  private _shoreProxCX = 0; private _shoreProxCZ = 0; private _shoreProxSize = 1; private _shoreProxRes = 0;

  /** Land proximity at a world point (1 at the waterline → 0 in open water), from the same data the
   *  shore-map texture was painted with. Nearest texel; 0 outside the camera window / before first paint. */
  private shoreProximityAt(x: number, z: number): number {
    const prox = this._shoreProx;
    if (!prox || this._shoreProxRes < 2) { return 0; }
    const res = this._shoreProxRes, half = this._shoreProxSize * 0.5;
    const wpt = this._shoreProxSize / (res - 1);
    const px = Math.round((x - this._shoreProxCX + half) / wpt);
    const py = Math.round((this._shoreProxCZ + half - z) / wpt);
    if (px < 0 || px >= res || py < 0 || py >= res) { return 0; }
    return prox[py * res + px];
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

  // ── Terrain PBR skin (default ON; Standard material is the fallback) ────────

  /** True when the PBR terrain skin should be used. URL flags override the saved setting. */
  isTerrainPBREnabled(): boolean {
    if (typeof location !== 'undefined') {
      if (location.search.includes('noterrainpbr')) { return false; }   // must test before 'terrainpbr'
      if (location.search.includes('terrainpbr'))   { return true; }
    }
    return (localStorage.getItem('ignis_terrain_pbr') ?? '1') !== '0';   // default ON
  }

  /** Toggle the PBR terrain skin. Persists, then rebuilds the clipmap live with the new material. */
  setTerrainPBREnabled(enabled: boolean): void {
    localStorage.setItem('ignis_terrain_pbr', enabled ? '1' : '0');
    if (this.isReady()) { this.buildClipmap(); }   // dispose + rebuild with the chosen material
  }

  private applyQualityLevel(level: number): void {
    this.shadowQualityLevel = level;
    this.shadowLastCx = Infinity;   // force the next shadow-mask tick to re-render with the new steps
    switch (level) {
      case 0:  this.terrainShadowSteps =  1; this.terrainShadowUpdateEvery = 999; break;
      case 1:  this.terrainShadowSteps = 12; this.terrainShadowUpdateEvery =   8; break;
      case 2:  this.terrainShadowSteps = 22; this.terrainShadowUpdateEvery =   4; break;
      default: this.terrainShadowSteps = 40; this.terrainShadowUpdateEvery =   1; break;
    }
    // Also drive the cascaded shadow MAP (was previously never wired to this slider).
    this.sceneService.setShadowMapQuality(level);
    // …and the full-screen ocean depth pass: every-frame on High, every-other-frame on low/mid tiers.
    this.sceneService.setOceanDepthQuality(level);
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
    this.treeCullingObserver = scene.onBeforeRenderObservable.add(() => this.sceneService.span('treecull', () => this.updateTreePatchVisibility()));
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

    this.scatterObserver = scene.onBeforeRenderObservable.add(() => this.sceneService.span('scatter', () => this.updateScatter()));
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

    this.treeCullingObserver = scene.onBeforeRenderObservable.add(() => this.sceneService.span('treecull', () => this.updateTreePatchVisibility()));
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

  private buildTerrainMaterial(scene: any, manifest: TerrainManifest, clipmap = false): CustomMaterial {
    this.terrainMaterial?.dispose();
    this.terrainMaterial = null;
    this.terrainMaterialPBR?.dispose();
    this.terrainMaterialPBR = null;
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
    material.maxSimultaneousLights = 6;        // forward pass; the prePass UBO budget is governed by scene light count

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
    material.AddUniform('uCloudTime',     'float',   null);   // (legacy) cloud-shadow drift clock
    material.AddUniform('uCloudDrift',    'vec2',    null);   // real cloud wind drift (matches ocean)
    material.AddUniform('uCloudBaseH',    'float',   null);   // real cloud base altitude (matches ocean)
    material.AddUniform('u_waterlineDither', 'float', null);  // 1 = ragged shoreline (main view), 0 = off (refraction RTT)

    // ── Clipmap mode (P4b): GPU height displacement + Sobel normals ──────────────
    // The terrain renders as a camera-centric clipmap of FLAT grids; the heightfield is uploaded as a
    // texture and sampled in the VERTEX shader to displace Y, and in the FRAGMENT shader to recompute
    // the world normal (Sobel) — replacing the baked mesh heights/normals. Manual bilinear via
    // texelFetch (R32F isn't HW-filterable on WebGPU).
    if (clipmap) {
      this.createClipHeightTexture(scene, manifest);
      material.AddUniform('heightTex', 'sampler2D', null);
      material.AddUniform('wbounds',   'vec4', null);   // minX, minZ, sizeX, sizeZ
      material.AddUniform('texSize',   'vec2', null);   // heightfield texels (w, h)
      material.Vertex_Definitions(`
        float _clipH(vec2 uv) {
          vec2 tc = uv * texSize - 0.5; vec2 f = fract(tc);
          ivec2 i0 = ivec2(floor(tc)); ivec2 mx = ivec2(texSize) - 1;
          float h00 = texelFetch(heightTex, clamp(i0,            ivec2(0), mx), 0).r;
          float h10 = texelFetch(heightTex, clamp(i0+ivec2(1,0), ivec2(0), mx), 0).r;
          float h01 = texelFetch(heightTex, clamp(i0+ivec2(0,1), ivec2(0), mx), 0).r;
          float h11 = texelFetch(heightTex, clamp(i0+ivec2(1,1), ivec2(0), mx), 0).r;
          return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
        }
        float _clipHW(vec2 wxz) {
          return _clipH(vec2((wxz.x - wbounds.x) / wbounds.z, (wbounds.y + wbounds.w - wxz.y) / wbounds.w));
        }
      `);
      material.Vertex_Before_PositionUpdated(`
        vec3 _cw = (world * vec4(positionUpdated, 1.0)).xyz;
        positionUpdated.y = _clipHW(_cw.xz);
      `);
      material.Fragment_Definitions(`
        float _clipHF(vec2 wxz) {
          // BILINEAR tap (was nearest texelFetch → flat ~24 m shading facets); see PBR path note.
          vec2 uv = vec2((wxz.x - wbounds.x) / wbounds.z, (wbounds.y + wbounds.w - wxz.y) / wbounds.w);
          vec2 tc = uv * texSize - 0.5; vec2 f = fract(tc);
          ivec2 i0 = ivec2(floor(tc)); ivec2 mx = ivec2(texSize) - 1;
          float h00 = texelFetch(heightTex, clamp(i0,            ivec2(0), mx), 0).r;
          float h10 = texelFetch(heightTex, clamp(i0+ivec2(1,0), ivec2(0), mx), 0).r;
          float h01 = texelFetch(heightTex, clamp(i0+ivec2(0,1), ivec2(0), mx), 0).r;
          float h11 = texelFetch(heightTex, clamp(i0+ivec2(1,1), ivec2(0), mx), 0).r;
          return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
        }
        vec3 _clipNormal(vec2 wxz) {
          float e = 1.5 * wbounds.z / texSize.x;   // ~1.5 texels in world metres (slightly wider = softer)
          float hl = _clipHF(wxz - vec2(e, 0.0)); float hr = _clipHF(wxz + vec2(e, 0.0));
          float hd = _clipHF(wxz - vec2(0.0, e)); float hu = _clipHF(wxz + vec2(0.0, e));
          return normalize(vec3(hl - hr, 2.0 * e, hd - hu));
        }
        // ── P5: procedural detail field (world-XZ value-noise fBm) ─────────────
        // Pure ALU (no texture) so it's safe to evaluate in any control flow on WebGPU, non-repeating
        // (unlike the tiled normal maps), and analytically differentiable for a matching detail normal.
        float _dHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float _dVal(vec2 p) {
          vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
          return mix(mix(_dHash(i), _dHash(i + vec2(1.0, 0.0)), u.x),
                     mix(_dHash(i + vec2(0.0, 1.0)), _dHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        // 3-octave detail height in ~[-0.5, 0.5]; p is world metres. Base feature ~2.4 m → finest ~0.6 m.
        float _detailH(vec2 p) {
          float s = 0.0, a = 0.5, n = 0.0; vec2 q = p * 0.42;
          for (int o = 0; o < 3; o++) { s += a * _dVal(q); n += a; a *= 0.5; q = q * 2.03 + 7.3; }
          return s / n - 0.5;
        }
      `);
    }

    // The ragged-waterline discard must NOT run when the terrain renders into the ocean's seabed
    // (refraction) RTT, or the holes fill with that pass's clear-colour and read as bright specks in
    // the depth-revealed seabed. Flag the refraction pass so the bind below can switch it off.
    const refr = this.oceanService.getRefractionTexture?.();
    if (refr && !this._refractionObserversWired) {
      this._refractionObserversWired = true;
      refr.onBeforeRenderObservable.add(() => { this._inRefractionPass = true; });
      refr.onAfterRenderObservable.add(() => { this._inRefractionPass = false; });
    }

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
      // ── 0. Ragged, undulating, anti-aliased waterline ─────────────────────
      // Scallop the sand↔water edge so it isn't a clean contour: in a thin band right at the
      // waterline, a SMOOTH world-space value-noise (~1.4 m lobes, not fine grain) discards sand
      // pixels — so the depth-transparent shallows behind show through in uneven bites. The band
      // EBBS & FLOWS over time (wash running up the beach), and the cutout is anti-aliased via a
      // derivative-feathered edge + interleaved-gradient dither (FXAA then resolves it). Off in the
      // refraction RTT (u_waterlineDither = 0) so the revealed seabed stays solid.
      vec2  wlP = vPositionW.xz * 0.70;                  // ~1.4 m feature size
      vec2  wlI = floor(wlP), wlF = fract(wlP);
      vec2  wlU = wlF * wlF * (3.0 - 2.0 * wlF);
      float wlA = fract(sin(dot(wlI,                  vec2(127.1, 311.7))) * 43758.5453);
      float wlB = fract(sin(dot(wlI + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
      float wlC = fract(sin(dot(wlI + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
      float wlD = fract(sin(dot(wlI + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
      float wlNoise = mix(mix(wlA, wlB, wlU.x), mix(wlC, wlD, wlU.x), wlU.y);
      wlNoise = wlNoise * 0.75 + fract(sin(dot(floor(vPositionW.xz * 2.3), vec2(127.1, 311.7))) * 43758.5453) * 0.25;
      // Ebb & flow: shift the effective waterline up/down ~±0.18 m on a ~8 s wash, varying along shore.
      float wlEbb = sin(uCloudTime * 0.8 + vPositionW.x * 0.13 + vPositionW.z * 0.09) * 0.12
                  + sin(uCloudTime * 1.3 - vPositionW.z * 0.18) * 0.06;
      float wlY = vPositionW.y - wlEbb;
      float wlBand  = (1.0 - smoothstep(0.0, 0.7, wlY))            // fades out ~0.7 m up the beach
                    * smoothstep(-0.30, 0.05, wlY)                 // fades in from just below water
                    * 0.9                                          // max discard fraction at the very edge
                    * u_waterlineDither;                            // 0 in the refraction RTT → seabed stays solid
      // ── 0b. Fine dither octave on the edge ────────────────────────────────
      // The ~1.4 m wlNoise gives a clean, well-defined undulating boundary. Add a MUCH finer
      // value-noise (~0.12 m lobes) that jitters the keep/cut threshold, so the crisp wave edge
      // breaks up into a grainy, ragged shoreline instead of a sharp contour. Centred on 0 so it
      // only nudges the edge either way; gated by wlBand (= 0 inland) so it can never punch stray
      // holes away from the waterline. KNOB 6.0 = fineness (higher → finer grain); grain strength &
      // band width are tuned where wlFine is applied to the coverage (below).
      vec2  wlFP = vPositionW.xz * 6.0;                  // ~0.17 m feature size
      vec2  wlFI = floor(wlFP), wlFF = fract(wlFP);
      vec2  wlFU = wlFF * wlFF * (3.0 - 2.0 * wlFF);
      float wlFa = fract(sin(dot(wlFI,                  vec2(127.1, 311.7))) * 43758.5453);
      float wlFb = fract(sin(dot(wlFI + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
      float wlFc = fract(sin(dot(wlFI + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
      float wlFd = fract(sin(dot(wlFI + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
      float wlFine = mix(mix(wlFa, wlFb, wlFU.x), mix(wlFc, wlFd, wlFU.x), wlFU.y);
      // (wlFine is applied to the COVERAGE below, not added into wlNoise — see the note there.)

      // Anti-aliased cutout: soft ~1-px coverage from the noise-vs-band gradient, resolved with an
      // interleaved-gradient screen dither (stable, low sparkle) that the pipeline FXAA smooths.
      float wlEdge = wlNoise - wlBand;                   // ≥0 keep, <0 cut
      float wlCov  = clamp(wlEdge / max(fwidth(wlEdge), 1e-4) + 0.5, 0.0, 1.0);
      // Break up that clean ~1-px edge with the fine octave. Blend the coverage toward the fine-noise
      // field in a thin band around the boundary (wlNear), so the IGN discard below dissolves the edge
      // into grain. Done AFTER the fwidth normalisation ON PURPOSE: folding wlFine into wlNoise instead
      // gets divided straight back out by the fwidth term (high-freq noise raises the gradient as much
      // as it shifts the edge) -- that is why the first attempt was invisible. KNOBS: 0.18 = width of the
      // roughened band (noise units), 0.7 = grain strength (0 = clean edge, 1 = fully grainy).
      float wlNear = (1.0 - smoothstep(0.0, 0.18, abs(wlEdge))) * step(0.0001, wlBand);
      wlCov = mix(wlCov, wlFine, wlNear * 0.7);
      float wlIGN  = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (wlCov < wlIGN) { discard; }

      // ── 1. Macro tonal modifier from procedural albedo ────────────────────
      float macroLum = dot(baseColor.rgb, vec3(0.299, 0.587, 0.114));
      float macroMod = 0.75 + macroLum * 0.50;  // [0.75 .. 1.25]

      // ── 2. Triplanar blend weights ────────────────────────────────────────
      // Clipmap mode recomputes the world normal from the heightfield (the flat-grid vNormalW is
      // meaningless once the vertex shader displaces Y); the static mesh uses its baked normals.
      vec3 nW   = ${clipmap ? '_clipNormal(vPositionW.xz)' : 'normalize(vNormalW)'};
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
        vec3  wetCol = mix(baseColor.rgb, vec3(wetLum), 0.25) * 0.62;  // damp wet-sand tone (the stipple that forced this lighter is gone)
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
      // Sampled UNCONDITIONALLY -- no  if (detFade > 0.001)  guard. WGSL forbids an implicit-LOD
      // texture sample (texture2D) inside non-uniform control flow (the gradient-based mip selection
      // requires uniform control flow), so gating these by the per-pixel detFade made the terrain
      // fragment shader fail to compile on WebGPU -- failing pipeline creation EVERY frame (the cause
      // of the large frame-time spikes). The detFade multiply below already fades the contribution to
      // zero past the near field, so dropping the branch is behaviourally identical; the only cost is
      // two extra texture taps on far pixels, and it keeps mip-correct sampling (no shimmer).
      vec3 detN1 = texture2D(uGrassNor, vPositionW.xz * 0.60).rgb * 2.0 - 1.0;
      vec3 detN2 = texture2D(uRockNor,  vPositionW.xz * 1.30).rgb * 2.0 - 1.0;
      vec3 detWorld = normalize(
          vec3(detN1.r, detN1.b, detN1.g) * 0.6 +
          vec3(detN2.r, detN2.b, detN2.g) * 0.4
      );
      normalW = normalize(normalW + detWorld * (0.24 * detFade));

      // ── 9c. Procedural slope-aligned detail normal (P5 — near-field, non-repeating) ──
      // A world-space value-noise micro-relief: perturb the LIGHTING normal by the analytic gradient
      // of _detailH so close-up ground reads as real rugged relief (not a repeating tile). Pure ALU
      // (no texture sample) → safe to evaluate unconditionally on WebGPU. Stronger on rock/slope,
      // gentle on flat sand, faded in above the waterline and out with distance (keeps cost near the
      // camera + avoids far-field aliasing). NO geometry displacement → the rendered surface still
      // matches the CPU getElevation used for collision/scatter (no float/sink regression).
      float pdFade = 1.0 - smoothstep(45.0, 210.0, length(vPositionW - vEyePosition.xyz));
      float pe     = 0.7;                                  // gradient sample step (m) — sub-feature
      float pHL = _detailH(vPositionW.xz - vec2(pe, 0.0)); float pHR = _detailH(vPositionW.xz + vec2(pe, 0.0));
      float pHD = _detailH(vPositionW.xz - vec2(0.0, pe)); float pHU = _detailH(vPositionW.xz + vec2(0.0, pe));
      float pStr  = (0.55 + slope * 2.4) * (0.45 + 0.55 * wRock + 0.40 * wGravel + 0.20 * wGrass);
      float pLand = smoothstep(0.4, 4.0, vPositionW.y);    // fade in just above the waterline
      float pk    = 1.5 * pdFade * pLand * pStr;
      normalW = normalize(normalW + vec3(-(pHR - pHL), 0.0, -(pHU - pHD)) * pk);
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
        // Project up-sun to the REAL cloud base and sample the same value-noise field at the
        // same scales + wind drift the ocean uses, so land & sea shadows line up across the
        // shoreline and drift in sync with the actual clouds.
        vec2 sp = vPositionW.xz + uSunDir.xz / max(uSunDir.y, 0.15) * uCloudBaseH + uCloudDrift;
        #define VCH(p) fract(sin(dot((p), vec2(127.1,311.7))) * 43758.5453)
        vec2 a0 = sp * 0.0013; vec2 i0 = floor(a0); vec2 f0 = fract(a0); f0 = f0*f0*(3.0-2.0*f0);
        float n0 = mix(mix(VCH(i0),VCH(i0+vec2(1.,0.)),f0.x), mix(VCH(i0+vec2(0.,1.)),VCH(i0+vec2(1.,1.)),f0.x), f0.y);
        vec2 a1 = sp * 0.0037; vec2 i1 = floor(a1); vec2 f1 = fract(a1); f1 = f1*f1*(3.0-2.0*f1);
        float n1 = mix(mix(VCH(i1),VCH(i1+vec2(1.,0.)),f1.x), mix(VCH(i1+vec2(0.,1.)),VCH(i1+vec2(1.,1.)),f1.x), f1.y);
        float cf = n0 * 0.65 + n1 * 0.35;
        float cShadow = smoothstep(0.58 - uCloudCoverage * 0.45, 0.70 - uCloudCoverage * 0.30, cf);
        cShadow *= smoothstep(0.05, 0.35, uCloudCoverage) * smoothstep(0.03, 0.18, uSunDir.y);
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
      // Switch the shoreline dither OFF for the refraction (seabed) pass so the seabed stays solid.
      fx.setFloat('u_waterlineDither', this._inRefractionPass ? 0 : 1);
      // Haze tint tracks the current sky/fog colour (day/dusk/night/storm aware).
      fx.setColor3('uHazeColor', scene.fogColor);
      // Cloud shadows — pull the SAME coverage, sun dir and clock the ocean uses so the
      // dappled shadows line up exactly across the water/land boundary.
      fx.setVector3('uSunDir', this.sceneService.getSunDirection());
      fx.setFloat('uCloudCoverage', this.oceanService.getCloudCoverage());
      fx.setFloat('uCloudTime', this.oceanService.getOceanTime());
      // Real cloud drift + base, shared from the cloud plugin via the ocean, so terrain shadows
      // sync to the actual clouds (and match the water exactly at the shoreline).
      const csf = this.oceanService.getCloudShadowField();
      fx.setFloat2('uCloudDrift', csf?.drift.x ?? 0, csf?.drift.y ?? 0);
      fx.setFloat('uCloudBaseH', csf?.cloudBase ?? 900);
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
      if (clipmap && this.clipHeightTex) {
        fx.setTexture('heightTex', this.clipHeightTex);
        fx.setVector4('wbounds', this.clipWBounds);
        fx.setVector2('texSize', this.clipTexSize);
      }
    });

    this.terrainMaterial = material;
    return material;
  }

  /** A tiny 1×1×N white array so the sampler2DArray is valid before the real tiles finish loading. */
  private makePlaceholderArr(scene: Scene): RawTexture2DArray {
    const N = TerrainService.ALBEDO_LAYERS.length;   // 8: covers the albedo sampler; ORM (5) also binds this
    const data = new Uint8Array(N * 4).fill(190);
    for (let i = 3; i < data.length; i += 4) { data[i] = 255; }
    return new RawTexture2DArray(data, 1, 1, N, Constants.TEXTUREFORMAT_RGBA, scene,
      false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  }

  /**
   * S1b: load the 5 biome PBR tiles into texture ARRAYS — albedo (RGB diffuse) + orm (R = roughness,
   * G = ambient occlusion). One sampler each (vs 5 per map) → fixes the 16-sampler cap and lets the
   * shader index a biome by layer. Pixels are extracted via a canvas (tiles served from the API server;
   * crossOrigin set for getImageData). Missing maps fall back to sensible defaults.
   */
  private async loadBiomeArrays(scene: Scene): Promise<void> {
    if (this.biomeAlbedoArr) { return; }
    const ALB = TerrainService.ALBEDO_LAYERS;          // 8 layers (5 core + sand2/grass2/rock2)
    const ORMN = TerrainService.BIOME_TILES.length;    // 5 layers (variants reuse base rough/AO)
    const albN = ALB.length, SIZE = 1024;
    const loadImg = (name: string) => new Promise<HTMLImageElement | null>((res) => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => res(im); im.onerror = () => res(null);
      im.src = `${Settings.apiUrl}terrain/tile/${name}`;
    });
    const cv = document.createElement('canvas'); cv.width = SIZE; cv.height = SIZE;
    const ctx = cv.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    if (!ctx) { return; }
    const pixels = (img: HTMLImageElement | null): Uint8ClampedArray | null => {
      if (!img) { return null; }
      ctx.clearRect(0, 0, SIZE, SIZE); ctx.drawImage(img, 0, 0, SIZE, SIZE);
      try { return ctx.getImageData(0, 0, SIZE, SIZE).data; } catch { return null; }
    };
    // Albedo: all 8 layers (core + variants), diffuse only.
    const albedo = new Uint8Array(albN * SIZE * SIZE * 4);
    for (let L = 0; L < albN; L++) {
      const d = pixels(await loadImg(`${ALB[L]}_diff`));
      const off = L * SIZE * SIZE * 4;
      for (let i = 0; i < SIZE * SIZE; i++) {
        const j = off + i * 4, k = i * 4;
        albedo[j] = d ? d[k] : 200; albedo[j + 1] = d ? d[k + 1] : 200; albedo[j + 2] = d ? d[k + 2] : 200; albedo[j + 3] = 255;
      }
    }
    // ORM: 5 core layers only (R = roughness, G = AO).
    const orm = new Uint8Array(ORMN * SIZE * SIZE * 4);
    for (let L = 0; L < ORMN; L++) {
      const b = TerrainService.BIOME_TILES[L];
      const [rImg, aImg] = await Promise.all([loadImg(`${b}_rough`), loadImg(`${b}_ao`)]);
      const r = pixels(rImg), a = pixels(aImg);
      const off = L * SIZE * SIZE * 4;
      for (let i = 0; i < SIZE * SIZE; i++) {
        const j = off + i * 4, k = i * 4;
        orm[j] = r ? r[k] : 230;            // R = roughness (default fairly matte)
        orm[j + 1] = a ? a[k] : 255;        // G = ambient occlusion (default none)
        orm[j + 2] = 0; orm[j + 3] = 255;
      }
    }
    const mk = (data: Uint8Array, depth: number): RawTexture2DArray => {
      const t = new RawTexture2DArray(data, SIZE, SIZE, depth, Constants.TEXTUREFORMAT_RGBA, scene,
        true, false, Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
      t.wrapU = Texture.WRAP_ADDRESSMODE; t.wrapV = Texture.WRAP_ADDRESSMODE;
      return t;
    };
    this.biomeAlbedoArr = mk(albedo, albN);
    this.biomeOrmArr = mk(orm, ORMN);
  }

  /**
   * S0 spike (terrain-skinning roadmap) — a PBRCustomMaterial clipmap terrain, behind `?terrainpbr`.
   * Proves the material-model switch: GPU height-displacement + Sobel normals + procedural detail
   * normals (P5) + triplanar biome albedo + matte roughness, lit by the Atmosphere addon (physical
   * sky/sun) instead of StandardMaterial's manual lighting, plus the ragged waterline + cloud shadows +
   * aerial haze. Intentionally a CLEAN FOUNDATION (per-biome rough/AO + tile normals via texture arrays
   * = S1; control map = S2; anti-tiling = S3; strata/wet-sand = S4/S5), not a 1:1 port of the Standard
   * material. Mirrors the FFT ocean's proven PBRCustomMaterial-on-WebGPU pattern (Vertex_After_
   * WorldPosComputed displaces worldPos; Fragment_Before_Lights sets surfaceAlbedo/normalW;
   * Fragment_Before_Fog post-processes the composed `finalColor`).
   */
  private buildTerrainMaterialPBR(scene: Scene, manifest: TerrainManifest): PBRCustomMaterial {
    this.terrainMaterialPBR?.dispose();
    this.terrainMaterialPBR = null;
    for (const t of this.terrainTextures) { t.dispose(); }
    this.terrainTextures = [];
    this.createClipHeightTexture(scene, manifest);   // heightTex/wbounds/texSize for the displacement
    const peakH = manifest.targetPeakElevation ?? 920;

    const mat = new PBRCustomMaterial('terrain_mat_pbr', scene);
    mat.metallic = 0.0;
    mat.roughness = 0.92;                       // matte; per-biome roughness maps arrive in S1
    mat.backFaceCulling = true;
    mat.maxSimultaneousLights = 6;             // forward pass; the prePass UBO budget is governed by scene light count

    // Biome PBR via texture arrays (S1b): two sampler2DArray (albedo + orm) instead of 5 diffuse
    // samplers — big sampler-budget headroom. Async load; a placeholder binds until the real tiles land.
    this.biomePlaceholderArr = this.biomePlaceholderArr ?? this.makePlaceholderArr(scene);
    void this.loadBiomeArrays(scene);

    // S2 control/splat map: world-aligned RGBA soft biome weights. invertY=false so v=0 = north (matches
    // the heightfield uv). A not-yet-loaded texture still binds; uHasSplat gates its use (→ _biomeW until ready).
    this.splatTex = new Texture(`${Settings.apiUrl}terrain/splat-map`, scene, false, false,
      Texture.LINEAR_LINEAR_MIPLINEAR, null, () => console.info('[TerrainPBR] splat map not found — using live biome calc'));
    this.splatTex.wrapU = Texture.CLAMP_ADDRESSMODE; this.splatTex.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.terrainTextures.push(this.splatTex);

    // S4 aux map: world-aligned RGBA data (R slope, G shoreDist, B wetness, A flow). DATA not colour, so
    // gammaSpace=false (no sRGB decode). invertY=false to match the splat/heightfield uv. uHasAux gates use.
    this.auxTex = new Texture(`${Settings.apiUrl}terrain/aux-map`, scene, false, false,
      Texture.LINEAR_LINEAR_MIPLINEAR, null, () => console.info('[TerrainPBR] aux map not found — flow/erosion skinning off'));
    this.auxTex.gammaSpace = false;
    this.auxTex.wrapU = Texture.CLAMP_ADDRESSMODE; this.auxTex.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.terrainTextures.push(this.auxTex);

    mat.AddUniform('uAlbedoArr', 'sampler2DArray', null);
    mat.AddUniform('uOrmArr', 'sampler2DArray', null);
    mat.AddUniform('uSplat', 'sampler2D', null);
    mat.AddUniform('uHasSplat', 'float', null);
    mat.AddUniform('uAux', 'sampler2D', null);
    mat.AddUniform('uHasAux', 'float', null);
    mat.AddUniform('heightTex', 'sampler2D', null);
    mat.AddUniform('uPeakH', 'float', null);
    mat.AddUniform('wbounds', 'vec4', null);
    mat.AddUniform('texSize', 'vec2', null);
    mat.AddUniform('uHazeColor', 'vec3', null);
    mat.AddUniform('uSunDir', 'vec3', null);
    mat.AddUniform('uCloudCoverage', 'float', null);
    mat.AddUniform('uCloudTime', 'float', null);
    mat.AddUniform('uCloudDrift', 'vec2', null);
    mat.AddUniform('uCloudBaseH', 'float', null);
    mat.AddUniform('u_waterlineDither', 'float', null);
    mat.AddUniform('uCannonFlash', 'vec4', null);   // xz = world pos, z = strength (0 = none), w = radius (m)

    // The ragged-waterline discard (below) must NOT run when the terrain renders into the ocean's
    // seabed (refraction) RTT, or the holes fill with that pass's bright tan clear-colour and read
    // as a sandy band in the shallows. Flag the refraction pass so onBind switches the discard off.
    // NOTE: this MUST be registered here too — the Standard path (buildTerrainMaterial) registers
    // the same observers, but under ?terrainpbr only THIS builder runs, so without this the flag
    // stays false forever and the discard punches tan holes at the shoreline (PBR-only bug).
    const refr = this.oceanService.getRefractionTexture?.();
    if (refr && !this._refractionObserversWired) {
      this._refractionObserversWired = true;
      refr.onBeforeRenderObservable.add(() => { this._inRefractionPass = true; });
      refr.onAfterRenderObservable.add(() => { this._inRefractionPass = false; });
    }

    mat.Vertex_Definitions(`
      float _clipH(vec2 uv) {
        vec2 tc = uv * texSize - 0.5; vec2 f = fract(tc);
        ivec2 i0 = ivec2(floor(tc)); ivec2 mx = ivec2(texSize) - 1;
        float h00 = texelFetch(heightTex, clamp(i0,            ivec2(0), mx), 0).r;
        float h10 = texelFetch(heightTex, clamp(i0+ivec2(1,0), ivec2(0), mx), 0).r;
        float h01 = texelFetch(heightTex, clamp(i0+ivec2(0,1), ivec2(0), mx), 0).r;
        float h11 = texelFetch(heightTex, clamp(i0+ivec2(1,1), ivec2(0), mx), 0).r;
        return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
      }
      float _clipHW(vec2 wxz) { return _clipH(vec2((wxz.x - wbounds.x) / wbounds.z, (wbounds.y + wbounds.w - wxz.y) / wbounds.w)); }
    `);
    // Displace the flat clipmap grid by the heightfield (xz unchanged -> vPositionW.xz stays valid).
    // CRITICAL: Babylon assigns vPositionW = worldPos BEFORE this hook (pbr.vertex line ~166), so we must
    // re-sync vPositionW to the displaced worldPos here. Otherwise the fragment reads a flat (sea-level)
    // world Y -> the ragged-waterline band thinks the whole terrain is at the shoreline and discards
    // nearly every fragment (terrain renders only in sparse noise-peak stripes).
    mat.Vertex_After_WorldPosComputed(`
      worldPos.y = _clipHW(worldPos.xz);
      vPositionW = worldPos.xyz;
    `);

    mat.Fragment_Definitions(`
      float _clipHF(vec2 wxz) {
        // BILINEAR heightfield tap (was nearest texelFetch → constant normal per ~24 m texel = flat facets).
        // Smooth sampling makes the Sobel normal vary continuously, de-faceting the shading.
        vec2 uv = vec2((wxz.x - wbounds.x) / wbounds.z, (wbounds.y + wbounds.w - wxz.y) / wbounds.w);
        vec2 tc = uv * texSize - 0.5; vec2 f = fract(tc);
        ivec2 i0 = ivec2(floor(tc)); ivec2 mx = ivec2(texSize) - 1;
        float h00 = texelFetch(heightTex, clamp(i0,            ivec2(0), mx), 0).r;
        float h10 = texelFetch(heightTex, clamp(i0+ivec2(1,0), ivec2(0), mx), 0).r;
        float h01 = texelFetch(heightTex, clamp(i0+ivec2(0,1), ivec2(0), mx), 0).r;
        float h11 = texelFetch(heightTex, clamp(i0+ivec2(1,1), ivec2(0), mx), 0).r;
        return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
      }
      vec3 _clipNormal(vec2 wxz) {
        float e = 1.5 * wbounds.z / texSize.x;   // ~1.5-texel Sobel span: a touch wider softens the slope
        float hl = _clipHF(wxz - vec2(e, 0.0)); float hr = _clipHF(wxz + vec2(e, 0.0));
        float hd = _clipHF(wxz - vec2(0.0, e)); float hu = _clipHF(wxz + vec2(0.0, e));
        return normalize(vec3(hl - hr, 2.0 * e, hd - hu));
      }
      float _dHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float _dVal(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(_dHash(i), _dHash(i + vec2(1.0, 0.0)), u.x), mix(_dHash(i + vec2(0.0, 1.0)), _dHash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float _detailH(vec2 p) { float s=0.0,a=0.5,n=0.0; vec2 q=p*0.42; for(int o=0;o<3;o++){s+=a*_dVal(q);n+=a;a*=0.5;q=q*2.03+7.3;} return s/n-0.5; }
      // Normalised biome cover weights (sand/grass/gravel/rock/snow) from world pos + normal - shared by
      // the metallic-roughness and albedo blocks so they agree (those inject at different shader points).
      // Returns vec4(sand,grass,gravel,rock); snow is reconstructed as 1-(x+y+z+w) at the call site
      // (post-normalisation the 5 weights sum to 1). No out/inout params -> WebGPU/SPIR-V safe.
      vec4 _biomeW(vec3 wp, vec3 nW) {
        float h = clamp(wp.y / uPeakH, 0.0, 1.0);
        float slope = 1.0 - clamp(nW.y, 0.0, 1.0);
        float shoreW = clamp(1.0 - wp.y/10.0, 0.0, 1.0);
        float hSand = clamp(1.0 - h/0.085, 0.0, 1.0);
        float sandSlope = mix(1.0, clamp(1.0-slope*1.25,0.0,1.0), smoothstep(0.0,15.0,wp.y));
        float wSand = max(hSand, shoreW)*sandSlope;
        float wGrass = clamp((h-0.035)/0.28,0.0,1.0)*clamp(1.0-slope*0.95,0.0,1.0);
        float wGravel = clamp((h-0.20)/0.52,0.0,1.0)*clamp(0.25+slope*1.5,0.0,1.0);
        float wRock = clamp((h-0.34)/0.54,0.0,1.0)*clamp(0.22+slope*1.7,0.0,1.0);
        float sj = sin(wp.x*0.0040+wp.z*0.0031)*0.040 + sin(wp.x*0.0017-wp.z*0.0023)*0.050;
        float wSnow = clamp((h-(0.66+sj))/0.16,0.0,1.0)*clamp(1.0-slope*2.2,0.0,1.0);
        float m = 0.5 + 0.34*sin(wp.x*0.00080+1.3)+0.24*sin(wp.z*0.00095-0.7)+0.18*sin((wp.x-wp.z)*0.00060+2.1)+0.12*sin((wp.x*0.7+wp.z*1.1)*0.0022-1.1);
        float wet = smoothstep(0.25,0.78,clamp(m,0.0,1.0));
        wGrass*=0.35+1.30*wet; wGravel*=1.45-0.75*wet; wRock*=1.25-0.40*wet;
        float t = max(0.0001, wSand+wGrass+wGravel+wRock+wSnow);
        return vec4(wSand, wGrass, wGravel, wRock) / t;
      }
      // S2: biome weights from the baked CONTROL/SPLAT map (consistent, flow/moisture-aware,
      // art-directable), re-sharpened on cliffs by the per-pixel geometry slope (the splat is 24 m/texel
      // -> smooth). Falls back to the live _biomeW until the splat texture is ready (uHasSplat is uniform,
      // so the branch is uniform control flow -> the texture sample is WebGPU-safe).
      vec4 _biomeSplat(vec3 wp, vec3 nW) {
        if (uHasSplat < 0.5) { return _biomeW(wp, nW); }
        vec2 uv = vec2((wp.x - wbounds.x)/wbounds.z, (wbounds.y + wbounds.w - wp.z)/wbounds.w);
        vec4 s = texture2D(uSplat, uv);
        float wSand = s.r; float wGrass = s.g; float wGravel = s.b; float wRock = s.a;
        float wSnow = max(0.0, 1.0 - (s.r+s.g+s.b+s.a));
        float slope = 1.0 - clamp(nW.y, 0.0, 1.0);
        float steep = smoothstep(0.35, 0.72, slope);
        wRock = max(wRock, steep);
        wGrass *= (1.0 - steep*0.9);
        wSand  *= (1.0 - steep*0.7);
        // #6 snow line by slope + ASPECT: snow clings to flatter, shaded faces; steep + sun-facing faces go
        // bare rock. A FIXED sunny azimuth (not the live sun -- snow cover is a seasonal average, so a moving
        // sun must NOT make snow flicker). Melted snow becomes rock; soft smoothstep bands (no hard cut).
        vec2 nh = nW.xz; float nhl = length(nh);
        float aspect = (nhl > 1e-3) ? dot(nh / nhl, vec2(0.5, -0.866)) : 0.0;   // +1 sun-facing, -1 shaded
        float snowMelt = clamp(max(smoothstep(0.32, 0.62, slope),
                                   smoothstep(0.0, 0.7, aspect) * smoothstep(0.06, 0.30, slope) * 0.8), 0.0, 1.0);
        float melted = wSnow * snowMelt; wSnow -= melted; wRock += melted;
        // S5b biome-edge softening: break hard borders with a fine (~1.7 m) noise so materials interlock
        // instead of meeting on a clean contour. Grass and sand trade tufts where they overlap; gravel scree
        // appears along rock/grass borders. Re-normalised below so totals stay valid (AO/roughness match too).
        float en = _dVal(wp.xz * 1.10) * 0.6 + _dVal(wp.xz * 3.40 + 13.0) * 0.4;
        float eb = (en - 0.5) * 2.0;
        float sg = clamp(min(wSand, wGrass) * 4.0, 0.0, 1.0);     // sand/grass overlap
        wGrass += eb * sg * 0.5; wSand -= eb * sg * 0.5;
        float rg = clamp(min(wRock, wGrass) * 4.0, 0.0, 1.0);     // rock/grass overlap
        float scree = smoothstep(0.55, 0.85, en) * rg;
        wGravel += scree * 0.6; wRock -= scree * 0.3; wGrass -= scree * 0.3;
        wSand = max(wSand, 0.0); wGrass = max(wGrass, 0.0); wGravel = max(wGravel, 0.0); wRock = max(wRock, 0.0);
        float t = max(1e-4, wSand+wGrass+wGravel+wRock+wSnow);
        return vec4(wSand, wGrass, wGravel, wRock) / t;
      }
      // S4: baked aux map sampled at the same world uv as the splat. Returns (R slope, G shoreDist,
      // B wetness, A flow); flow is log-normalised. Zero when not loaded (uHasAux is a uniform, so the
      // branch is uniform control flow -> the texture sample is WebGPU-safe).
      vec4 _aux(vec3 wp) {
        if (uHasAux < 0.5) { return vec4(0.0); }
        vec2 uv = vec2((wp.x - wbounds.x)/wbounds.z, (wbounds.y + wbounds.w - wp.z)/wbounds.w);
        return texture2D(uAux, uv);
      }
      // Forest moisture field (low-frequency, matches the Standard path) + canopy COVERAGE [0,1] (mid-
      // elevation + gentle-slope + moist, broken into clumps). Shared by the albedo (paint green) AND the
      // roughness (matte vegetation) so they agree. Gates relaxed vs §8d so the canopy climbs steeper slopes
      // -> less bare-rock black between beach and forest.
      float _forestMoist(vec3 wp) {
        return 0.5
          + 0.34 * sin(wp.x * 0.00080 + 1.3)
          + 0.24 * sin(wp.z * 0.00095 - 0.7)
          + 0.18 * sin((wp.x - wp.z) * 0.00060 + 2.1)
          + 0.12 * sin((wp.x * 0.7 + wp.z * 1.1) * 0.0022 - 1.1);
      }
      float _forestF(vec3 wp, float slope) {
        float h = clamp(wp.y / uPeakH, 0.0, 1.0);
        float fElev  = smoothstep(0.035, 0.10, h) * (1.0 - smoothstep(0.62, 0.74, h));
        float fSlope = clamp(1.0 - slope * 1.02, 0.0, 1.0);   // was 1.45 -> canopy reaches steeper faces
        float fMoist = smoothstep(0.24, 0.56, _forestMoist(wp));
        float fpw = sin(wp.x * 0.0021 + wp.z * 0.0013)
                  + sin(wp.z * 0.0026 - wp.x * 0.0009 + 2.0)
                  + sin((wp.x + wp.z) * 0.0015 - 1.0);
        return clamp(fElev * fSlope * fMoist * smoothstep(-0.4, 1.1, fpw), 0.0, 1.0);
      }
    `);

    // Roughness (metallic stays 0). Procedural for now - wet, low, flat ground near the waterline reads
    // glossy (wet sand sheen) while slopes/uplands stay matte. Real per-biome roughness maps replace this
    // in S1b. Runs BEFORE the light loop, so it recomputes slope from the Sobel normal.
    // WARNING: this injection lands INSIDE pbrBlockReflectivity, which PBRCustomMaterial runs through
    // ShaderCodeInliner (it inlines #define pbr_inline functions, collapsing newlines). A // line comment
    // here gets its terminating newline eaten on inline -> the next tokens parse as code (we hit
    // "'wetter' : undeclared identifier"). Use /* */ block comments ONLY inside this block. (The Standard
    // material path never runs the inliner, which is why // comments are fine everywhere else.)
    mat.Fragment_Custom_MetallicRoughness(`
      vec3 nWr = _clipNormal(vPositionW.xz);
      vec4 mrW = _biomeSplat(vPositionW, nWr);
      float mrS = mrW.x, mrG = mrW.y, mrGr = mrW.z, mrR = mrW.w, mrSn = 1.0 - (mrW.x+mrW.y+mrW.z+mrW.w);
      float rgh = texture(uOrmArr, vec3(vPositionW.xz*0.05, 0.0)).r*mrS + texture(uOrmArr, vec3(vPositionW.xz*0.05, 1.0)).r*mrG
                + texture(uOrmArr, vec3(vPositionW.xz*0.05, 2.0)).r*mrGr + texture(uOrmArr, vec3(vPositionW.xz*0.05, 3.0)).r*mrR
                + texture(uOrmArr, vec3(vPositionW.xz*0.05, 4.0)).r*mrSn;
      float wet = (1.0 - smoothstep(0.0, 2.2, vPositionW.y)) * (1.0 - smoothstep(0.35, 0.70, 1.0 - clamp(nWr.y, 0.0, 1.0)));
      metallicRoughness.r = 0.0;                                    /* terrain is never metallic */
      metallicRoughness.g = clamp(mix(rgh, rgh * 0.78, wet), 0.62, 1.0);   /* matte floor 0.62: low-roughness sky sheen was reading as wet/transparent water */
      vec4 auxR = _aux(vPositionW);                                 /* S4: water-polished drainage channels */
      float chanR = smoothstep(0.45, 0.82, auxR.a) * smoothstep(-0.2, 1.5, vPositionW.y);
      metallicRoughness.g = clamp(mix(metallicRoughness.g, metallicRoughness.g * 0.70, chanR), 0.50, 1.0);
      float ffR = _forestF(vPositionW, 1.0 - clamp(nWr.y, 0.0, 1.0));   /* matte the canopy: foliage isn't glossy */
      metallicRoughness.g = clamp(mix(metallicRoughness.g, 0.98, ffR * 0.9), 0.50, 1.0);
    `);

    // Albedo + normal (before the PBR light loop).
    mat.Fragment_Before_Lights(`
      // -- Ragged waterline scallop (off in the refraction RTT) --
      if (u_waterlineDither > 0.5) {
        vec2 wlP = vPositionW.xz * 0.70; vec2 wlI = floor(wlP), wlF = fract(wlP); vec2 wlU = wlF*wlF*(3.0-2.0*wlF);
        float a0=fract(sin(dot(wlI,vec2(127.1,311.7)))*43758.5453);
        float a1=fract(sin(dot(wlI+vec2(1.,0.),vec2(127.1,311.7)))*43758.5453);
        float a2=fract(sin(dot(wlI+vec2(0.,1.),vec2(127.1,311.7)))*43758.5453);
        float a3=fract(sin(dot(wlI+vec2(1.,1.),vec2(127.1,311.7)))*43758.5453);
        float wlN=mix(mix(a0,a1,wlU.x),mix(a2,a3,wlU.x),wlU.y);
        float ebb=sin(uCloudTime*0.8+vPositionW.x*0.13+vPositionW.z*0.09)*0.12;
        float wlY=vPositionW.y-ebb;
        float band=(1.0-smoothstep(0.0,0.7,wlY))*smoothstep(-0.30,0.05,wlY)*0.9;
        float edge=wlN-band; float cov=clamp(edge/max(fwidth(edge),1e-4)+0.5,0.0,1.0);
        float ign=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
        if (cov < ign) discard;
      }

      vec3 nW = _clipNormal(vPositionW.xz);
      vec3 triW = abs(nW); triW = triW*triW*triW*triW*triW*triW; triW /= (triW.x+triW.y+triW.z);
      float slope = 1.0 - clamp(nW.y, 0.0, 1.0);
      vec4 bW = _biomeSplat(vPositionW, nW);
      float wSand = bW.x, wGrass = bW.y, wGravel = bW.z, wRock = bW.w, wSnow = 1.0 - (bW.x+bW.y+bW.z+bW.w);

      // Triplanar albedo from the biome ARRAY, sampling at world position P (so a domain-warped P can be
      // passed in to break the tile lattice). Layer = biome index.
      #define TRIA(P, L, scl) (texture(uAlbedoArr, vec3((P).yz*(scl), float(L))).rgb*triW.x + texture(uAlbedoArr, vec3((P).xz*(scl), float(L))).rgb*triW.y + texture(uAlbedoArr, vec3((P).xy*(scl), float(L))).rgb*triW.z)
      // Variant triplanar via textureLod (explicit LOD) so it is legal inside the per-pixel distance branch below.
      #define TRIAL(L, scl, lod) (textureLod(uAlbedoArr, vec3(wpW.yz*(scl), float(L)), lod).rgb*triW.x + textureLod(uAlbedoArr, vec3(wpW.xz*(scl), float(L)), lod).rgb*triW.y + textureLod(uAlbedoArr, vec3(wpW.xy*(scl), float(L)), lod).rgb*triW.z)
      // Anti-tiling, two layers: (1) DOMAIN-WARP the FINE taps with a ~20 m noise (amplitude ~4.5 m, about a
      // third of the fine tile period) so the periodic grain no longer recurs on an exact grid -- this is the
      // "repeats every few boat lengths" tell, and the warp is what actually kills it. (2) cross-fade each
      // fine layer with its VARIANT layer (5 sand2 / 6 grass2 / 7 rock2) over a large noise for material variety.
      float dCam = length(vPositionW - vEyePosition.xyz);
      vec2 wq = vPositionW.xz;
      vec3 wpW = vPositionW + vec3(_dVal(wq*0.035 + 3.7) - 0.5, 0.0, _dVal(wq*0.035 + 19.1) - 0.5) * 14.0;
      vec3 sandFine  = TRIA(wpW,0,0.067);
      vec3 grassFine = TRIA(wpW,1,0.050);
      vec3 rockFine  = TRIA(wpW,3,0.083);
      // S6 perf: the variant cross-fade (9 extra taps) is only visible up close; past ~170 m skip it entirely.
      // texture() can't go in a per-pixel branch (mip derivatives need uniform flow), so the variants use
      // textureLod inside the branch; the base fine taps above keep auto-mip. Most of the screen saves 9 taps.
      float varFade = 1.0 - smoothstep(70.0, 170.0, dCam);
      if (varFade > 0.003) {
        float vlod = clamp(log2(max(dCam, 1.0) / 35.0), 0.0, 4.0);
        float vSand  = smoothstep(0.35, 0.65, _dVal(wq * 0.0017 + 11.3)) * varFade;
        float vGrass = smoothstep(0.35, 0.65, _dVal(wq * 0.0019 + 27.7)) * varFade;
        float vRock  = smoothstep(0.35, 0.65, _dVal(wq * 0.0015 + 51.1)) * varFade;
        sandFine  = mix(sandFine,  TRIAL(5,0.061,vlod), vSand);
        grassFine = mix(grassFine, TRIAL(6,0.047,vlod), vGrass);
        rockFine  = mix(rockFine,  TRIAL(7,0.078,vlod), vRock);
      }
      #undef TRIAL
      vec3 sandC = clamp((sandFine*0.65 + texture(uAlbedoArr, vec3(wpW.xz*0.018,0.0)).rgb*0.35) * vec3(1.20,1.08,0.80), 0.0, 1.0);
      vec3 grassC = grassFine*0.65 + texture(uAlbedoArr, vec3(wpW.xz*0.013,1.0)).rgb*0.35;
      vec3 gravC = TRIA(wpW,2,0.040)*0.6 + TRIA(vPositionW,3,0.020)*0.4;
      vec3 rockC = rockFine*0.6 + TRIA(vPositionW,2,0.025)*0.4;
      vec3 snowC = TRIA(wpW,4,0.033)*0.7 + texture(uAlbedoArr, vec3(vPositionW.xz*0.010,4.0)).rgb*0.30;
      #undef TRIA
      vec3 splatC = sandC*wSand + grassC*wGrass + gravC*wGravel + rockC*wRock + snowC*wSnow;
      // S3 macro colour: large-scale (~300-900 m) cool/warm + brightness drift so big areas are not uniform.
      float macroN = _dVal(vPositionW.xz * 0.0022 + 70.0) * 0.6 + _dVal(vPositionW.xz * 0.0009 + 130.0) * 0.4;
      float macroW = macroN - 0.5;
      splatC *= (1.0 + macroW * 0.20);
      splatC.r *= (1.0 + macroW * 0.09); splatC.b *= (1.0 - macroW * 0.09);
      splatC = clamp(splatC, 0.0, 1.0);
      // S4 flow & erosion skinning: the baked flow map carves drainage channels (darker, sediment-toned,
      // water-polished -- gloss handled in the roughness block); broad wetness dampens/darkens open ground.
      // Land only (the ocean shades the submerged seabed). Falls back to no-op when the aux map is absent.
      vec4 aux = _aux(vPositionW);
      float landMask = smoothstep(-0.2, 1.5, vPositionW.y);
      float chan = smoothstep(0.45, 0.82, aux.a) * landMask;     // strong flow = drainage channel
      float damp = smoothstep(0.40, 0.90, aux.b) * landMask;     // broad wetness = damp ground
      float wetMix = clamp(max(chan, damp * 0.55), 0.0, 1.0);
      if (wetMix > 0.001) {
        float sLum = dot(splatC, vec3(0.299, 0.587, 0.114));
        vec3 sediment = mix(splatC, vec3(sLum) * vec3(0.82, 0.80, 0.74), 0.30);   // cool grey-brown sediment
        splatC = mix(splatC, sediment * mix(1.0, 0.58, wetMix), wetMix);          // darker + sediment-toned
      }
      // S5 coastal detail: wet-sand tide line + a noise-broken foam/salt stain at the high-water mark.
      // Elevation is the tide proxy (precise per-pixel via the displaced vPositionW.y); aux shoreDist gates
      // it to genuine coast (no-op if the aux map is absent -> g=0 -> gate=1). Sand-weighted: beaches only.
      float shoreGate = 1.0 - smoothstep(0.0, 0.05, aux.g);
      float tide = (1.0 - smoothstep(0.0, 3.2, vPositionW.y)) * smoothstep(-1.0, 0.25, vPositionW.y) * wSand * shoreGate;
      if (tide > 0.001) {
        float tl = dot(splatC, vec3(0.299, 0.587, 0.114));
        vec3 wetSand = mix(splatC, vec3(tl), 0.20) * 0.66;        // damp sand: darker + desaturated
        splatC = mix(splatC, wetSand, tide);
      }
      float hwm = smoothstep(0.7, 1.5, vPositionW.y) * (1.0 - smoothstep(1.5, 2.8, vPositionW.y)) * wSand * shoreGate;
      if (hwm > 0.001) {
        float fN = _dVal(vPositionW.xz * 0.55) * 0.6 + _dVal(vPositionW.xz * 1.7 + 4.0) * 0.4;
        float stain = smoothstep(0.58, 0.86, fN) * hwm;
        splatC = mix(splatC, vec3(0.88, 0.87, 0.82), stain * 0.45);   // pale dried salt/foam line
      }
      // Ambient occlusion (orm.g), biome-weighted (single planar tap per biome). S6 perf: crevice AO is
      // invisible at distance, so past ~200 m drop to aoT=1 (no darkening) and skip these 5 taps. Same rule
      // as the variants -- textureLod inside the per-pixel branch (auto-mip texture() is illegal there).
      float aoT = 1.0;
      float aoFade = 1.0 - smoothstep(90.0, 200.0, dCam);
      if (aoFade > 0.003) {
        float alod = clamp(log2(max(dCam, 1.0) / 35.0), 0.0, 5.0);
        float ao5 = textureLod(uOrmArr, vec3(vPositionW.xz*0.05,0.0), alod).g*wSand
                  + textureLod(uOrmArr, vec3(vPositionW.xz*0.05,1.0), alod).g*wGrass
                  + textureLod(uOrmArr, vec3(vPositionW.xz*0.05,2.0), alod).g*wGravel
                  + textureLod(uOrmArr, vec3(vPositionW.xz*0.05,3.0), alod).g*wRock
                  + textureLod(uOrmArr, vec3(vPositionW.xz*0.05,4.0), alod).g*wSnow;
        aoT = mix(1.0, ao5, aoFade);
      }
      // ── Forest canopy: paint deep green on the wooded hillsides. The PBR splat has no forest biome, so
      // these otherwise read as dark rock / wet-darkened grass (the "black forest"). _forestF (shared with
      // the roughness block) gates it; greener when wet, clump-mottled.
      float forestF = _forestF(vPositionW, slope);
      if (forestF > 0.003) {
        float fWet = smoothstep(0.25, 0.78, clamp(_forestMoist(vPositionW), 0.0, 1.0));
        float mott = sin(vPositionW.x * 0.045) * sin(vPositionW.z * 0.045) * 0.5 + 0.5;
        vec3 canopyDark = mix(vec3(0.07, 0.15, 0.06), vec3(0.10, 0.20, 0.07), fWet);
        vec3 canopyLit  = mix(vec3(0.14, 0.27, 0.11), vec3(0.20, 0.34, 0.14), fWet);
        splatC = mix(splatC, mix(canopyDark, canopyLit, mott), forestF * 0.94);
      }
      surfaceAlbedo = pow(clamp(splatC, 0.0, 1.0), vec3(2.2)) * (0.45 + 0.55*aoT);   // sRGB->linear, AO darkens crevices

      // Normal: Sobel geometry + P5 procedural detail (world-space gradient), near-faded, slope/biome-weighted.
      float pdFade = 1.0 - smoothstep(45.0, 210.0, length(vPositionW - vEyePosition.xyz));
      float pe = 0.7;
      float pHL=_detailH(vPositionW.xz-vec2(pe,0.0)), pHR=_detailH(vPositionW.xz+vec2(pe,0.0));
      float pHD=_detailH(vPositionW.xz-vec2(0.0,pe)), pHU=_detailH(vPositionW.xz+vec2(0.0,pe));
      float pStr=(0.55+slope*2.4)*(0.45+0.55*wRock+0.40*wGravel+0.20*wGrass);
      float pLand=smoothstep(0.4,4.0,vPositionW.y);
      normalW = normalize(nW + vec3(-(pHR-pHL), 0.0, -(pHU-pHD)) * (1.5*pdFade*pLand*pStr));
      // Lumpy canopy normal (§8d): treetops catch the sun, valleys self-shade — dimensional forest relief.
      if (forestF > 0.003) {
        vec2  cq  = vPositionW.xz * 0.085;
        float c0  = sin(cq.x) * sin(cq.y);
        float cgx = (sin(cq.x + 0.15) * sin(cq.y) - c0) / 0.15;
        float cgz = (sin(cq.x) * sin(cq.y + 0.15) - c0) / 0.15;
        normalW = normalize(normalW + vec3(-cgx, 0.0, -cgz) * (forestF * 0.32));   // softer: cut canopy sheen
      }
    `);

    // Cloud shadows + aerial haze on the lit colour (matches the Standard path + the ocean).
    // NOTE: must run at Before_Fog, not Before_FinalColorComposition. On PBRCustomMaterial the
    // composed final-color vec4 is named `finalColor` and is only DECLARED inside the
    // FinalColorComposition block, so it does not exist yet at the *Before* hook (that hook is where
    // StandardMaterial exposes `color`, which PBR does not). Before_Fog injects right after finalColor
    // is composed, still in linear/pre-tonemap space -> correct spot for cloud shadow + aerial haze.
    mat.Fragment_Before_Fog(`
      if (uSunDir.y > 0.03 && uCloudCoverage > 0.02) {
        vec2 sp = vPositionW.xz + uSunDir.xz / max(uSunDir.y, 0.15) * uCloudBaseH + uCloudDrift;
        vec2 a0 = sp*0.0013; vec2 i0=floor(a0); vec2 f0=fract(a0); f0=f0*f0*(3.0-2.0*f0);
        float n0=mix(mix(fract(sin(dot(i0,vec2(127.1,311.7)))*43758.5453),fract(sin(dot(i0+vec2(1.,0.),vec2(127.1,311.7)))*43758.5453),f0.x),
                     mix(fract(sin(dot(i0+vec2(0.,1.),vec2(127.1,311.7)))*43758.5453),fract(sin(dot(i0+vec2(1.,1.),vec2(127.1,311.7)))*43758.5453),f0.x),f0.y);
        vec2 a1 = sp*0.0037; vec2 i1=floor(a1); vec2 f1=fract(a1); f1=f1*f1*(3.0-2.0*f1);
        float n1=mix(mix(fract(sin(dot(i1,vec2(127.1,311.7)))*43758.5453),fract(sin(dot(i1+vec2(1.,0.),vec2(127.1,311.7)))*43758.5453),f1.x),
                     mix(fract(sin(dot(i1+vec2(0.,1.),vec2(127.1,311.7)))*43758.5453),fract(sin(dot(i1+vec2(1.,1.),vec2(127.1,311.7)))*43758.5453),f1.x),f1.y);
        float cf = n0*0.65 + n1*0.35;
        float cShadow = smoothstep(0.58-uCloudCoverage*0.45, 0.70-uCloudCoverage*0.30, cf) * smoothstep(0.05,0.35,uCloudCoverage) * smoothstep(0.03,0.18,uSunDir.y);
        finalColor.rgb *= 1.0 - cShadow*0.55;
      }
      // S6 art: small terrain-only residual lift for off-noon (the scene sun-intensity plateau + ambient now
      // carry most of the "sunny all day" work). Grows as the sun lowers, ~0 near noon, OFF below the horizon.
      float aboveH  = smoothstep(-0.02, 0.06, uSunDir.y);
      float dayLift = 1.0 + 0.30 * aboveH * (1.0 - smoothstep(0.12, 0.92, uSunDir.y));
      finalColor.rgb *= dayLift;
      /* Cannon muzzle-flash glow on the land. A dynamic point light does not reach this custom PBR
         material (it stopped dead at the water's edge), so we fake it exactly like the ocean's flash:
         the SAME warm colour + gaussian falloff SHAPE, so the pool reads continuously across the
         waterline. The spread (uCannonFlash.w) is wider than the sea's tight ~16 m pool only because the
         muzzle is over water, so the shore is across a gap. uCannonFlash = (worldX, worldZ, strength, spread). */
      if (uCannonFlash.z > 0.001) {
        float fr   = length(vPositionW.xz - uCannonFlash.xy);
        float fall = exp(-(fr * fr) / max(uCannonFlash.w, 1.0));
        float landF = smoothstep(-0.4, 0.8, vPositionW.y);     /* start at the waterline, fade inland-up */
        finalColor.rgb += vec3(1.0, 0.52, 0.18) * (uCannonFlash.z * fall * landF);
      }
      float hazeDist = length(vPositionW - vEyePosition.xyz);
      float hazeF = clamp(pow(1.0 - exp(-hazeDist*0.00020), 1.4), 0.0, 0.96);
      finalColor.rgb = mix(finalColor.rgb, uHazeColor, hazeF);
    `);

    mat.onBindObservable.add(() => {
      const fx = mat.getEffect();
      if (!fx) { return; }
      fx.setFloat('uPeakH', peakH);
      fx.setFloat('u_waterlineDither', this._inRefractionPass ? 0 : 1);
      fx.setColor3('uHazeColor', scene.fogColor);
      fx.setVector3('uSunDir', this.sceneService.getSunDirection());
      fx.setFloat('uCloudCoverage', this.oceanService.getCloudCoverage());
      fx.setFloat('uCloudTime', this.oceanService.getOceanTime());
      const csf = this.oceanService.getCloudShadowField();
      fx.setFloat2('uCloudDrift', csf?.drift.x ?? 0, csf?.drift.y ?? 0);
      fx.setFloat('uCloudBaseH', csf?.cloudBase ?? 900);
      // Cannon muzzle flash: reuse the ocean's flash registry (every shot, local + remote, is recorded
      // there) and feed the STRONGEST active flash to the terrain glow. The point light can't light this
      // material, so this is what actually lights the shore — see the Fragment_Before_Fog block.
      const cf2 = this.oceanService.getCannonFlash();
      let flX = 0, flZ = 0, flEnv = 0;
      for (let i = 0; i < cf2.count; i++) {
        const env = Math.max(0, 1 - cf2.data[i * 4 + 2] / cf2.life);
        if (env > flEnv) { flEnv = env; flX = cf2.data[i * 4]; flZ = cf2.data[i * 4 + 1]; }
      }
      // strength = (1−t)^2 (sharp onset, quick fade — matches the ocean's env), lightly boosted so the
      // darker land albedo still reads. .w = gaussian spread (≈65–80 m pool; was 240 m — too wide vs the sea).
      fx.setFloat4('uCannonFlash', flX, flZ, flEnv * flEnv * 1.4, 1600.0);
      fx.setTexture('uAlbedoArr', this.biomeAlbedoArr ?? this.biomePlaceholderArr);
      fx.setTexture('uOrmArr', this.biomeOrmArr ?? this.biomePlaceholderArr);
      if (this.splatTex) { fx.setTexture('uSplat', this.splatTex); }
      fx.setFloat('uHasSplat', this.splatTex && this.splatTex.isReady() ? 1 : 0);
      if (this.auxTex) { fx.setTexture('uAux', this.auxTex); }
      fx.setFloat('uHasAux', this.auxTex && this.auxTex.isReady() ? 1 : 0);
      if (this.clipHeightTex) {
        fx.setTexture('heightTex', this.clipHeightTex);
        fx.setVector4('wbounds', this.clipWBounds);
        fx.setVector2('texSize', this.clipTexSize);
      }
    });

    // TEMP DIAGNOSTIC (remove once S0-S3 verified): WebGPU SPIR-V compile failures surface as
    // unhandled promise rejections, NOT via Material.onError. onCompiled DOES fire on success, so this
    // is our deterministic "the PBR terrain shader actually compiled" signal in the console.
    mat.onCompiled = () => console.info('[TerrainPBR] shader compiled OK');

    this.terrainMaterialPBR = mat;
    return mat;
  }

  // ── P4b: clipmap height texture (heightfield → GPU R32F) ─────────────────────
  private clipHeightTex: RawTexture | null = null;
  private clipWBounds = new Vector4(0, 0, 1, 1);
  private clipTexSize = new Vector2(1, 1);

  /** The GPU-resident heightfield (R32F + world bounds), for compute passes outside this service
   *  (e.g. GPU scatter placement). Null until the terrain material has been built. */
  getHeightFieldGPU(): { tex: RawTexture; wbounds: Vector4; texSize: Vector2 } | null {
    return this.clipHeightTex
      ? { tex: this.clipHeightTex, wbounds: this.clipWBounds, texSize: this.clipTexSize }
      : null;
  }

  private createClipHeightTexture(scene: Scene, m: TerrainManifest): void {
    if (this.clipHeightTex || !this.heightfield) { return; }
    const minE = m.minElevation ?? 0, maxE = m.maxElevation ?? m.targetPeakElevation;
    const n = m.width * m.height;
    const data = new Float32Array(n);
    const span = (maxE - minE) / m.quantizationLevels;
    for (let i = 0; i < n; i++) { data[i] = this.heightfield[i] * span + minE; }
    const tex = new RawTexture(
      data, m.width, m.height, Constants.TEXTUREFORMAT_R, scene,
      false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
    );
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.clipHeightTex = tex;
    this.clipWBounds = new Vector4(m.worldBounds.minX, m.worldBounds.minZ,
      m.worldBounds.maxX - m.worldBounds.minX, m.worldBounds.maxZ - m.worldBounds.minZ);
    this.clipTexSize = new Vector2(m.width, m.height);
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
    const { width, height, worldBounds, quantizationLevels, targetPeakElevation, minElevation, maxElevation } = this.manifest!;
    const hf       = this.heightfield!;
    const n        = width * height;
    const cellSizeM = (worldBounds.maxX - worldBounds.minX) / (width - 1);

    // Ocean test. Legacy PNG fields stored ocean as exactly 0. The signed unified field stores the
    // waterline (y = 0) at a POSITIVE quantized value (since minElevation < 0), so a cell is ocean
    // when its quantized height is at/below that waterline level.
    const signed = minElevation != null && maxElevation != null;
    const waterQ = signed ? Math.round(((0 - minElevation!) / (maxElevation! - minElevation!)) * quantizationLevels) : 0;
    const isWater = (q: number) => (signed ? q <= waterQ : q === 0);

    // ── 1. Distance transforms ────────────────────────────────────────────────
    const MAX16  = 0xFFFF;
    const distW  = new Uint16Array(n).fill(MAX16);   // land cell → nearest water
    const distL  = new Uint16Array(n).fill(MAX16);   // water cell → nearest land

    for (let i = 0; i < n; i++) {
      if (isWater(hf[i])) distW[i] = 0;
      else                distL[i] = 0;
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
    // Signed real-data fields keep their true coastlines (cliffs, headlands) — the artificial sandy
    // bevel was only needed for the old hand-drawn heightmap, and its land-only quantization math
    // (0..targetPeakElevation) would corrupt the signed encoding. So skip it entirely when signed.
    if (!signed) {
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

    // Signed unified field: the seabed depth IS the elevation (it's already negative underwater), so
    // there's no separate depth model — just return the real bathymetry. This collapses the mesh
    // builder's land/sea split to a single source and retires the fake exponential depth LUT.
    if (m.minElevation != null) return this.getElevation(worldX, worldZ);

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
