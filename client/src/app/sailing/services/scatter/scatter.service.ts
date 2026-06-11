import { Injectable, inject } from '@angular/core';
import {
  Color3, DynamicTexture, Material, Matrix, Mesh, MeshBuilder, Observer, Quaternion, Scene,
  StandardMaterial, Texture, Vector3,
} from '@babylonjs/core';
import { SceneService } from '../scene.service';
import { TerrainService } from '../terrain.service';
import { WeatherService } from '../weather.service';
import { ThinInstancePatch } from './instancing/thin-instance-patch';
import { IPatch } from './instancing/i-patch';
import { GpuScatterPatch } from './instancing/gpu-scatter-patch';
import {
  ScatterCompute, PadBox, GRASS_WGSL, ROCKS_WGSL, DRIFT_WGSL, TREES_WGSL, PALMS_WGSL,
} from './scatter-compute';
import { PatchManager } from './instancing/patch-manager';
import { createGrassBlade } from './grass/grass-blade';
import { createRock } from './props/rock';
import { createDriftwood } from './props/driftwood';
import { createTree } from './props/tree';
import { createPalm } from './props/palm';
import { GrassFadePlugin } from './grass/grass-fade.plugin';
import { PalmWindPlugin } from './props/palm-wind.plugin';
import { TreeWindPlugin } from './props/tree-wind.plugin';
import { ShadowBlobPlugin } from './props/shadow-blob.plugin';
import {
  loadScatterMesh, createCrossImpostor, measureBottomPad, loadScatterGeometry, buildScatterPBR,
  buildGrassMaterial, scatterTextureUrl, setScatterVersion, clearScatterCache,
} from './asset-loader';

const EMPTY = new Float32Array(0);
const EMPTY_PATCH: PatchData = { matrix: EMPTY, color: null };

/** Stone-colour palette (instance-colour multipliers; the rock material's diffuse is white). Each
 *  rock picks one and jitters it, so a beach reads as a mix of greys, tans, browns and slate. */
const STONE: ReadonlyArray<readonly [number, number, number]> = [
  [0.50, 0.49, 0.47],   // grey
  [0.60, 0.53, 0.42],   // tan / sandstone
  [0.43, 0.35, 0.28],   // brown
  [0.51, 0.39, 0.33],   // reddish
  [0.34, 0.35, 0.39],   // dark slate
  [0.64, 0.62, 0.58],   // pale grey
];
/** Weathered driftwood colours — bleached greys and faded browns. */
const DRIFTWOOD: ReadonlyArray<readonly [number, number, number]> = [
  [0.57, 0.51, 0.43],   // weathered tan
  [0.62, 0.58, 0.51],   // bleached grey
  [0.46, 0.40, 0.32],   // darker brown
  [0.66, 0.62, 0.56],   // pale driftwood
  [0.50, 0.45, 0.39],   // muted brown-grey
];
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
/** Sharper remap than smoothstep — the same [a,b] clamp but with a steeper mid-ramp, so a gate reads
 *  closer to hard on/off (used to carve crisp grass-bush edges with a totally-barren outside). */
function step01(a: number, b: number, x: number): number {
  const s = smoothstep(a, b, x);
  return s * s * (3 - 2 * s);
}
function hash2(x: number, z: number): number {
  return ((Math.sin(x * 127.1 + z * 311.7) * 43758.5453) % 1 + 1) % 1;
}
/** Smooth value noise in [0,1] — spatially coherent, so plants form real clumps (not random dots). */
function vnoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
/** Fractal (multi-octave) value noise in [0,1] — sums finer, weaker octaves onto the base clump so
 *  the intensity within a clump breaks into layered sub-detail instead of one smooth blob. */
function fbm2(x: number, z: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * vnoise(x * freq + o * 19.3, z * freq - o * 7.1);
    norm += amp;
    amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

/** One scatter layer (currently just land grass): its own material, LoD patch manager, live patch
 *  grid, and per-cell instance-buffer builder. Kept generic so more layers can be added later. */
interface Layer {
  mat: Material;
  manager: PatchManager;
  patches: Map<string, IPatch | null>;
  build: (cx: number, cz: number) => PatchData;
  /** GPU placement (WebGPU-compute roadmap P3): when set, ensurePatches uses this instead of `build`
   *  — the returned patch's instances are computed AND stored on the GPU (null = patch known-empty). */
  buildGpu?: (cx: number, cz: number) => GpuScatterPatch | null;
  /** Hidden base/LoD meshes this layer thin-instances — disposed on teardown (/reloadassets rebuild). */
  baseMeshes: Mesh[];
  /** Optional smaller patch ring (in cells) — used by the fake-shadow layers so blobs only build/keep
   *  within a near radius around the camera (cheap). Undefined → the full scatter RADIUS. */
  maxRing?: number;
}

/** A patch's instance data: the N×16 matrix buffer, and an optional N×4 per-instance colour buffer. */
interface PatchData { matrix: Float32Array; color: Float32Array | null; }

/** A LoD tier: mesh detail (`stacks` for grass / subdivisions for rocks), the distance it covers out
 *  to, and the fraction of a patch's instances to draw. Nearest-first; farthest = `Infinity`. */
interface LodTier { stacks: number; nearerThan: number; fraction: number; }

/**
 * Per-biome asset scattering using thin instances + LoD patches that follow the camera. Instancing
 * technique ported from Barthélemy Paléologue's "AssetScattering" (MIT). Each layer (currently land
 * grass) uses a StandardMaterial (thin instances + scene lighting/fog work natively on our WebGPU
 * engine, unlike a custom ShaderMaterial) with the GrassFadePlugin for wind sway + draw-radius
 * dissolve. Density + draw radius scale with the graphics-quality tier (see QUALITY).
 */
@Injectable({ providedIn: 'root' })
export class ScatterService {
  private sceneService   = inject(SceneService);
  private terrainService = inject(TerrainService);
  private weatherService = inject(WeatherService);

  private layers: Layer[] = [];
  private observer: Observer<Scene> | null = null;
  private _palmTime = 0;   // palm wind clock (advanced each frame from the weather wind)

  // Fake-shadow blobs (shared flat disc + dark decal material, thin-instanced under each land asset).
  private _shadowDisc: Mesh | null = null;
  private _shadowMat: StandardMaterial | null = null;
  private shadowRing = 3;                            // near ring (cells) the blobs build within
  private _sunAcc = 1;                               // throttle the sun-drive recompute (the sun crawls)
  private static readonly SHADOWS_ENABLED = true;
  private static readonly SHADOW_LIFT = 0.06;        // raise the decal off the ground (z-fight guard)
  private readonly _shadowQ = new Quaternion();      // identity — blobs aren't rotated per-instance

  // Reusable temporaries (avoid per-instance allocation in the build loops).
  private readonly _scaleV = new Vector3();
  private readonly _posV = new Vector3();
  private readonly _up = Vector3.UpReadOnly;
  private readonly _q = new Quaternion();            // scratch — avoid per-instance allocation in build loops
  private readonly _mat = new Matrix();
  private readonly _stride = new Float32Array(16);   // scratch for the instance shuffle

  // Harbor-town pad rectangles (cached) — NO scatter is placed inside them (no trees in the fountain).
  private townPads: { cx: number; cz: number; hx: number; hz: number; sin: number; cos: number; r: number }[] | null = null;

  // ── Tuning ──────────────────────────────────────────────────────────────────
  private readonly PATCH = 40;          // metres per patch
  private readonly MAX_BUILDS_PER_FRAME = 3;  // builds (across all layers) per frame — stream in gently

  // ── Quality (driven by the graphics presets / settings menu) ─────────────────
  // Each tier sets the draw radius (rings of patches) and a density multiplier on the grass.
  private static readonly QUALITY = [
    { radius: 0,  density: 0,    enabled: false },   // 0 Potato — no grass at all
    { radius: 5,  density: 0.55, enabled: true  },   // 1 Low
    { radius: 7,  density: 0.80, enabled: true  },   // 2 Medium
    { radius: 8,  density: 1.0,  enabled: true  },   // 3 High
    { radius: 10, density: 1.0,  enabled: true  },   // 4 Ultra
  ] as const;
  private _quality = (() => {
    const q = parseInt(localStorage.getItem('ignis_scatter_quality') ?? '3', 10);
    return Number.isFinite(q) ? Math.max(0, Math.min(4, q)) : 3;
  })();
  private RADIUS = 8;                   // patch rings (set from quality); edge dissolved by the fade plugin
  private densityMul = 1;               // grass acceptance multiplier (set from quality)
  private enabled = true;               // false → no grass built at all (Potato)
  // ensurePatches throttle: skip the grid scan/cull while the camera stays in its 40 m cell with all
  // patches built. _patchPending = still filling in this cell (build cap not yet drained).
  private _lastCx = NaN; private _lastCz = NaN; private _patchPending = true;
  // Adaptive streaming. _hasFilledOnce = have we completed the FIRST fill-from-empty yet? Until then we run
  // "aggressive" (bigger time/commit budget) so the initial load snaps in — a brief stutter is invisible
  // while the screen is still appearing. Once filled, every later top-up (sailing across a cell boundary)
  // is GENTLE so it never hiccups, even though a leading edge legitimately takes a few frames to fill. NOT
  // streak-based on purpose: a cell-cross adds a multi-frame backlog too, so "sustained backlog" can't tell
  // sailing apart from the initial load — "have we ever finished filling" can. _ringOffsets = cell deltas
  // sorted NEAREST-FIRST so the budget always lands on the most-visible patches; cached per RADIUS.
  private _hasFilledOnce = false;
  private _aggressive = false;
  private _ringOffsets: { dx: number; dz: number }[] | null = null;
  private _ringR = -1;
  private _cellM = 0;   // world m per heightfield texel (~24) — slope-sampling baseline (lazy from terrain)

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    const cam = this.sceneService.camera;
    if (!scene || !cam) { return; }

    this.applyQualityParams(this._quality);   // radius / density / enabled + fade band (no rebuild yet)

    await this.buildLayers(scene);             // grass + the authored-GLB scatter layers (streamed)

    if (this.enabled) { this.ensurePatches(); }
    for (const l of this.layers) { l.manager.initInstances(); }

    this.observer = scene.onBeforeRenderObservable.add(() => {
      const c = this.sceneService.camera;
      if (c) { GrassFadePlugin.camera.x = c.position.x; GrassFadePlugin.camera.z = c.position.z; }
      // Drive the palm wind from the weather wind (the same source the sails use): unit direction +
      // a gust amplitude that grows with wind speed, plus a steadily-advancing clock.
      const wd = this.weatherService.weather()?.wind;
      if (wd) {
        const mag = Math.hypot(wd.x, wd.z) || 1;
        const dx = wd.x / mag, dz = wd.z / mag;
        const gust = Math.min(1, (wd.speed ?? 8) / 24);   // 0 calm → 1 gale
        PalmWindPlugin.WIND.dirX = dx;
        PalmWindPlugin.WIND.dirZ = dz;
        PalmWindPlugin.WIND.amplitude = 0.10 + gust * 0.30;
        TreeWindPlugin.WIND.dirX = dx;
        TreeWindPlugin.WIND.dirZ = dz;
        // Canopy sway kept SMALL on purpose: a larger silhouette swing exposes a halo against the
        // volumetric clouds (the cloud depth pass can't replicate the per-vertex sway), so we trade a
        // little motion for a clean edge. Gentle lean + faint shimmer only.
        TreeWindPlugin.WIND.branchAmp = 0.05 + gust * 0.10;   // whole-canopy sway grows with wind
        TreeWindPlugin.WIND.leafAmp   = 0;                    // leaf flutter off — it wiggled the canopy edge and drove the cloud halo
      }
      this._palmTime += (scene.getEngine().getDeltaTime() / 1000) * 1.4;
      PalmWindPlugin.WIND.time = this._palmTime;
      TreeWindPlugin.WIND.time = this._palmTime;
      // Fake-shadow blobs: point them away from the sun, lengthen as it lowers, fade out at night.
      // Per-instance matrices stay baked; only this handful of uniforms + the material alpha change.
      // The sun crawls, so recompute a few times a second rather than every frame.
      this._sunAcc += scene.getEngine().getDeltaTime() / 1000;
      if (this._shadowMat && this._sunAcc >= 0.5) {
        this._sunAcc = 0;
        const sun = this.sceneService.getSunDirection();
        let hx = -sun.x, hz = -sun.z;
        const hl = Math.hypot(hx, hz);
        if (hl > 1e-3) { hx /= hl; hz /= hl; } else { hx = 0; hz = 1; }
        ShadowBlobPlugin.SHADOW.dirX = hx;
        ShadowBlobPlugin.SHADOW.dirZ = hz;
        const stretch = Math.max(1, Math.min(3.5, 1 / Math.max(sun.y, 0.30)));
        ShadowBlobPlugin.SHADOW.stretch = stretch;
        // Fade out at night, and softer/fainter as the shadow stretches long (low-sun shadows are diffuse penumbra).
        this._shadowMat.alpha = 0.30 * smoothstep(0.0, 0.16, sun.y) * (1.0 - 0.12 * (stretch - 1.0));
      }
      this.ensurePatches();
      // LoD re-eval is cheap (rate-limited internally); the queue DRAIN is the GPU-heavy bit (geometry
      // clone + thin-instance buffer upload). Drain it on ONE budget shared across all layers, round-robin,
      // so a leading ring of several layers can't spike into 3×N clones in a single frame (the sailing
      // hiccup). Generous during an aggressive fill, tight while cruising.
      for (const l of this.layers) { l.manager.reevaluateLod(); }
      let commitBudget = this._aggressive ? 24 : 6;
      let drainedAny = true;
      while (commitBudget > 0 && drainedAny) {
        drainedAny = false;
        for (const l of this.layers) {
          if (commitBudget <= 0) { break; }
          if (l.manager.drainQueue(1) > 0) { commitBudget--; drainedAny = true; }
        }
      }
    });
  }

  /** Build every scatter layer (grass + the authored-GLB groups). Called once by init(), and again by
   *  reloadAssets() after a /reloadassets version bump so edited GLBs re-stream live. */
  private async buildLayers(scene: Scene): Promise<void> {
    // Land grass — authored CLUMP GLBs (3 tussock variants, scattered at clump density, NOT per-blade).
    // Retires the old custom grass ShaderMaterial (which failed to compile on WebGPU). (Names start with
    // `scatter_` so the ocean refraction RTT's exclusion predicate skips foliage.)
    // DISABLED for now (GRASS_ENABLED=false): the current clump models are too expensive — awaiting
    // better authored grass. Flip the flag back to true to restore it.
    if (ScatterService.GRASS_ENABLED) { await this.registerGrass(scene); }

    // Authored-GLB groups (streamed from the server, cached): beach rocks (5 shapes, size pebble→
    // boulder + tint), driftwood (5 shapes, twig→log + tint), forest beeches (A/B/C, two-channel
    // wind), beach palms (A/B/C, wind sway). Each falls back to its primitive if a GLB fails.
    await this.registerRocks(scene);
    await this.registerDriftwood(scene);
    await this.registerBeeches(scene);
    await this.registerPalms(scene);

    // Cheap fake shadows: a flat dark blob under each static land asset, near-ring only. Skipped on
    // Potato (no scatter) and via ?noshadows. Must come AFTER the asset layers so the asset placement
    // exists to mirror.
    if (this.enabled && ScatterService.SHADOWS_ENABLED && !location.search.includes('noshadows')) {
      this.registerShadows(scene);
    }
  }

  /** Dispose every layer's patches, manager, base meshes and materials (deduped — rocks/driftwood
   *  share one material across their shape sub-layers). Used by dispose() and the /reloadassets rebuild. */
  private teardownLayers(): void {
    // GPU scatter: drop the dispatch queues + compute shaders before the patches go (a fresh
    // register pass recreates them — and a /reloadassets rebuild may land on a different engine).
    for (const sc of this.scatterComputes.values()) { sc.dispose(); }
    this.scatterComputes.clear();
    const meshes = new Set<Mesh>(), mats = new Set<Material>();
    for (const l of this.layers) {
      for (const [, p] of l.patches) { p?.dispose(); }
      l.patches.clear();
      l.manager.dispose();
      for (const m of l.baseMeshes) { meshes.add(m); if (m.material) { mats.add(m.material); } }
      if (l.mat) { mats.add(l.mat); }
    }
    for (const m of meshes) { m.dispose(); }
    for (const mm of mats) { mm.dispose(); }
    this.layers = [];
    this._shadowDisc = null; this._shadowMat = null;   // disposed above (shared across the blob layers)
    this.townPads = null;                              // re-fetch town pads after a region/manifest change
  }

  /** /reloadassets: bump the cache-bust version, drop the cached containers, tear down the live layers
   *  and rebuild them — so edited scatter GLBs/textures re-stream from the server live (mirrors the
   *  vessel cache). The camera observer stays; it reads `this.layers` each frame, so it picks up the
   *  rebuilt set automatically. */
  async reloadAssets(version: number): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene) { return; }
    setScatterVersion(version);
    clearScatterCache();
    this.teardownLayers();
    await this.buildLayers(scene);
    this._lastCx = NaN; this._patchPending = true; this._hasFilledOnce = false;   // fresh layers → aggressive refill
    if (this.enabled) { this.ensurePatches(); }
    for (const l of this.layers) { l.manager.initInstances(); }
  }

  // ── Land grass (authored clump GLBs) ────────────────────────────────────────

  private static readonly GRASS_CLUMPS = [
    { file: 'grass_a.glb', lod: 'grass_a_lod.glb' },   // medium tussock
    { file: 'grass_b.glb', lod: 'grass_b_lod.glb' },   // tall sparse
    { file: 'grass_c.glb', lod: 'grass_c_lod.glb' },   // short bushy
  ];

  /** Per-instance grass tints (multiply the base→tip gradient albedo): lush → green → yellow-green →
   *  dry → straw. Synced to the updated asset's intended palette (GRASS_ASSET.md / grass.js
   *  GRASS_TINTS — brighter than the old set, tuned for the new gradient albedo).
   *  KEEP IN SYNC with the GPU kernel's tints array in scatter-compute.ts GRASS_WGSL. */
  private static readonly GRASS_TINTS: ReadonlyArray<readonly [number, number, number]> = [
    [0.88, 1.00, 0.78], [1.00, 1.00, 0.72], [1.05, 0.92, 0.55], [1.12, 0.84, 0.42], [1.15, 0.95, 0.55],
  ];

  /** Load the 3 authored grass CLUMP GLBs (geometry-only) sharing ONE matte double-sided gradient
   *  material, with a real *_lod.glb far-LOD per clump, and register one scatter sub-layer per variant.
   *  Wind: draw-radius dissolve (GrassFadePlugin) + clump-scale sway/flutter (TreeWindPlugin). On any
   *  load failure → no grass (the old ShaderMaterial blade system is retired). */
  /** Master on/off for the grass layer. Off while the current clump GLBs are too costly to render —
   *  set true again once the replacement grass models land. */
  private static readonly GRASS_ENABLED = false;

  private async registerGrass(scene: Scene): Promise<void> {
    const mat = buildGrassMaterial(scene, 'scatter_grass_mat', 'grass_albedo.png');
    new GrassFadePlugin(mat, 0);   // draw-radius dissolve only (no sway here — TreeWind does the wind)
    new TreeWindPlugin(mat, { flutter: true, swayStart: 0.05, swayFull: 0.85, ampScale: 0.7 });
    this.sceneService.excludeFromPrePass(mat);

    // GPU placement (roadmap P3): the whole buildGrass loop (gates + clustering + burst + matrix
    // compose) runs as a compute kernel writing straight into the patch's vertex buffers. CPU cost
    // per patch drops to a coarse water pre-gate + buffer allocation.
    const gpu = this.gpuScatterEnabled();

    for (let v = 0; v < ScatterService.GRASS_CLUMPS.length; v++) {
      const cfg = ScatterService.GRASS_CLUMPS[v];
      // useVertexColors=false: grass COLOR_0 is WIND data, not albedo.
      const full = await loadScatterGeometry(scene, cfg.file, `scatter_grass_${v}_full`, mat, false);
      const lod  = await loadScatterGeometry(scene, cfg.lod,  `scatter_grass_${v}_lod`,  mat, false);
      if (!full || !lod) { console.warn(`[scatter] grass clump ${v} (${cfg.file}) failed — skipping grass`); return; }
      this.sceneService.excludeFromGlow(full);
      this.sceneService.excludeFromGlow(lod);
      const layer = this.makeGlbLayer(full, lod, 45, (cx, cz) => this.buildGrass(cx, cz, v));
      if (gpu) { layer.buildGpu = (cx, cz) => this.buildScatterGpu('grass', cx, cz, v); }
      this.layers.push(layer);
    }
  }

  /** Per-layer GPU patch config: kernel kind, instance capacity, the pre-gate altitude band, the
   *  vertical headroom for the culling box, and whether the material reads instance colors. */
  private static readonly GPU_LAYERS = {
    grass: { wgsl: GRASS_WGSL, capacity: 1800, yLo: 0.6,  yHi: 140, headroom: 4,  color: true },
    rocks: { wgsl: ROCKS_WGSL, capacity: 576,  yLo: 0.25, yHi: 150, headroom: 5,  color: true },
    drift: { wgsl: DRIFT_WGSL, capacity: 400,  yLo: 0.25, yHi: 7,   headroom: 3,  color: true },
    trees: { wgsl: TREES_WGSL, capacity: 256,  yLo: 0.6,  yHi: 80,  headroom: 16, color: false },
    palms: { wgsl: PALMS_WGSL, capacity: 196,  yLo: 0.6,  yHi: 45,  headroom: 12, color: false },
  } as const;

  /** Lazily-created per-kernel dispatchers (each owns its UBO → one dispatch per kernel per frame). */
  private readonly scatterComputes = new Map<string, ScatterCompute>();

  /** True when this session should place scatter on the GPU (WebGPU + not opted out). A/B escape
   *  hatch: localStorage.setItem('ignis_scatter_gpu','0') + reload forces the CPU builders. */
  private gpuScatterEnabled(): boolean {
    return this.sceneService.isWebGPU && localStorage.getItem('ignis_scatter_gpu') !== '0';
  }

  private getCompute(kind: keyof typeof ScatterService.GPU_LAYERS): ScatterCompute {
    let sc = this.scatterComputes.get(kind);
    if (!sc) {
      const scene = this.sceneService.scene;
      sc = new ScatterCompute(
        scene.getEngine() as import('@babylonjs/core').WebGPUEngine, scene,
        kind, ScatterService.GPU_LAYERS[kind].wgsl,
        () => this.terrainService.getHeightFieldGPU(),
      );
      this.scatterComputes.set(kind, sc);
    }
    return sc;
  }

  /** GPU scatter patch: a coarse 3×3 water/altitude pre-gate (9 fast height reads — patches over
   *  open sea or outside the layer's band allocate nothing), then buffers + a queued compute
   *  dispatch do the rest. shadowMode places the layer's flat blob discs instead of meshes. */
  private buildScatterGpu(kind: keyof typeof ScatterService.GPU_LAYERS,
                          cx: number, cz: number, variant: number, shadowMode = 0): GpuScatterPatch | null {
    const cfg = ScatterService.GPU_LAYERS[kind];
    const half = this.PATCH / 2;
    let yMin = Infinity, yMax = -Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const y = this.terrainService.getElevationFast(cx + i * half, cz + j * half);
        yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
      }
    }
    // The 3×3 probe undersamples a 40 m patch — pad the band so a coastal texel can't false-reject.
    if (yMax < cfg.yLo - 2 || yMin > cfg.yHi + 10) { return null; }

    const pads: PadBox[] = this.townPadsNear(cx, cz).slice(0, 2);
    const engine = this.sceneService.scene.getEngine() as import('@babylonjs/core').WebGPUEngine;
    const patch = new GpuScatterPatch(
      engine, new Vector3(cx, 0, cz), cfg.capacity, half + 1,
      yMin - 2, yMax + cfg.headroom,
      shadowMode ? false : cfg.color,   // shadow discs must not gain a 'color' kind either
    );
    this.getCompute(kind).enqueue(patch, cx, cz, variant, this.PATCH, this.densityMul, pads, shadowMode);
    return patch;
  }

  // ── Beach palms (authored GLB variants) ─────────────────────────────────────

  private static readonly PALM_VARIANTS = [
    { file: 'palm_a.glb', impostor: 'impostor_a.png', height: 8.0 },   // medium, slight lean
    { file: 'palm_b.glb', impostor: 'impostor_b.png', height: 9.6 },   // tall, slim
    { file: 'palm_c.glb', impostor: 'impostor_c.png', height: 6.6 },   // short, stout, full crown
  ];

  /** Load the authored palm GLBs (streamed + cached), attach baked wind + a crossed-quad impostor
   *  far-LOD, and register one scatter sub-layer per variant. Any load failure → the primitive palm. */
  private async registerPalms(scene: Scene): Promise<void> {
    for (let v = 0; v < ScatterService.PALM_VARIANTS.length; v++) {
      const cfg = ScatterService.PALM_VARIANTS[v];
      const full = await loadScatterMesh(scene, cfg.file, `scatter_palm_${v}_full`);
      if (!full || !full.material) {
        console.warn(`[scatter] palm variant ${v} (${cfg.file}) failed — using primitive palms`);
        this.registerPalmFallback(scene);
        return;
      }
      this.groundToBase(full);
      new PalmWindPlugin(full.material);
      this.sceneService.excludeFromGlow(full);
      this.sceneService.excludeFromPrePass(full.material);
      // Freeze: the wind animates via the plugin's bindForSubMesh (which still runs when frozen), so this
      // just stops the per-submesh readiness re-checks across every palm patch clone — free CPU.
      full.material.freeze();

      const impUrl = scatterTextureUrl(cfg.impostor);
      const tex = new Texture(impUrl, scene);
      const pad = await measureBottomPad(impUrl, 0.08);   // sink the billboard so the trunk meets the ground
      const imp = createCrossImpostor(scene, `scatter_palm_${v}_imp`, tex, cfg.height * 0.85, cfg.height, pad);
      this.sceneService.excludeFromGlow(imp);
      if (imp.material) { this.sceneService.excludeFromPrePass(imp.material); }

      const layer = this.makeGlbLayer(full, imp, 130, (cx, cz) => this.buildPalms(cx, cz, v));
      if (this.gpuScatterEnabled()) { layer.buildGpu = (cx, cz) => this.buildScatterGpu('palms', cx, cz, v); }
      this.layers.push(layer);
    }
  }

  // ── Forest beeches (authored GLB variants) ──────────────────────────────────

  private static readonly BEECH_VARIANTS = [
    { file: 'beech_a.glb', impostor: 'beech_impostor_a.png', w: 17.07, h: 11.27 },   // medium broad
    { file: 'beech_b.glb', impostor: 'beech_impostor_b.png', w: 19.31, h: 13.30 },   // taller, fuller
    { file: 'beech_c.glb', impostor: 'beech_impostor_c.png', w: 14.98, h: 10.63 },   // short, very broad
  ];

  /** Load the authored beech GLBs (streamed + cached), attach two-channel tree wind + a crossed-quad
   *  impostor far-LOD, and register one scatter sub-layer per variant. Any load failure → primitive. */
  private async registerBeeches(scene: Scene): Promise<void> {
    for (let v = 0; v < ScatterService.BEECH_VARIANTS.length; v++) {
      const cfg = ScatterService.BEECH_VARIANTS[v];
      const full = await loadScatterMesh(scene, cfg.file, `scatter_beech_${v}_full`);
      if (!full || !full.material) {
        console.warn(`[scatter] beech variant ${v} (${cfg.file}) failed — using primitive trees`);
        this.registerTreeFallback(scene);
        return;
      }
      this.groundToBase(full);
      new TreeWindPlugin(full.material, { flutter: true });   // leaf shimmer; default canopy band 1.5→8 m
      this.sceneService.excludeFromGlow(full);
      this.sceneService.excludeFromPrePass(full.material);
      full.material.freeze();   // wind still animates (plugin bind runs when frozen); skips readiness re-checks

      const impUrl = scatterTextureUrl(cfg.impostor);
      const tex = new Texture(impUrl, scene);
      const pad = await measureBottomPad(impUrl, 0.12);   // sink the billboard so the trunk meets the ground
      const imp = createCrossImpostor(scene, `scatter_beech_${v}_imp`, tex, cfg.w, cfg.h, pad);
      this.sceneService.excludeFromGlow(imp);
      if (imp.material) { this.sceneService.excludeFromPrePass(imp.material); }

      // Beeches are ~2× the palm's tris — swap to the impostor earlier (85 m vs 130 m).
      const layer = this.makeGlbLayer(full, imp, 85, (cx, cz) => this.buildTrees(cx, cz, v));
      if (this.gpuScatterEnabled()) { layer.buildGpu = (cx, cz) => this.buildScatterGpu('trees', cx, cz, v); }
      this.layers.push(layer);
    }
  }

  /** A GLB tree sub-layer: full mesh near, crossed-quad impostor far, swapped per-patch by distance. */
  private makeGlbLayer(full: Mesh, imp: Mesh, near: number, build: (cx: number, cz: number) => PatchData): Layer {
    const manager = new PatchManager([imp, full], (patch) => {
      const c = this.sceneService.camera;
      const d = c ? Vector3.Distance(patch.getPosition(), c.position) : Infinity;
      return d < near ? 1 : 0;   // 1 = full (near), 0 = impostor (far)
    }, [1, 1]);
    manager.setLodUpdateCadence(this.MAX_BUILDS_PER_FRAME);
    return { mat: full.material as Material, manager, patches: new Map(), build, baseMeshes: [imp, full] };
  }

  // ── Fake shadow blobs (cheap cast-shadow decals for the static land assets) ──

  /** Build the shared shadow decal (a flat soft-edged dark disc) and register one near-ring shadow
   *  layer per land asset TYPE. Each reuses that type's existing placement in "shadow mode" (variant
   *  -1 → keep every candidate), so the blobs are a single source of truth with the assets — one disc
   *  per palm/tree/rock/log. The `ShadowBlobPlugin` stretches each round disc away from the sun. */
  private registerShadows(scene: Scene): void {
    // Soft radial-gradient alpha (opaque centre → transparent rim) → a vague blurry blob. Smooth multi-stop
    // falloff at 128px = a wide diffuse penumbra (no hard ring), which reads far less like a flat decal.
    const grad = new DynamicTexture('scatter_shadow_grad', 128, scene, false);
    const ctx = grad.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(64, 64, 1, 64, 64, 63);
    g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.30, 'rgba(255,255,255,0.82)');
    g.addColorStop(0.60, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.82, 'rgba(255,255,255,0.16)');
    g.addColorStop(1.00, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    grad.update();
    grad.hasAlpha = true;

    const mat = new StandardMaterial('scatter_shadow_mat', scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = new Color3(0.02, 0.03, 0.05);   // dark COOL shadow (picks up sky ambient) — not dead black
    mat.disableLighting = true;            // the disc darkens the ground beneath it (cool-tinted)
    mat.opacityTexture = grad;             // radial alpha → soft edge
    mat.alpha = 0.30;                      // base opacity (modulated each frame by sun elevation + stretch)
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;          // a decal: blend over the terrain, don't fight other blobs
    new ShadowBlobPlugin(mat);             // stretch away from the sun (GLSL + WGSL)
    this.sceneService.excludeFromPrePass(mat);
    this._shadowMat = mat;

    // Unit ground quad in XZ (the plugin works in this disc's local space). Name `scatter_…` so the
    // patch clones inherit the ocean-refraction / glow exclusions (shadows never show underwater).
    const disc = MeshBuilder.CreateGround('scatter_shadow_disc', { width: 1, height: 1 }, scene);
    disc.material = mat;
    disc.isVisible = false;
    disc.isPickable = false;
    this.sceneService.excludeFromGlow(disc);
    this._shadowDisc = disc;

    // One near-ring shadow layer per asset type (all share the disc + material + manager-clone path).
    // GPU mode: the SAME placement kernels run with shadowMode=1 (variant -1 keeps all candidates)
    // and emit flat blob discs instead of meshes.
    const shadows: Array<[keyof typeof ScatterService.GPU_LAYERS, (cx: number, cz: number) => PatchData]> = [
      ['rocks', (cx, cz) => this.buildRocks(cx, cz, -1, true)],
      ['drift', (cx, cz) => this.buildDriftwood(cx, cz, -1, true)],
      ['trees', (cx, cz) => this.buildTrees(cx, cz, -1, true)],
      ['palms', (cx, cz) => this.buildPalms(cx, cz, -1, true)],
    ];
    for (const [kind, build] of shadows) {
      const layer = this.makeShadowLayer(disc, build);
      if (this.gpuScatterEnabled()) { layer.buildGpu = (cx, cz) => this.buildScatterGpu(kind, cx, cz, -1, 1); }
      this.layers.push(layer);
    }
  }

  /** A shadow sub-layer: a single-LoD (no distance swap) manager over the shared disc, capped to the
   *  near shadow ring so distant blobs are never built. */
  private makeShadowLayer(disc: Mesh, build: (cx: number, cz: number) => PatchData): Layer {
    const manager = new PatchManager([disc], () => 0, [1]);
    manager.setLodUpdateCadence(this.MAX_BUILDS_PER_FRAME);
    return { mat: disc.material as Material, manager, patches: new Map(), build, baseMeshes: [disc], maxRing: this.shadowRing };
  }

  /** Compose one flat shadow-disc instance: a round decal of the given footprint radius laid on the
   *  ground at (px,pz). No rotation (the plugin handles the sun-direction stretch). */
  private composeShadow(buf: Float32Array, idx: number, px: number, groundY: number, pz: number, radius: number): void {
    this._scaleV.set(radius * 2, 1, radius * 2);   // ground quad is 1×1 → scale = diameter
    this._posV.set(px, groundY + ScatterService.SHADOW_LIFT, pz);
    Matrix.ComposeToRef(this._scaleV, this._shadowQ, this._posV, this._mat);
    this._mat.copyToArray(buf, idx * 16);
  }

  /** Fallback: the old procedural-primitive palm as a single (all-variant) scatter layer. */
  private registerPalmFallback(scene: Scene): void {
    this.layers.push(this.makeLayer(scene, 'scatter_palms', new Color3(1, 1, 1), 0, [
      { stacks: 2, nearerThan: 130,      fraction: 1.0 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.7 },
    ], (cx, cz) => this.buildPalms(cx, cz, -1), createPalm, false));
  }

  /** Fallback: the old procedural-primitive forest tree as a single (all-variant) scatter layer. */
  private registerTreeFallback(scene: Scene): void {
    this.layers.push(this.makeLayer(scene, 'scatter_trees', new Color3(1, 1, 1), 0, [
      { stacks: 2, nearerThan: 110,      fraction: 1.0 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.6 },
    ], (cx, cz) => this.buildTrees(cx, cz, -1), createTree, false));
  }

  // ── Beach rocks (authored geometry-only GLB shapes) ─────────────────────────

  private static readonly ROCK_SHAPES = [
    { file: 'rock_a.glb', lod: 'rock_a_lod.glb' },   // rounded boulder
    { file: 'rock_b.glb', lod: 'rock_b_lod.glb' },   // angular faceted
    { file: 'rock_c.glb', lod: 'rock_c_lod.glb' },   // flat slab
    { file: 'rock_d.glb', lod: 'rock_d_lod.glb' },   // chunky
    { file: 'rock_e.glb', lod: 'rock_e_lod.glb' },   // small pebble
  ];

  /** Per-instance stone tints (multiply the neutral-gray albedo × baked AO). Bright so they shift hue
   *  without over-darkening: granite, sandstone, basalt, red, moss, gray. */
  private static readonly ROCK_TINTS: ReadonlyArray<readonly [number, number, number]> = [
    [0.92, 0.94, 1.00], [1.00, 0.84, 0.58], [0.50, 0.50, 0.56],
    [0.96, 0.56, 0.42], [0.62, 0.72, 0.50], [0.85, 0.85, 0.85],
  ];

  /** Load the 5 authored rock shapes (geometry-only) sharing ONE normal-mapped stone material, with a
   *  real decimated *_lod.glb far-LOD per shape, and register one scatter sub-layer per shape. Any load
   *  failure → the procedural-primitive rock. */
  private async registerRocks(scene: Scene): Promise<void> {
    const mat = buildScatterPBR(scene, 'scatter_rock_mat', 'rock_albedo.png', 'rock_normal.png');
    this.sceneService.excludeFromPrePass(mat);
    for (let v = 0; v < ScatterService.ROCK_SHAPES.length; v++) {
      const cfg = ScatterService.ROCK_SHAPES[v];
      const full = await loadScatterGeometry(scene, cfg.file, `scatter_rock_${v}_full`, mat);
      const lod  = await loadScatterGeometry(scene, cfg.lod,  `scatter_rock_${v}_lod`,  mat);
      if (!full || !lod) {
        console.warn(`[scatter] rock shape ${v} (${cfg.file}) failed — using primitive rocks`);
        this.registerRockFallback(scene);
        return;
      }
      this.sceneService.excludeFromGlow(full);
      this.sceneService.excludeFromGlow(lod);
      // Rocks are small — swap to the (real) low-poly LOD mesh at 60 m.
      const layer = this.makeGlbLayer(full, lod, 60, (cx, cz) => this.buildRocks(cx, cz, v));
      if (this.gpuScatterEnabled()) { layer.buildGpu = (cx, cz) => this.buildScatterGpu('rocks', cx, cz, v); }
      this.layers.push(layer);
    }
  }

  /** Fallback: the old procedural-primitive rock as a single (all-shape) scatter layer. */
  private registerRockFallback(scene: Scene): void {
    this.layers.push(this.makeLayer(scene, 'scatter_rocks', new Color3(1, 1, 1), 0, [
      { stacks: 2, nearerThan: 90,       fraction: 1.0 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.7 },
    ], (cx, cz) => this.buildRocks(cx, cz, -1), createRock, true));
  }

  // ── Beach driftwood (authored geometry-only GLB shapes) ─────────────────────

  private static readonly DRIFT_SHAPES = [
    { file: 'drift_a.glb', lod: 'drift_a_lod.glb' },   // gnarled branch (fork)
    { file: 'drift_b.glb', lod: 'drift_b_lod.glb' },   // worn log
    { file: 'drift_c.glb', lod: 'drift_c_lod.glb' },   // forked root chunk
    { file: 'drift_d.glb', lod: 'drift_d_lod.glb' },   // flat weathered plank
    { file: 'drift_e.glb', lod: 'drift_e_lod.glb' },   // small twig
  ];

  /** Per-instance driftwood tints (multiply the bleached-gray albedo × baked AO): silver, bleached,
   *  tan, brown, driftbrown, waterlogged. */
  private static readonly DRIFT_TINTS: ReadonlyArray<readonly [number, number, number]> = [
    [1.00, 1.00, 1.02], [1.05, 1.03, 0.98], [1.05, 0.95, 0.76],
    [0.86, 0.70, 0.50], [0.95, 0.82, 0.63], [0.60, 0.62, 0.64],
  ];

  /** Load the 5 authored driftwood shapes (geometry-only) sharing ONE bleached-wood material, with a
   *  real *_lod.glb far-LOD per shape, one scatter sub-layer per shape. Any failure → the primitive. */
  private async registerDriftwood(scene: Scene): Promise<void> {
    const mat = buildScatterPBR(scene, 'scatter_drift_mat', 'drift_albedo.png', 'drift_normal.png');
    this.sceneService.excludeFromPrePass(mat);
    for (let v = 0; v < ScatterService.DRIFT_SHAPES.length; v++) {
      const cfg = ScatterService.DRIFT_SHAPES[v];
      const full = await loadScatterGeometry(scene, cfg.file, `scatter_drift_${v}_full`, mat);
      const lod  = await loadScatterGeometry(scene, cfg.lod,  `scatter_drift_${v}_lod`,  mat);
      if (!full || !lod) {
        console.warn(`[scatter] driftwood shape ${v} (${cfg.file}) failed — using primitive driftwood`);
        this.registerDriftwoodFallback(scene);
        return;
      }
      this.sceneService.excludeFromGlow(full);
      this.sceneService.excludeFromGlow(lod);
      const layer = this.makeGlbLayer(full, lod, 60, (cx, cz) => this.buildDriftwood(cx, cz, v));
      if (this.gpuScatterEnabled()) { layer.buildGpu = (cx, cz) => this.buildScatterGpu('drift', cx, cz, v); }
      this.layers.push(layer);
    }
  }

  /** Fallback: the old procedural-primitive driftwood as a single (all-shape) scatter layer. */
  private registerDriftwoodFallback(scene: Scene): void {
    this.layers.push(this.makeLayer(scene, 'scatter_driftwood', new Color3(1, 1, 1), 0, [
      { stacks: 2, nearerThan: 90,       fraction: 1.0 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.7 },
    ], (cx, cz) => this.buildDriftwood(cx, cz, -1), createDriftwood, true));
  }

  /** Build a scatter layer: material (+ wind/fade plugin), tiered LoD meshes, patch manager.
   *  `meshFactory` makes a LoD mesh from a detail level; `solid` = closed mesh (rocks) vs. thin
   *  double-sided blades (grass). */
  private makeLayer(
    scene: Scene, name: string, color: Color3, swayMul: number, tiers: LodTier[],
    build: (cx: number, cz: number) => PatchData,
    meshFactory: (scene: Scene, detail: number) => Mesh = createGrassBlade, solid = false,
  ): Layer {
    const mat = new StandardMaterial(name, scene);
    mat.diffuseColor = color;
    mat.specularColor = solid ? new Color3(0.05, 0.05, 0.05) : new Color3(0, 0, 0);
    mat.backFaceCulling = solid;                        // rocks are closed solids; blades are double-sided
    mat.twoSidedLighting = !solid;
    new GrassFadePlugin(mat, swayMul);
    // Foliage doesn't need the prePass G-buffer (SSAO/DoF) — excluding it stops every blade being
    // re-rendered a second time per frame into the prePass (the boat & ocean are excluded too).
    this.sceneService.excludeFromPrePass(mat);

    // One LoD mesh per tier, built FARTHEST-first so index 0 = lowest detail (PatchManager contract).
    // Mesh names start with the layer id (`scatter_…`) so the thin-instance patch clones match the
    // ocean refraction RTT's `scatter_` exclusion predicate — keeps the foliage out of that pass too.
    const far2near = [...tiers].reverse();
    const meshes = far2near.map((t, i) => {
      const m = meshFactory(scene, t.stacks);
      m.name = `${name}_lod${i}`;
      m.isVisible = false;
      m.material = mat;
      this.sceneService.excludeFromGlow(m);
      return m;
    });
    const fractions = far2near.map((t) => t.fraction);

    const manager = new PatchManager(meshes, (patch) => {
      const c = this.sceneService.camera;
      const d = c ? Vector3.Distance(patch.getPosition(), c.position) : Infinity;
      let ni = tiers.findIndex((t) => d < t.nearerThan);   // nearest tier whose range covers d
      if (ni < 0) { ni = tiers.length - 1; }
      return (tiers.length - 1) - ni;                       // → farthest-first mesh index
    }, fractions);
    manager.setLodUpdateCadence(this.MAX_BUILDS_PER_FRAME);
    return { mat, manager, patches: new Map(), build, baseMeshes: meshes };
  }

  /** Cell deltas within radius R, sorted NEAREST-FIRST (Euclidean) so patch building always favours the
   *  patches closest to the camera — fastest to appear on initial load, and the leading edge first while
   *  sailing. Cached per R (cheap to rebuild when quality changes the radius). */
  private buildRingOffsets(R: number): { dx: number; dz: number }[] {
    const out: { dx: number; dz: number }[] = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) { out.push({ dx, dz }); }
    }
    out.sort((a, b) => (a.dx * a.dx + a.dz * a.dz) - (b.dx * b.dx + b.dz * b.dz));
    return out;
  }

  /** Build any new cells entering the radius (NEAREST-FIRST, on an adaptive TIME budget), cull cells that
   *  left. Steady cruising only adds a thin leading edge → clears in ~1 frame, gently. A sustained backlog
   *  (initial fill / fast travel) flips "aggressive" → a bigger time/count budget fills fast. Either way the
   *  per-frame build time is capped, so a single frame never spikes regardless of how heavy the patches are. */
  private ensurePatches(): void {
    const cam = this.sceneService.camera;
    if (!cam || !this.layers.length || !this.enabled) { return; }
    const cx = Math.round(cam.position.x / this.PATCH);
    const cz = Math.round(cam.position.z / this.PATCH);
    const R = this.RADIUS;

    // The patch grid only changes when the camera crosses into a new 40 m cell. While it's parked in the
    // same cell with everything built, there's nothing to add or cull — so skip the whole scan + cull
    // entirely (the common case, since the camera moves far less than a cell/frame).
    const cellChanged = cx !== this._lastCx || cz !== this._lastCz;
    if (!cellChanged && !this._patchPending) { this._hasFilledOnce = true; this._aggressive = false; return; }
    this._lastCx = cx; this._lastCz = cz;

    if (!this._ringOffsets || this._ringR !== R) { this._ringOffsets = this.buildRingOffsets(R); this._ringR = R; }

    // Adaptive budget: the first fill-from-empty builds punchy (a stutter is invisible while the screen is
    // still appearing); every later top-up while cruising builds gently so it never hiccups. The time cap
    // bounds the per-frame spike either way.
    const aggressive = !this._hasFilledOnce;
    this._aggressive = aggressive;
    const budgetMs = aggressive ? 6 : 2;
    const maxBuilds = aggressive ? 64 : 8;

    const t0 = performance.now();
    let built = 0;
    let incomplete = false;
    for (const off of this._ringOffsets) {
      // Always build at least the nearest cell; thereafter stop on the time OR count cap.
      if (built >= maxBuilds || (built > 0 && performance.now() - t0 > budgetMs)) { incomplete = true; break; }
      const ix = cx + off.dx, iz = cz + off.dz;
      const key = ix + ',' + iz;
      for (const l of this.layers) {
        if (l.patches.has(key)) { continue; }
        // Shadow (and any capped) layers only build within their near ring around the camera cell.
        if (l.maxRing !== undefined && (Math.abs(off.dx) > l.maxRing || Math.abs(off.dz) > l.maxRing)) { continue; }
        if (l.buildGpu) {
          // GPU placement: near-free on the CPU (a coarse pre-gate + buffer allocation — the actual
          // placement happens in a queued compute dispatch).
          const gp = l.buildGpu(ix * this.PATCH, iz * this.PATCH);
          built++;
          if (!gp) { l.patches.set(key, null); continue; }
          l.manager.addPatch(gp);
          l.patches.set(key, gp);
          continue;
        }
        const data = l.build(ix * this.PATCH, iz * this.PATCH);
        built++;
        if (data.matrix.length === 0) { l.patches.set(key, null); continue; }
        const p = new ThinInstancePatch(new Vector3(ix * this.PATCH, 0, iz * this.PATCH), data.matrix, data.color);
        l.manager.addPatch(p);
        l.patches.set(key, p);
      }
    }
    // Broke out on a budget cap → more patches still to fill; keep going next frame. The first time we
    // fully drain (incomplete=false) the initial load is done → drop to gentle streaming forever after.
    this._patchPending = incomplete;
    if (!incomplete) { this._hasFilledOnce = true; }

    // Cull only when the cell moved (the cull boundary is relative to it) — otherwise nothing left the ring.
    if (cellChanged) {
      for (const l of this.layers) {
        const cull = (l.maxRing ?? R) + 1;   // shadow layers cull back to their near ring
        for (const [key, p] of l.patches) {
          const c = key.split(',');
          if (Math.abs(+c[0] - cx) > cull || Math.abs(+c[1] - cz) > cull) {
            if (p) {
              l.manager.removePatch(p);
              if (p instanceof GpuScatterPatch) { for (const sc of this.scatterComputes.values()) { sc.cancel(p); } }
              p.dispose();
            }
            l.patches.delete(key);
          }
        }
      }
    }
  }

  /** Write one instance (yaw-only rotation — the wind plugin relies on this) into the buffer. */
  private compose(buf: Float32Array, idx: number, px: number, y: number, pz: number, sx: number, sy: number, sz: number): void {
    this._scaleV.set(sx, sy, sz);
    this._posV.set(px, y, pz);
    Quaternion.RotationAxisToRef(this._up, Math.random() * Math.PI * 2, this._q);
    Matrix.ComposeToRef(this._scaleV, this._q, this._posV, this._mat);
    this._mat.copyToArray(buf, idx * 16);
  }

  /** Slice the kept instances and shuffle them (matrix + optional colour in lockstep), so ANY prefix
   *  is a uniform random subset — that's what lets distant LoD tiers render only a fraction of a
   *  patch's instances (an even thin-out). */
  private finish(matTmp: Float32Array, kept: number, colTmp: Float32Array | null = null): PatchData {
    if (!kept) { return EMPTY_PATCH; }
    const matrix = matTmp.slice(0, kept * 16);
    const color = colTmp ? colTmp.slice(0, kept * 4) : null;
    const t = this._stride;
    for (let i = kept - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      if (i === j) { continue; }
      t.set(matrix.subarray(i * 16, i * 16 + 16));
      matrix.copyWithin(i * 16, j * 16, j * 16 + 16);
      matrix.set(t, j * 16);
      if (color) {
        for (let k = 0; k < 4; k++) {
          const a = color[i * 4 + k]; color[i * 4 + k] = color[j * 4 + k]; color[j * 4 + k] = a;
        }
      }
    }
    return { matrix, color };
  }

  /** Slope magnitude (rise/run) from a FORWARD difference reusing the already-sampled (fast) height. Uses
   *  the NEAREST sampler over a ONE-TEXEL baseline (~24 m): two nearest samples closer than a texel land in
   *  the same cell → a constant 0 slope, so the baseline must span a full texel. Within a cell the bilinear
   *  gradient equals the cell gradient, so the values (and the tuned thresholds) match the old E≈2 m bilinear
   *  difference — at ~⅓ the cost (2 nearest reads, no interpolation). `baseY` must be the FAST centre height. */
  private slopeAt(px: number, pz: number, baseY: number, _E: number): number {
    const g = this.terrainService;
    const D = this._cellM || (this._cellM = g.getCellSizeM());
    const dyx = g.getElevationFast(px + D, pz) - baseY;
    const dyz = g.getElevationFast(px, pz + D) - baseY;
    return Math.sqrt(dyx * dyx + dyz * dyz) / D;
  }

  /**
   * Ground a tree mesh so its trunk base sits at object-space y=0. Authored GLBs often have their ORIGIN
   * below (or above) the trunk base; since instances are scaled per-tree, that gap renders as a float of
   * baseOffset×scale — i.e. a DIFFERENT amount on every tree (which is exactly the symptom: only trees,
   * by random amounts). Baking the base to y=0 makes the existing `posV.y = groundY - 0.35` placement
   * plant the trunk correctly regardless of per-instance scale.
   */
  private groundToBase(mesh: Mesh): void {
    const minY = mesh.getBoundingInfo().boundingBox.minimum.y;
    if (Math.abs(minY) > 0.02) {
      mesh.position.y = -minY;                  // lift the base to y=0
      mesh.bakeCurrentTransformIntoVertices();  // fold the shift into the geometry; origin now == base
    }
  }

  /** Build one patch's grass CLUMPS for a single variant. Each authored clump is now a FULL 60–90
   *  blade tuft with a wide base footprint (updated asset — see GRASS_ASSET.md), so a few overlapping
   *  clumps already read as continuous grass. Clustering is TWO-SCALE: a low-freq `region` field makes
   *  whole areas sparse vs lush, and a higher-freq `clump` field forms tussock cores. Density ramps
   *  HARD toward each clump core (gamma curve) — while sparse regions stay very sparse. Deterministic
   *  (hash, not Math.random) so the 3 variant calls partition one candidate set. Per-instance tint +
   *  size. KEEP burst/radius IN SYNC with scatter-compute.ts GRASS_WGSL. */
  private buildGrass(cx: number, cz: number, variant: number): PatchData {
    const res = 28, size = this.PATCH, cell = size / res, E = 2.0;
    const tpads = this.townPadsNear(cx, cz);            // exclude town footprints from scatter
    const BURST = 6;                                    // ≤6 full tufts per bush heart (was 16 sprigs)
    const BUSH_R = 0.9;                                 // bush radius (m) — wider spread for the big tufts
    const cap = 5000;                                   // generous per-patch instance cap (bushes are rare)
    const matTmp = new Float32Array(cap * 16);
    const colTmp = new Float32Array(cap * 4);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const getYFast = (x: number, z: number) => this.terrainService.getElevationFast(x, z);
    const scaleV = this._scaleV, posV = this._posV, up = this._up;
    const NCLUMPS = ScatterService.GRASS_CLUMPS.length;
    const TINTS = ScatterService.GRASS_TINTS;
    let kept = 0;

    // Place one clump at (px,pz) snapped to terrain, with deterministic size/yaw/tint.
    const place = (px: number, pz: number, y: number): void => {
      const s = 0.7 + hash2(px * 5.3 - 2.0, pz * 4.7 + 8.0) * 0.9;   // ~0.7–1.6× clump scale
      scaleV.set(s, s, s);
      posV.set(px, y - 0.02, pz);
      Quaternion.RotationAxisToRef(up, hash2(px * 1.13 + 7, pz * 1.07 - 7) * Math.PI * 2, this._q);
      Matrix.ComposeToRef(scaleV, this._q, posV, this._mat);
      this._mat.copyToArray(matTmp, kept * 16);
      const c = TINTS[Math.floor(hash2(px * 0.9 - 11, pz * 0.9 + 11) * TINTS.length) % TINTS.length];
      const ci = kept * 4;
      colTmp[ci]     = Math.max(0, c[0] + (hash2(px * 8.1, pz * 8.3) - 0.5) * 0.08);
      colTmp[ci + 1] = Math.max(0, c[1] + (hash2(px * 8.3, pz * 8.1) - 0.5) * 0.08);
      colTmp[ci + 2] = Math.max(0, c[2] + (hash2(px * 8.7, pz * 8.9) - 0.5) * 0.08);
      colTmp[ci + 3] = 1;
      kept++;
    };

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        const px = cx + (x + hash2(cx + x * 12.9, cz + z * 78.2)) * cell - size / 2;
        const pz = cz + (z + hash2(cx + x * 39.3 + 7.1, cz + z * 11.7 - 3.3)) * cell - size / 2;
        let y = getYFast(px, pz);                                      // fast nearest height for gating
        if (tpads.length && this.inTown(px, pz, tpads)) { continue; }   // no scatter in towns
        if (y < 0.6) { continue; }
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.7) { continue; }

        // Tight-bush clustering: most of the terrain is TOTALLY barren, with rare small bushes that are
        // very densely packed at their heart. Two gates, both with HIGH thresholds so they sit above
        // fbm2's ~0.5 cluster — meaning they read 0 across most of the map and only switch on in the rare
        // lush spots. No base floor → between bushes (even inside a lush region) there is zero grass.
        const region = fbm2(px / 45 + 120, pz / 45 - 60);             // where bushes are ALLOWED at all
        const bush   = fbm2(px / 5 + 31, pz / 5 + 17);                // small scale → small, tight bushes
        const regionGate = step01(0.54, 0.64, region);                // ~0 almost everywhere → 1 in rare lush spots
        const core = step01(0.56, 0.80, bush);                        // 0 between bushes → 1 at a bush heart
        const coreD = core * core * core;                             // cubed: concentrates hard into the heart
        const lowland = smoothstep(1.5, 13, y);                       // shore → lowland
        const alt = 1 - smoothstep(90, 140, y);                       // fade out toward the rocky uplands
        const envFac = lowland * alt * (1 - slope * 0.7) * this.densityMul;

        // No meadow base: density is purely region × bush-core, so barren gaps are genuinely empty and the
        // only grass is the bush hearts (which then get heavily over-packed below).
        const density = coreD * regionGate * envFac;
        if (hash2(px * 3.1 + 1.7, pz * 2.9 - 3.3) > density) { continue; }

        // Deal each accepted cell to one clump variant.
        if (variant >= 0 && Math.floor(hash2(px * 0.71 + 50, pz * 0.67 - 50) * NCLUMPS) !== variant) { continue; }

        y = getY(px, pz);                  // accurate height for placement (gating used the fast sampler)
        if (y < 0.6) { continue; }         // confirm against the precise waterline — no clumps in the surf
        place(px, pz, y);

        // Burst the bush heart: pack many clumps into a TIGHT tuft (~BUSH_R radius, a few feet across), so
        // the few bushes that exist read as dense balls of grass. Blade count scales with how deep into
        // the core we are — fringe cells get a sparse handful, the very heart gets the full BURST.
        const blades = Math.floor(3 + coreD * (BURST - 3));         // 3 … BURST clumps per bush
        for (let b = 1; b < blades && kept < cap; b++) {
          const ang = hash2(px * (3.1 + b * 0.7) + b * 1.7, pz * (2.3 + b * 0.5) - b * 2.9) * Math.PI * 2;
          const rad = Math.sqrt(hash2(px * (5.7 + b) + 3, pz * (1.9 + b) - 3)) * BUSH_R;  // sqrt → even fill
          const jx = px + Math.cos(ang) * rad;
          const jz = pz + Math.sin(ang) * rad;
          place(jx, jz, getY(jx, jz));
        }
      }
    }
    return this.finish(matTmp, kept, colTmp);
  }

  // ── Quality control (graphics presets / settings menu) ──────────────────────

  getScatterQuality(): number { return this._quality; }

  /** Set the scatter quality tier (0 Potato … 4 Ultra) — adjusts draw radius + grass density and
   *  rebuilds the live patches. Driven by the graphics presets and the settings-menu slider. */
  setScatterQuality(level: number): void {
    const q = Math.max(0, Math.min(4, Math.round(level)));
    if (q === this._quality && this.layers.length) { return; }
    this._quality = q;
    localStorage.setItem('ignis_scatter_quality', String(q));
    this.applyQualityParams(q);
    // Rebuild: drop every live patch so ensurePatches regenerates them at the new radius/density.
    for (const l of this.layers) {
      for (const [, p] of l.patches) {
        if (p) {
          l.manager.removePatch(p);
          if (p instanceof GpuScatterPatch) { for (const sc of this.scatterComputes.values()) { sc.cancel(p); } }
          p.dispose();
        }
      }
      l.patches.clear();
    }
    this._lastCx = NaN; this._patchPending = true; this._hasFilledOnce = false;   // force ensurePatches to rebuild the grid
    if (this.enabled) { this.ensurePatches(); }
  }

  /** Apply a quality tier's radius/density/enabled flags + the matching fade band (no rebuild). */
  private applyQualityParams(q: number): void {
    const t = ScatterService.QUALITY[Math.max(0, Math.min(4, q))];
    this.enabled = t.enabled;
    this.densityMul = t.density;
    this.RADIUS = Math.max(1, t.radius);
    this.shadowRing = Math.min(this.RADIUS, 3);   // blobs only near the camera (~120 m)
    GrassFadePlugin.fade.end   = (this.RADIUS - 0.4) * this.PATCH;
    GrassFadePlugin.fade.start = Math.max(20, GrassFadePlugin.fade.end - 110);
  }

  /** Build one patch's beach rocks: scattered on the sand/low-dune band, mostly small with some
   *  bigger ones and the rare boulder, each a random size, tumble orientation and stone colour. */
  private buildRocks(cx: number, cz: number, variant: number, shadow = false): PatchData {
    const res = 24, size = this.PATCH, cell = size / res, E = 2.0;
    const tpads = this.townPadsNear(cx, cz);            // exclude town footprints from scatter
    const matTmp = new Float32Array(res * res * 16);
    const colTmp = new Float32Array(res * res * 4);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const getYFast = (x: number, z: number) => this.terrainService.getElevationFast(x, z);
    const scaleV = this._scaleV, posV = this._posV;
    const NSHAPES = ScatterService.ROCK_SHAPES.length;
    const TINTS = ScatterService.ROCK_TINTS;
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        // Deterministic jitter (hash, not Math.random) so all shape calls partition one candidate set.
        const px = cx + (x + hash2(cx + x * 12.9, cz + z * 78.2)) * cell - size / 2;
        const pz = cz + (z + hash2(cx + x * 39.3 + 7.1, cz + z * 11.7 - 3.3)) * cell - size / 2;
        let y = getYFast(px, pz);                                      // fast nearest height for gating
        if (tpads.length && this.inTown(px, pz, tpads)) { continue; }   // no scatter in towns
        if (y < 0.25 || y > 150) { continue; }            // beach band → all the way up the rocky uplands
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.85) { continue; }

        // Scattered, with subtle clusters (rocks gather a little, slightly sparser between). Two altitude
        // bands: a denser beach/dune shelf (≤7 m), then a thinner but ever-present upland scatter that
        // actually picks up again on the rocky higher ground.
        const clump = fbm2(px / 18, pz / 18);
        const beach = 1 - smoothstep(7, 14, y);                       // 1 on the sand shelf → 0 just inland
        const upland = smoothstep(12, 45, y);                         // fades the upland scatter in past the dunes
        const bandMul = 0.45 + 0.55 * beach + 0.6 * upland;           // dip in the mid-slope, rocks at both ends
        // Clump-DOMINATED so rocks gather into fields with clean sand between, rather than a uniform
        // sprinkle (the old flat base looked "dirty"). Tiny loner base + a clustered term gated to the
        // noise peaks. Overall ~1/3 the previous count.
        const dens = (0.004 + 0.085 * smoothstep(0.60, 0.82, clump)) * bandMul * (1 - slope * 0.4) * this.densityMul;
        if (hash2(px * 3.1 + 1.7, pz * 2.9 - 3.3) > dens) { continue; }

        // Deal each accepted candidate to one shape (variant < 0 → keep all; primitive fallback).
        if (variant >= 0 && Math.floor(hash2(px * 0.71 + 50, pz * 0.67 - 50) * NSHAPES) !== variant) { continue; }

        y = getY(px, pz);                  // accurate height for placement (shadow blob + mesh settle)
        if (y < 0.25) { continue; }        // confirm against the precise waterline
        // Size mix: mostly small, some bigger, the occasional boulder (real metres — base mesh ≈ 1 m).
        const r = hash2(px * 5.3 - 2.0, pz * 4.7 + 8.0);
        const base = r < 0.05 ? 1.8 + hash2(px * 2.2, pz * 2.2) * 1.7       // ~5% boulders (1.8–3.5 m)
          : r < 0.30 ? 0.7 + hash2(px * 1.9 + 3, pz * 1.9 - 3) * 0.7        // ~25% bigger (0.7–1.4 m)
          : 0.25 + hash2(px * 6.1 + 9, pz * 6.1 - 9) * 0.4;                 // small (0.25–0.65 m)
        scaleV.set(
          base * (0.85 + hash2(px * 7.7, pz * 1.3) * 0.35),
          base * (0.60 + hash2(px * 1.3, pz * 7.7) * 0.40),
          base * (0.85 + hash2(px * 3.7, pz * 9.1) * 0.35));
        if (shadow) { this.composeShadow(matTmp, kept, px, y, pz, Math.max(scaleV.x, scaleV.z) * 1.15); kept++; continue; }
        posV.set(px, y - base * 0.1, pz);                  // settle slightly into the sand
        Quaternion.RotationYawPitchRollToRef(
          hash2(px * 1.11 + 4, pz * 1.07 - 4) * Math.PI * 2,
          (hash2(px * 2.3, pz * 5.1) - 0.5) * 0.5,
          (hash2(px * 5.1, pz * 2.3) - 0.5) * 0.5, this._q);
        Matrix.ComposeToRef(scaleV, this._q, posV, this._mat);
        this._mat.copyToArray(matTmp, kept * 16);

        // Per-instance stone tint: pick a palette entry, jitter each channel (multiplies AO × albedo).
        const c = TINTS[Math.floor(hash2(px * 0.9 - 11, pz * 0.9 + 11) * TINTS.length) % TINTS.length];
        const ci = kept * 4;
        colTmp[ci]     = Math.max(0, c[0] + (hash2(px * 8.1, pz * 8.3) - 0.5) * 0.10);
        colTmp[ci + 1] = Math.max(0, c[1] + (hash2(px * 8.3, pz * 8.1) - 0.5) * 0.10);
        colTmp[ci + 2] = Math.max(0, c[2] + (hash2(px * 8.7, pz * 8.9) - 0.5) * 0.10);
        colTmp[ci + 3] = 1;
        kept++;
      }
    }
    return this.finish(matTmp, kept, shadow ? null : colTmp);
  }

  /** Build one patch's driftwood: weathered logs lying flat near the tide line — occasional, varied
   *  length/thickness, random yaw with a slight settle, bleached wood colours. */
  private buildDriftwood(cx: number, cz: number, variant: number, shadow = false): PatchData {
    const res = 20, size = this.PATCH, cell = size / res, E = 2.0;
    const tpads = this.townPadsNear(cx, cz);            // exclude town footprints from scatter
    const matTmp = new Float32Array(res * res * 16);
    const colTmp = new Float32Array(res * res * 4);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const getYFast = (x: number, z: number) => this.terrainService.getElevationFast(x, z);
    const scaleV = this._scaleV, posV = this._posV;
    const NSHAPES = ScatterService.DRIFT_SHAPES.length;
    const TINTS = ScatterService.DRIFT_TINTS;
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        // Deterministic jitter (hash, not Math.random) so all shape calls partition one candidate set.
        const px = cx + (x + hash2(cx + x * 12.9, cz + z * 78.2)) * cell - size / 2;
        const pz = cz + (z + hash2(cx + x * 39.3 + 7.1, cz + z * 11.7 - 3.3)) * cell - size / 2;
        let y = getYFast(px, pz);                                      // fast nearest height for gating
        if (tpads.length && this.inTown(px, pz, tpads)) { continue; }   // no scatter in towns
        if (y < 0.25 || y > 7) { continue; }              // sand / low beach band (up to the sand line)
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.75) { continue; }

        // Gathered into drifts along the tide line (clump-dominated, tiny loner base) rather than a
        // uniform sprinkle. Overall ~1/3 the previous count.
        const clump = fbm2(px / 16 + 40, pz / 16 - 22);
        const dens = (0.004 + 0.07 * smoothstep(0.60, 0.82, clump)) * (1 - slope * 0.4) * this.densityMul;
        if (hash2(px * 3.1 + 1.7, pz * 2.9 - 3.3) > dens) { continue; }

        // Deal each accepted candidate to one shape (variant < 0 → keep all; primitive fallback).
        if (variant >= 0 && Math.floor(hash2(px * 0.71 + 50, pz * 0.67 - 50) * NSHAPES) !== variant) { continue; }

        y = getY(px, pz);                  // accurate height for placement (shadow blob + settle)
        if (y < 0.25) { continue; }        // confirm against the precise waterline
        // Size mix: uniform scale (the 5 GLB shapes already carry their own proportions) — mostly
        // small/medium with some big logs/planks. Base meshes are ~0.8–2.8 m long, so this spans twig→log.
        const r = hash2(px * 5.3 - 2.0, pz * 4.7 + 8.0);
        const s = r < 0.15 ? 1.2 + hash2(px * 2.2, pz * 2.2) * 0.6     // ~15% big (1.2–1.8×)
          : r < 0.70 ? 0.7 + hash2(px * 1.9 + 3, pz * 1.9 - 3) * 0.5   // medium (0.7–1.2×)
          : 0.45 + hash2(px * 6.1 + 9, pz * 6.1 - 9) * 0.25;           // small twigs (0.45–0.7×)
        scaleV.set(s, s, s);
        if (shadow) { this.composeShadow(matTmp, kept, px, y, pz, s * 1.15); kept++; continue; }
        posV.set(px, y - 0.03, pz);                          // settle into the sand
        Quaternion.RotationYawPitchRollToRef(
          hash2(px * 1.11 + 4, pz * 1.07 - 4) * Math.PI * 2,
          (hash2(px * 2.3, pz * 5.1) - 0.5) * 0.3,
          (hash2(px * 5.1, pz * 2.3) - 0.5) * 0.3, this._q);
        Matrix.ComposeToRef(scaleV, this._q, posV, this._mat);
        this._mat.copyToArray(matTmp, kept * 16);

        const c = TINTS[Math.floor(hash2(px * 0.9 - 11, pz * 0.9 + 11) * TINTS.length) % TINTS.length];
        const ci = kept * 4;
        colTmp[ci]     = Math.max(0, c[0] + (hash2(px * 8.1, pz * 8.3) - 0.5) * 0.08);
        colTmp[ci + 1] = Math.max(0, c[1] + (hash2(px * 8.3, pz * 8.1) - 0.5) * 0.08);
        colTmp[ci + 2] = Math.max(0, c[2] + (hash2(px * 8.7, pz * 8.9) - 0.5) * 0.08);
        colTmp[ci + 3] = 1;
        kept++;
      }
    }
    return this.finish(matTmp, kept, shadow ? null : colTmp);
  }

  /** Harbor-town pad rectangles (oriented), each padded by a small margin. Lazily cached once the terrain
   *  manifest is loaded; re-fetched until the harbors are present. Used to keep ALL scatter out of towns. */
  private getTownPads(): { cx: number; cz: number; hx: number; hz: number; sin: number; cos: number; r: number }[] {
    if (this.townPads && this.townPads.length) { return this.townPads; }
    const harbors = this.terrainService.getHarbors();
    if (!harbors || !harbors.length) { return []; }   // manifest not loaded yet — don't cache empty
    const M = 6;                                       // keep scatter this far back from the town edge too
    const pads = [];
    for (const h of harbors) {
      if (!h.pad) { continue; }
      const p = h.pad, hr = (p.rotY * Math.PI) / 180, hx = p.halfX + M, hz = p.halfZ + M;
      pads.push({ cx: p.cx, cz: p.cz, hx, hz, sin: Math.sin(hr), cos: Math.cos(hr), r: Math.hypot(hx, hz) });
    }
    this.townPads = pads;
    return pads;
  }

  /** The town pads whose footprint can reach into the patch centred at (cx,cz) — usually none, so the
   *  per-candidate test below is skipped entirely away from towns. */
  private townPadsNear(cx: number, cz: number) {
    const reach = this.PATCH; // patch half-extent (20) + headroom
    return this.getTownPads().filter((p) => Math.hypot(p.cx - cx, p.cz - cz) < p.r + reach);
  }

  /** True if (px,pz) is inside any of the given (oriented) town pads → no scatter there. */
  private inTown(px: number, pz: number, pads: { cx: number; cz: number; hx: number; hz: number; sin: number; cos: number }[]): boolean {
    for (const p of pads) {
      const dx = px - p.cx, dz = pz - p.cz;
      const along = dx * p.sin + dz * p.cos;     // along the town's heading axis (halfZ)
      const across = dx * p.cos - dz * p.sin;    // across (halfX)
      if (Math.abs(along) <= p.hz && Math.abs(across) <= p.hx) { return true; }
    }
    return false;
  }

  /** True if the shore/shallows lie within `minDist` m of (px,pz) — used to keep beach trees a few metres
   *  back from the water so no trunks stand in the surf or float over the transparent coastal shallows.
   *  Scans a FILLED DISK (3 rings × 8 spokes), not a single ring: a lone ring at exactly `minDist` misses
   *  water that sits closer than that (e.g. a sandbar tip with water 2 m off but land again at the 5 m
   *  sample), which let trees float over the shallows. The reject threshold is +0.4 m (not ≈0), so trees
   *  also stay off the low transition band where the seabed is just under water and rendered transparent. */
  private nearShoreline(px: number, pz: number, minDist: number): boolean {
    const g = this.terrainService;
    const RINGS = 3, SPOKES = 8, MARGIN = 0.4;
    for (let r = 1; r <= RINGS; r++) {
      const d = (r / RINGS) * minDist;
      for (let i = 0; i < SPOKES; i++) {
        const a = (i / SPOKES) * Math.PI * 2 + r * 0.4;   // stagger rings so spokes don't all align
        if (g.getElevation(px + Math.cos(a) * d, pz + Math.sin(a) * d) <= MARGIN) { return true; }
      }
    }
    return false;
  }

  /** Build one patch's forest trees: clustered in the inland forest-mask zone (mid elevation, gentle
   *  slope), broken into stands by low-freq noise with clearings. Sparse — trees are big. */
  private buildTrees(cx: number, cz: number, variant: number, shadow = false): PatchData {
    const res = 16, size = this.PATCH, cell = size / res, E = 3.0;
    const tpads = this.townPadsNear(cx, cz);            // exclude town footprints from scatter
    const tmp = new Float32Array(res * res * 16);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const getYFast = (x: number, z: number) => this.terrainService.getElevationFast(x, z);
    const scaleV = this._scaleV, posV = this._posV, up = this._up;
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        // Deterministic jitter (hash, not Math.random) so all variant calls partition one candidate set.
        const px = cx + (x + hash2(cx + x * 12.9, cz + z * 78.2)) * cell - size / 2;
        const pz = cz + (z + hash2(cx + x * 39.3 + 7.1, cz + z * 11.7 - 3.3)) * cell - size / 2;
        let y = getYFast(px, pz);                                      // fast nearest height for gating
        if (tpads.length && this.inTown(px, pz, tpads)) { continue; }   // no scatter in towns
        if (y < 0.6 || y > 80) { continue; }               // on solid land (beaches included), below the uplands
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.5) { continue; }                     // trees on gentle ground only

        // Big forest stands (low-freq) with clearings inside (mid-freq) → grouped woods, open gaps.
        const stand = fbm2(px / 45, pz / 45);
        const clearing = fbm2(px / 13 + 9, pz / 13 - 4);
        const dens = smoothstep(0.46, 0.72, stand) * smoothstep(0.4, 0.62, clearing)
          * (1 - slope * 0.8) * 0.18 * this.densityMul;   // even fewer beeches (palms dominate now)
        if (hash2(px * 3.1 + 1.7, pz * 2.9 - 3.3) > dens) { continue; }

        // Deal each accepted candidate to one variant (variant < 0 → keep all; primitive fallback).
        if (variant >= 0 && Math.floor(hash2(px * 0.71 + 50, pz * 0.67 - 50) * 3) !== variant) { continue; }
        if (this.nearShoreline(px, pz, 7)) { continue; }   // keep ~7 m back from the water/shallows (no surf trees)

        y = getY(px, pz);                  // accurate height for placement (shadow blob + trunk)
        if (y < 0.6) { continue; }         // confirm against the precise waterline
        const s = 0.9 + hash2(px * 5.3 - 2.0, pz * 4.7 + 8.0) * 0.22;   // ~±11 % (GLB beeches are real metres)
        scaleV.set(s, s, s);
        if (shadow) { this.composeShadow(tmp, kept, px, y, pz, s * 4.2); kept++; continue; }
        posV.set(px, y - 0.35, pz);   // root the trunk slightly into the ground (planted, never floating)
        Quaternion.RotationAxisToRef(up, hash2(px * 1.13 + 7, pz * 1.07 - 7) * Math.PI * 2, this._q);
        Matrix.ComposeToRef(scaleV, this._q, posV, this._mat);
        this._mat.copyToArray(tmp, kept * 16);
        kept++;
      }
    }
    return this.finish(tmp, kept);
  }

  /** Build one patch's beach palms for a single VARIANT, clustered into coastal STANDS (groves) by
   *  low-freq noise on the sand/low-coastal band. Placement is DETERMINISTIC (hash-driven, not
   *  Math.random) so all three variant calls see the SAME candidates and partition them by a position
   *  hash — equal total density, mixed varieties per grove. `variant < 0` keeps every candidate (the
   *  single-mesh primitive fallback). The GLB palms are real metres, so scale is a gentle ±8 % only. */
  private buildPalms(cx: number, cz: number, variant: number, shadow = false): PatchData {
    const res = 14, size = this.PATCH, cell = size / res, E = 2.5;
    const tpads = this.townPadsNear(cx, cz);            // exclude town footprints from scatter
    const tmp = new Float32Array(res * res * 16);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const getYFast = (x: number, z: number) => this.terrainService.getElevationFast(x, z);
    const scaleV = this._scaleV, posV = this._posV, up = this._up;
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        const px = cx + (x + hash2(cx + x * 12.9, cz + z * 78.2)) * cell - size / 2;
        const pz = cz + (z + hash2(cx + x * 39.3 + 7.1, cz + z * 11.7 - 3.3)) * cell - size / 2;
        let y = getYFast(px, pz);                                      // fast nearest height for gating
        if (tpads.length && this.inTown(px, pz, tpads)) { continue; }   // no scatter in towns
        if (y < 0.6 || y > 45) { continue; }               // beach + low coast (was 27–42, off the shore); off the uplands
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.5) { continue; }

        // Groves: a high, sharp threshold on a low-freq field → clustered stands, open between.
        const stand = fbm2(px / 28 + 60, pz / 28 - 40);
        const dens = smoothstep(0.48, 0.80, stand) * (1 - slope * 0.6) * 0.95 * this.densityMul;   // even more palms — they own the slope
        if (hash2(px * 3.1 + 1.7, pz * 2.9 - 3.3) > dens) { continue; }

        // Deal each accepted candidate to exactly one variant (so the 3 sub-layers don't stack).
        if (variant >= 0 && Math.floor(hash2(px * 0.71 + 50, pz * 0.67 - 50) * 3) !== variant) { continue; }
        if (this.nearShoreline(px, pz, 7)) { continue; }   // keep ~7 m back from the water/shallows (no surf trees)

        y = getY(px, pz);                  // accurate height for placement (shadow blob + trunk)
        if (y < 0.6) { continue; }         // confirm against the precise waterline
        const s = 0.92 + hash2(px * 5.3 - 2.0, pz * 4.7 + 8.0) * 0.16;   // ~±8 % (world-correct height)
        scaleV.set(s, s, s);
        if (shadow) { this.composeShadow(tmp, kept, px, y, pz, s * 2.6); kept++; continue; }
        posV.set(px, y - 0.35, pz);   // root the trunk slightly into the ground (planted, never floating)
        Quaternion.RotationAxisToRef(up, hash2(px * 1.13 + 7, pz * 1.07 - 7) * Math.PI * 2, this._q);
        Matrix.ComposeToRef(scaleV, this._q, posV, this._mat);
        this._mat.copyToArray(tmp, kept * 16);
        kept++;
      }
    }
    return this.finish(tmp, kept);
  }

  dispose(): void {
    if (this.observer) { this.sceneService.scene?.onBeforeRenderObservable.remove(this.observer); this.observer = null; }
    this.teardownLayers();
  }
}
