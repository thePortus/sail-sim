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
  ScatterCompute, ShadowCompute, PadBox, GRASS_WGSL, ROCKS_WGSL, DRIFT_WGSL, TREES_WGSL, PALMS_WGSL,
} from './scatter-compute';
import { PatchManager } from './instancing/patch-manager';
import { createGrassBlade } from './grass/grass-blade';
import { createRock } from './props/rock';
import { createDriftwood } from './props/driftwood';
import { createTree } from './props/tree';
import { createPalm } from './props/palm';
import { GrassFadePlugin } from './grass/grass-fade.plugin';
import { FarFadePlugin } from './far-fade.plugin';
import { NearFadePlugin } from './near-fade.plugin';
import { LodDitherPlugin } from './lod-dither.plugin';
import { ImpostorHazePlugin } from './impostor-haze.plugin';
import { PalmWindPlugin } from './props/palm-wind.plugin';
import { TreeWindPlugin } from './props/tree-wind.plugin';
import { ShadowBlobPlugin } from './props/shadow-blob.plugin';
import {
  loadScatterMesh, createCrossImpostor, measureBottomPad, loadScatterGeometry, buildScatterPBR,
  buildScatterRockPBR, buildGrassMaterial, scatterTextureUrl, setScatterVersion, clearScatterCache,
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

// ── GPU-MATCHING noise (mirror of scatter-compute.ts) ──────────────────────────────────────────────
// On WebGPU the camera-following trees are placed by the COMPUTE kernel, which uses a sinless Dave-Hoskins
// hash (NOT the sin-hash above). Its fbm2 clustering field — which decides where the groves vs clearings
// sit — therefore differs from the CPU fbm2. The static far-coast layer must use THIS noise (when GPU
// scatter is on) or its clearings land in different places than the near layer → trees "fade in from
// nothing" on approach. fbm2 samples the hash on the integer lattice at moderate values, so f64-vs-f32 drift
// is tiny and the clearings align. (See [[scatter-lod-dissolve]].)
function gpuHash2(x: number, z: number): number {
  let qx = x * 0.1031; qx -= Math.floor(qx);
  let qz = z * 0.1030; qz -= Math.floor(qz);
  const dotv = qx * (qz + 33.33) + qz * (qx + 33.33);
  qx += dotv; qz += dotv;
  const v = (qx + qz) * qx;
  return v - Math.floor(v);
}
function gpuVnoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = gpuHash2(xi, zi), b = gpuHash2(xi + 1, zi), c = gpuHash2(xi, zi + 1), d = gpuHash2(xi + 1, zi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function gpuFbm2(x: number, z: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * gpuVnoise(x * freq + o * 19.3, z * freq - o * 7.1);
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
  /** Identifier for debug toggles (e.g. 'shadow'). */
  tag?: string;
  /** When true, ensurePatches skips this layer entirely (debug). */
  disabled?: boolean;
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
  // Static far impostor layers (forest slopes + the coast strip): the impostor textures captured on load.
  private beechImpostors: { tex: Texture; w: number; h: number; pad: number }[] = [];
  private palmImpostors: { tex: Texture; w: number; h: number; pad: number }[] = [];
  private farMeshes: Mesh[] = [];
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
  // Per-instance draw-radius fade band for the camera-following TREES (palms/beeches) — wider than grass's, so
  // their impostors dissolve at the patch-cull edge (no pop). Set from RADIUS in applyQualityParams; passed BY
  // REFERENCE to each tree impostor's GrassFadePlugin so quality changes flow through live.
  private readonly treeFade = { start: 280, end: 340 };
  // TRUE LoD cross-dissolve for trees (palms/beeches): in the NearFade ring each patch renders BOTH its
  // impostor and full clone (shared GPU buffers) so the billboard morphs into the 3D mesh — no pop, no vanish.
  // On by default; opt out (legacy single-LoD shrink swap) with localStorage ignis_lod_dissolve='0'.
  private readonly lodDissolve = typeof localStorage === 'undefined' || localStorage.getItem('ignis_lod_dissolve') !== '0';
  // Impostor DITHER (screen-door) appear band for the camera-ring cross-dissolve: opaque beyond near+band,
  // dithered to nothing by near-band (so the billboard dissolves into the full mesh by distance, no shrink).
  private readonly ringAppear = {
    start: NearFadePlugin.params.near - NearFadePlugin.params.band,
    end: NearFadePlugin.params.near + NearFadePlugin.params.band,
  };
  // Far-COAST impostor appear band (its own, nearer than the forest's): full by the camera-ring cull so the
  // beach reads as treed right up to where the ring takes over. Set from RADIUS in applyQualityParams.
  private readonly coastAppear = { start: 260, end: 340 };
  private densityMul = 1;               // grass acceptance multiplier (set from quality)
  // The palm GLB's trunk base is authored this high above its origin (its lowest vertex is a drooping frond,
  // not the base). recenterTrunkXZ bakes this down so the base sits at local y=0 — then placement just plants
  // the origin at the ground (no per-scale sink), correctly on BOTH the CPU and GPU paths.
  private static readonly PALM_TRUNK_Y = 2.4;
  // Small constant "planted" depth below the (correct) sampled ground — same idea as the trees. Live-tunable
  // via palmSink()/treeSink() while dialling it in.
  private palmSink = 0.35;
  private treeSink = 0.35;
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
      if (c) {
        GrassFadePlugin.camera.x = c.position.x; GrassFadePlugin.camera.z = c.position.z;
        FarFadePlugin.camera.x   = c.position.x; FarFadePlugin.camera.z   = c.position.z;   // far-forest fade
        NearFadePlugin.camera.x  = c.position.x; NearFadePlugin.camera.z  = c.position.z;   // palm/beech LoD dissolve
      }
      // Drive the palm wind from the weather wind (the same source the sails use): unit direction +
      // a gust amplitude that grows with wind speed, plus a steadily-advancing clock.
      const wd = this.weatherService.weather()?.wind;
      if (wd) {
        const mag = Math.hypot(wd.x, wd.z) || 1;
        const dx = wd.x / mag, dz = wd.z / mag;
        const gust = Math.min(1, (wd.speed ?? 8) / 24);   // 0 calm → 1 gale
        PalmWindPlugin.WIND.dirX = dx;
        PalmWindPlugin.WIND.dirZ = dz;
        PalmWindPlugin.WIND.amplitude = 0.18 + gust * 0.45;   // fuller frond sway (cloud-halo issue is fixed)
        TreeWindPlugin.WIND.dirX = dx;
        TreeWindPlugin.WIND.dirZ = dz;
        // Sway restored to a lively amount now that the volumetric-cloud halo issue (a swinging silhouette
        // exposing a halo the cloud depth pass couldn't follow) is resolved. Whole-canopy lean + leaf shimmer.
        TreeWindPlugin.WIND.branchAmp = 0.12 + gust * 0.24;   // whole-canopy sway grows with wind
        TreeWindPlugin.WIND.leafAmp   = 0.05 + gust * 0.07;   // leaf flutter back on — the canopy edge shimmers in a breeze
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
        // Fade out at night, and a little softer as the shadow stretches long (low-sun shadows are diffuse penumbra).
        this._shadowMat.alpha = 0.62 * smoothstep(0.0, 0.16, sun.y) * (1.0 - 0.06 * (stretch - 1.0));
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
    // Re-enabled: the updated clump models are fuller (60–90 blades, wider footprint) so far fewer
    // instances fill a field, and the scatter bottleneck that forced this off has since been resolved.
    if (ScatterService.GRASS_ENABLED) { await this.registerGrass(scene); }

    // Authored-GLB groups (streamed from the server, cached): beach rocks (5 shapes, size pebble→
    // boulder + tint), driftwood (5 shapes, twig→log + tint), forest beeches (A/B/C, two-channel
    // wind), beach palms (A/B/C, wind sway). Each falls back to its primitive if a GLB fails.
    await this.registerRocks(scene);
    await this.registerDriftwood(scene);
    await this.registerBeeches(scene);
    await this.registerPalms(scene);
    // Static far-impostor layers — built AFTER both tree types register so BOTH beechImpostors AND
    // palmImpostors are populated (the coast atlas mixes them; building inside registerBeeches left
    // palmImpostors empty → all coast trees fell back to beeches).
    this.buildFarForest(scene);   // distant forested hillsides
    this.buildFarCoast(scene);    // the shore strip the forest layer skips (beach palms + low beeches)
    this.setupSinkDebug();   // console tuner: __palmSink()/__treeSink()

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
    this.shadowCompute?.dispose(); this.shadowCompute = null;
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
    // Static far-forest layer: per variant ONE shared material across its (hidden template + chunk clones),
    // so dedupe material disposal — and textures are shared with the ring impostors above (don't force-dispose).
    const farMats = new Set<Material>();
    for (const m of this.farMeshes) { if (m.material) { farMats.add(m.material); } m.dispose(); }
    for (const mm of farMats) { mm.dispose(); }
    this.farMeshes = [];
    this.beechImpostors = [];
    this.palmImpostors = [];
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
  /** Master on/off for the grass layer. ON: the replacement fuller-clump GLBs landed (cheaper per field)
   *  and the scatter bottleneck is resolved. */
  private static readonly GRASS_ENABLED = true;
  /** Grass leans HARD on the cheap LOD impostor for perf: full-detail clumps only in the patch RIGHT
   *  next to the ship (`GRASS_NEAR` m), the cheap baked impostor for everything past that, and grass is
   *  not built at all beyond `GRASS_RING` patch rings (distant terrain — too small to read). The fade
   *  band (applyQualityParams) is sized to dissolve grass before this ring's hard cull, so no pop. */
  private static readonly GRASS_NEAR = 30;    // metres: full clump LoD only within this of the patch centre
  private static readonly GRASS_RING = 4;     // patch rings (×40 m ≈ 180 m) — no grass past this

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
      const layer = this.makeGlbLayer(full, lod, ScatterService.GRASS_NEAR, (cx, cz) => this.buildGrass(cx, cz, v));
      layer.maxRing = ScatterService.GRASS_RING;   // cull distant grass — too small to read, costs FPS
      if (gpu) { layer.buildGpu = (cx, cz) => this.buildScatterGpu('grass', cx, cz, v); }
      this.layers.push(layer);
    }
  }

  /** Per-layer GPU patch config: kernel kind, instance capacity, the pre-gate altitude band, the
   *  vertical headroom for the culling box, and whether the material reads instance colors. */
  private static readonly GPU_LAYERS = {
    grass: { wgsl: GRASS_WGSL, capacity: 3072, yLo: 0.6,  yHi: 140, headroom: 4,  color: true },
    rocks: { wgsl: ROCKS_WGSL, capacity: 576,  yLo: 0.25, yHi: 150, headroom: 5,  color: true },
    drift: { wgsl: DRIFT_WGSL, capacity: 400,  yLo: 0.25, yHi: 7,   headroom: 3,  color: true },
    trees: { wgsl: TREES_WGSL, capacity: 256,  yLo: 0.6,  yHi: 80,  headroom: 16, color: false },
    palms: { wgsl: PALMS_WGSL, capacity: 196,  yLo: 0.6,  yHi: 45,  headroom: 12, color: false },
  } as const;

  /** Lazily-created per-kernel dispatchers (each owns its UBO → one dispatch per kernel per frame). */
  private readonly scatterComputes = new Map<string, ScatterCompute>();
  /** Lazily-created MERGED shadow dispatcher — runs all four asset shadow kernels into one patch buffer
   *  (one draw) instead of four separate layers. */
  private shadowCompute: ShadowCompute | null = null;
  /** Merged shadow patch instance capacity — holds the four kinds' blobs together (rocks 576 + drift 400
   *  + trees 256 + palms 196 ≈ 1428; rounded up). A patch rarely carries all four at once. */
  private static readonly SHADOW_GPU_CAPACITY = 1536;

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
    // Probe the patch's terrain min/max for the (GPU-resident, CPU-unreadable) culling box. The old 3×3 grid
    // undersampled a 40 m patch — a hill BETWEEN probe points left the box too short, so correctly-placed
    // instances poked out of it and got frustum-culled except at extreme foreground. Sample densely enough to
    // hit every heightfield texel in the patch so the box truly bounds the terrain.
    const cell = this.terrainService.getCellSizeM() || 24;
    const steps = Math.max(2, Math.min(12, Math.ceil(this.PATCH / cell) + 1));
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const y = this.terrainService.getElevationFast(cx + ((i / steps) * 2 - 1) * half, cz + ((j / steps) * 2 - 1) * half);
        yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
      }
    }
    // Pad the band so a coastal texel can't false-reject the whole patch.
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

  private getShadowCompute(): ShadowCompute {
    if (!this.shadowCompute) {
      const scene = this.sceneService.scene;
      this.shadowCompute = new ShadowCompute(
        scene.getEngine() as import('@babylonjs/core').WebGPUEngine, scene,
        () => this.terrainService.getHeightFieldGPU(),
      );
    }
    return this.shadowCompute;
  }

  /** GPU MERGED shadow patch: one buffer fed by all four asset shadow kernels (rocks/drift/trees/palms),
   *  so the whole near-ring of asset shadows is a single thin-instance draw. Mirrors buildScatterGpu's
   *  culling-box probe, but over the UNION of the asset bands (≈0.25–150 m) so a patch with any kind keeps
   *  its shadows; patches fully over open sea / above the band allocate nothing. */
  private buildShadowGpu(cx: number, cz: number): GpuScatterPatch | null {
    const half = this.PATCH / 2;
    const cell = this.terrainService.getCellSizeM() || 24;
    const steps = Math.max(2, Math.min(12, Math.ceil(this.PATCH / cell) + 1));
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const y = this.terrainService.getElevationFast(cx + ((i / steps) * 2 - 1) * half, cz + ((j / steps) * 2 - 1) * half);
        yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
      }
    }
    if (yMax < 0.25 - 2 || yMin > 150 + 10) { return null; }   // entirely outside every asset band → no shadows

    const pads: PadBox[] = this.townPadsNear(cx, cz).slice(0, 2);
    const engine = this.sceneService.scene.getEngine() as import('@babylonjs/core').WebGPUEngine;
    const patch = new GpuScatterPatch(
      engine, new Vector3(cx, 0, cz), ScatterService.SHADOW_GPU_CAPACITY, half + 1,
      yMin - 2, yMax + 3,   // discs lie flat on the ground → small vertical headroom
      false,                // shadow discs carry no per-instance colour
    );
    this.getShadowCompute().enqueue(patch, cx, cz, this.PATCH, this.densityMul, pads);
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
      this.recenterTrunkXZ(full, ScatterService.PALM_TRUNK_Y);   // bake the off-centre + raised trunk base to the origin (both paths)
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
      this.palmImpostors.push({ tex, w: cfg.height * 0.85, h: cfg.height, pad });   // reused by the static far-coast layer

      this.attachNearLod(full, imp);
      const layer = this.makeGlbLayer(full, imp, 260, (cx, cz) => this.buildPalms(cx, cz, v), true);   // full-detail radius + cross-dissolve
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
      this.recenterTrunkXZ(full);   // (also) put the beech trunk over the origin if its GLB origin is off-axis
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
      this.beechImpostors.push({ tex, w: cfg.w, h: cfg.h, pad });   // reused by the static far-forest layer

      this.attachNearLod(full, imp);
      // Beeches are ~2× the palm's tris, but use the SAME full-detail radius as palms (260 m) per request.
      const layer = this.makeGlbLayer(full, imp, 260, (cx, cz) => this.buildTrees(cx, cz, v), true);   // full-detail radius + cross-dissolve
      if (this.gpuScatterEnabled()) { layer.buildGpu = (cx, cz) => this.buildScatterGpu('trees', cx, cz, v); }
      this.layers.push(layer);
    }
  }

  /**
   * Static FAR-FOREST impostor layer: tree billboards blanketing the WHOLE island's forested slopes, faded
   * IN at distance (FarFadePlugin) so the camera-following scatter ring owns near trees and these give the
   * distant hillsides real tree texture over the §8d shader canopy. Built once (not camera-following): walk
   * the heightfield, gate with the same forest recipe as buildTrees, keep a capped budget, thin-instance the
   * (reused) beech impostors per variant. Cheap — a few instanced draws of unlit alpha-tested billboards.
   */
  private buildFarForest(scene: Scene): void {
    const V = this.beechImpostors.length;
    if (V < 1) { return; }
    const tg = this.terrainService;
    const b = tg.getWorldBounds();
    const cell = tg.getCellSizeM() || 24;
    const nx = Math.max(2, Math.round((b.maxX - b.minX) / cell) + 1);
    const nz = Math.max(2, Math.round((b.maxZ - b.minZ) / cell) + 1);
    const stride = Math.max(1, Math.ceil(Math.sqrt((nx * nz) / 8_000_000)));   // cap cells visited at ~8M (fine sampling → stride 1 on most maps)
    const spanX = b.maxX - b.minX, spanZ = b.maxZ - b.minZ;
    // Match the §8d shader canopy's elevation band (treeline) so impostors cover the SAME green hills, not
    // just the lower slopes the near scatter ring caps at (80 m). _forestF uses [0.035 .. 0.74] × peak.
    const man = tg.getManifest();
    const peak = man?.maxElevation ?? man?.targetPeakElevation ?? 920;
    const yLo = Math.max(0.6, 0.04 * peak), yHi = 0.74 * peak;

    const BUDGET = 600000;   // far billboards are cheap (instanced into ~3 variant meshes → few draws); doubled for denser distant canopy on faraway islands
    // Reservoir-sample a uniform BUDGET subset of ALL forested cells across the map — uniform coverage,
    // bounded memory, no early-stop spatial bias (which a fixed-cap collect would give on large maps).
    const res = new Float32Array(BUDGET * 4);   // [px,pz,py,variant, ...]
    let seen = 0;
    for (let iz = 0; iz < nz; iz += stride) {
      for (let ix = 0; ix < nx; ix += stride) {
        const jx = hash2(ix * 12.9 + iz, iz * 78.2 + ix), jz = hash2(ix * 39.3 + 7.1, iz * 11.7 - 3.3);
        const px = b.minX + ((ix + jx) / (nx - 1)) * spanX;
        const pz = b.maxZ - ((iz + jz) / (nz - 1)) * spanZ;
        const y = tg.getElevationFast(px, pz);
        if (y < yLo || y > yHi) { continue; }                      // forested elevation band (matches canopy)
        const slope = this.slopeAt(px, pz, y, 3.0);
        if (slope > 0.6) { continue; }                             // gentle-ish ground
        const stand = fbm2(px / 45, pz / 45), clearing = fbm2(px / 13 + 9, pz / 13 - 4);
        // Dense canopy: high BASE acceptance in forested stands (so slopes read as continuous forest, not dotted),
        // with the clearing fbm only THINNING toward natural gaps/edges. Softer slope penalty keeps the hills full.
        const standC = smoothstep(0.28, 0.62, stand), clearC = smoothstep(0.18, 0.52, clearing);
        const dens = (0.45 + 0.55 * standC) * clearC * (1 - slope * 0.35);
        if (hash2(px * 3.1 + 1.7, pz * 2.9 - 3.3) > dens) { continue; }
        if (this.nearShoreline(px, pz, 6)) { continue; }
        let slot = seen;
        if (seen >= BUDGET) { slot = (Math.random() * (seen + 1)) | 0; }
        if (slot < BUDGET) {
          res[slot * 4] = px; res[slot * 4 + 1] = pz; res[slot * 4 + 2] = y;
          res[slot * 4 + 3] = Math.min(V - 1, Math.floor(hash2(px * 0.71 + 50, pz * 0.67 - 50) * V));   // beech variant (same partition as buildTrees)
        }
        seen++;
      }
    }
    const take = Math.min(BUDGET, seen);
    if (!take) { return; }
    this.emitFarImpostors(scene, 'far_beech', this.beechImpostors, res, take, b,
      { start: FarFadePlugin.band.start, end: FarFadePlugin.band.end });   // forest: hand off to the beech ring at its usual far band
  }

  /**
   * Static FAR-COAST impostor layer: the SHORE STRIP that buildFarForest deliberately skips (its band starts at
   * ~4 % of peak and it excludes near-shoreline cells). Without this, beach palms + low beeches have NO distant
   * billboard — approaching from the water you see an empty waterline until the camera-following ring's cull
   * radius (~340 m), where they pop in. This blankets the low coastal band with the SAME palm/beech billboards,
   * faded in at distance (FarFade), so the shoreline reads as treed from far out and hands off to the ring.
   */
  private buildFarCoast(scene: Scene): void {
    const nPalm = this.palmImpostors.length, nBeech = this.beechImpostors.length;
    if (nPalm + nBeech < 1) { return; }
    const tg = this.terrainService;
    const b = tg.getWorldBounds();
    const cell = tg.getCellSizeM() || 24;
    const nx = Math.max(2, Math.round((b.maxX - b.minX) / cell) + 1);
    const nz = Math.max(2, Math.round((b.maxZ - b.minZ) / cell) + 1);
    const spanX = b.maxX - b.minX, spanZ = b.maxZ - b.minZ;
    const COAST_HI = 45;                                  // palm band ceiling — the low coastal strip
    const dmul = this.densityMul;
    // The near layers (buildPalms/buildTrees) place on a ~2.5–2.9 m grid; sampling the coast at the terrain cell
    // (~24 m) was ~90× too sparse → the beach read near-empty at distance then "grew" trees on approach. SUB-SAMPLE
    // each coastal cell on a fine grid and run the SAME palm + beech recipes, so the far coast matches the near
    // density AND composition (beech-heavy shoreline + palm groves), not a thin palm-only scatter.
    const SUB = Math.max(1, Math.round(cell / 3.2));     // ~3.2 m sub-grid
    // CRITICAL: use the SAME noise the near layer uses, or groves/clearings land in different places and trees
    // "fade in from nothing" on approach. On WebGPU the near trees come from the compute kernel (GPU hash/fbm);
    // on WebGL from the CPU builders (CPU hash/fbm). Match whichever is active.
    const useGpu = this.gpuScatterEnabled();
    const H = useGpu ? gpuHash2 : hash2;
    const F = useGpu ? gpuFbm2 : fbm2;

    const BUDGET = 900000;
    const res = new Float32Array(BUDGET * 4);   // [px,pz,py,variant, ...]
    let seen = 0;
    const consider = (px: number, pz: number, py: number, variant: number): void => {
      let slot = seen;
      if (seen >= BUDGET) { slot = (Math.random() * (seen + 1)) | 0; }
      if (slot < BUDGET) {
        res[slot * 4] = px; res[slot * 4 + 1] = pz; res[slot * 4 + 2] = py; res[slot * 4 + 3] = variant;
      }
      seen++;
    };
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const cxw = b.minX + (ix / (nx - 1)) * spanX;
        const czw = b.maxZ - (iz / (nz - 1)) * spanZ;
        const yc = tg.getElevationFast(cxw, czw);
        if (yc < -8 || yc > COAST_HI + 20) { continue; }   // cheap prune: skip deep ocean / clear upland whole-cells
        for (let sz = 0; sz < SUB; sz++) {
          for (let sx = 0; sx < SUB; sx++) {
            const px = cxw + ((sx + hash2(ix * 7.1 + sx, iz * 3.7 + sz)) / SUB - 0.5) * cell;
            const pz = czw + ((sz + hash2(ix * 5.3 + sz, iz * 9.1 + sx)) / SUB - 0.5) * cell;
            const y = tg.getElevationFast(px, pz);
            if (y < 0.6 || y > COAST_HI) { continue; }
            const slope = this.slopeAt(px, pz, y, 2.5);
            if (slope > 0.5) { continue; }
            const hashA = H(px * 3.1 + 1.7, pz * 2.9 - 3.3);   // SAME acceptance hash both near layers use
            // Palm grove recipe (buildPalms) and forest recipe (buildTrees) — independent, like the two near layers,
            // so a spot can host both. Each tests the same hashA against its own density.
            const standP = F(px / 28 + 60, pz / 28 - 40);
            const densP = smoothstep(0.48, 0.80, standP) * (1 - slope * 0.6) * 0.95 * dmul;
            const palmOk = nPalm > 0 && hashA <= densP;
            const standB = F(px / 45, pz / 45), clearB = F(px / 13 + 9, pz / 13 - 4);
            const densB = smoothstep(0.46, 0.72, standB) * smoothstep(0.4, 0.62, clearB) * (1 - slope * 0.8) * 0.18 * dmul;
            const beechOk = nBeech > 0 && hashA <= densB;
            if (!palmOk && !beechOk) { continue; }
            if (this.nearShoreline(px, pz, 7)) { continue; }       // 7 m setback (matches buildPalms/buildTrees)
            const vh = H(px * 0.71 + 50, pz * 0.67 - 50);
            if (palmOk) { consider(px, pz, y, Math.min(nPalm - 1, Math.floor(vh * nPalm))); }
            if (beechOk) { consider(px, pz, y, nPalm + Math.min(nBeech - 1, Math.floor(vh * nBeech))); }
          }
        }
      }
    }
    const take = Math.min(BUDGET, seen);
    if (!take) { return; }
    // Combined atlas: palms first [0..nPalm), then beeches [nPalm..); the per-tree variant was baked in above.
    const imposts = [...this.palmImpostors, ...this.beechImpostors];
    this.emitFarImpostors(scene, 'far_coast', imposts, res, take, b, this.coastAppear);   // coast fills in by the ring cull
  }

  /**
   * Shared emit for the static far-impostor layers (forest slopes, coast strip): compose each sampled placement
   * into a billboard matrix (per-instance scale/yaw + convexity sink), spatially CHUNK them so off-screen chunks
   * frustum-cull, and thin-instance one hidden-template-per-variant + per-(variant,chunk) clone, all sharing the
   * variant's FarFade + haze material. `place` is a packed [px,pz,py, …] buffer; `pickVariant` indexes `imposts`.
   */
  private emitFarImpostors(
    scene: Scene, name: string, imposts: { tex: Texture; w: number; h: number; pad: number }[],
    place: Float32Array, count: number, b: { minX: number; maxX: number; minZ: number; maxZ: number },
    appear: { start: number; end: number },
  ): void {
    const tg = this.terrainService;
    const spanX = b.maxX - b.minX, spanZ = b.maxZ - b.minZ;
    const V = imposts.length;
    // Spatially CHUNK so off-screen islands frustum-cull instead of the WHOLE map drawing every frame: one mesh
    // per (variant, chunk); only chunks inside the view frustum draw (a few extra draws, big vertex/fill saving).
    const chunkM = Math.max(400, Math.max(spanX, spanZ) / 8);   // ~8 chunks across the larger span
    const ncx = Math.max(1, Math.ceil(spanX / chunkM));
    const ncz = Math.max(1, Math.ceil(spanZ / chunkM));
    const scaleV = new Vector3(), posV = new Vector3(), up = Vector3.Up(), q = new Quaternion(), mat = new Matrix();
    const groups: number[][][] = Array.from({ length: V }, () => Array.from({ length: ncx * ncz }, () => [] as number[]));
    for (let k = 0; k < count; k++) {
      const px = place[k * 4], pz = place[k * 4 + 1], py = place[k * 4 + 2];
      const v = Math.max(0, Math.min(V - 1, place[k * 4 + 3] | 0));
      const s = 0.85 + hash2(px * 5.3 - 2.0, pz * 4.7 + 8.0) * 0.30;
      scaleV.set(s, s, s);
      // Distant hills are drawn at COARSE clipmap LOD whose chord cuts UNDER convex hilltops, so an impostor at
      // the true height floats above the visible hill. Sink it by the local convexity (height above a ~far-LOD-
      // cell-radius average) so hilltop impostors settle onto the drawn hill; flats/valleys (the coast) untouched.
      const d = 24;
      const avg = (tg.getElevationFast(px + d, pz) + tg.getElevationFast(px - d, pz)
                 + tg.getElevationFast(px, pz + d) + tg.getElevationFast(px, pz - d)) * 0.25;
      const convexSink = Math.min(10, Math.max(0, py - avg) * 1.15);
      posV.set(px, py - 0.4 - convexSink, pz);
      Quaternion.RotationAxisToRef(up, hash2(px * 1.13 + 7, pz * 1.07 - 7) * Math.PI * 2, q);
      Matrix.ComposeToRef(scaleV, q, posV, mat);
      const cgx = Math.min(ncx - 1, Math.max(0, Math.floor(((px - b.minX) / spanX) * ncx)));
      const cgz = Math.min(ncz - 1, Math.max(0, Math.floor(((b.maxZ - pz) / spanZ) * ncz)));
      const arr = groups[v][cgz * ncx + cgx]; mat.copyToArray(arr, arr.length);
    }

    for (let v = 0; v < V; v++) {
      const info = imposts[v];
      const template = createCrossImpostor(scene, `${name}_${v}`, info.tex, info.w, info.h, info.pad);
      template.isVisible = false;                    // the template never draws — it owns the shared geometry/material
      if (template.material) {
        template.material.unfreeze();                // fade + haze need live per-frame uniform binds
        // DITHER dissolve (default) — billboards screen-door in/out by distance instead of growing/shrinking;
        // legacy `ignis_lod_dissolve='0'` keeps the scale-collapse FarFade.
        if (this.lodDissolve) { new LodDitherPlugin(template.material, appear); }
        else { new FarFadePlugin(template.material); }
        new ImpostorHazePlugin(template.material);    // aerial-perspective haze → recedes WITH the terrain
        this.sceneService.excludeFromPrePass(template.material);
      }
      this.sceneService.excludeFromGlow(template);
      this.farMeshes.push(template);                 // kept alive (owns geometry+material); disposed with the layer
      for (let ci = 0; ci < ncx * ncz; ci++) {
        const arr = groups[v][ci];
        if (!arr.length) { continue; }
        const cm = template.clone(`${name}_${v}_c${ci}`);
        cm.makeGeometryUnique();                      // independent thin-instance storage per chunk (mirrors ThinInstancePatch)
        cm.isVisible = true;
        cm.isPickable = false;
        cm.renderingGroupId = 2;                      // world layer (terrain/ocean/vessels)
        cm.thinInstanceSetBuffer('matrix', new Float32Array(arr), 16, true);
        cm.thinInstanceRefreshBoundingInfo(true);     // REAL world bounds → Babylon frustum-culls when off-screen
        cm.doNotSyncBoundingInfo = true;
        cm.freezeWorldMatrix();
        this.sceneService.excludeFromGlow(cm);
        this.farMeshes.push(cm);
      }
    }
  }

  /** A GLB tree sub-layer: full mesh near, crossed-quad impostor far, swapped per-patch by distance. */
  /** Attach the near LoD transition to a tree (full, impostor) pair. DITHER path (default): the full mesh stays
   *  SOLID (no fade) and the impostor screen-door dissolves — in across the cross-dissolve ring (revealing the
   *  full mesh through the dither gaps) and out at the patch-cull edge — so nothing grows/shrinks. Legacy path
   *  (`ignis_lod_dissolve='0'`): the old scale-collapse swap. */
  private attachNearLod(full: Mesh, imp: Mesh): void {
    if (this.lodDissolve) {
      if (imp.material) { new LodDitherPlugin(imp.material, this.ringAppear, this.treeFade); }
    } else {
      new NearFadePlugin(full.material, false);
      if (imp.material) { new NearFadePlugin(imp.material, true); }
    }
  }

  private makeGlbLayer(full: Mesh, imp: Mesh, near: number, build: (cx: number, cz: number) => PatchData,
                       crossDissolve = false): Layer {
    const camDist = (patch: IPatch): number => {
      const c = this.sceneService.camera;
      return c ? Vector3.Distance(patch.getPosition(), c.position) : Infinity;
    };
    let manager: PatchManager;
    if (crossDissolve && this.lodDissolve) {
      // 3-state LoD: full only (inside ring) / BOTH (the transition ring → cross-dissolve) / impostor only (past
      // ring). In the ring the patch materializes its impostor AND full clone on the same instance buffers; each
      // carries NearFadePlugin (fade curves span the whole ring), so the billboard morphs into the 3D mesh.
      const band = NearFadePlugin.params.band;
      manager = new PatchManager([imp, full], (patch) => {
        const d = camDist(patch);
        if (d < near - band) { return 2; }   // full only (near)
        if (d > near + band) { return 0; }   // impostor only (far)
        return 1;                            // both → cross-dissolve ring
      }, [1, 1, 1], (patch, level) => {
        if (level === 2) { patch.createInstances(full); }
        else if (level === 0) { patch.createInstances(imp); }
        else { patch.createInstances(imp, 1, full); }   // ring: render both LoDs (NearFade fades each by distance)
      });
    } else {
      manager = new PatchManager([imp, full], (patch) => camDist(patch) < near ? 1 : 0, [1, 1]);
    }
    manager.setLodUpdateCadence(this.MAX_BUILDS_PER_FRAME);
    return { mat: full.material as Material, manager, patches: new Map(), build, baseMeshes: [imp, full] };
  }

  // ── Fake shadow blobs (cheap cast-shadow decals for the static land assets) ──

  /** Build the shared shadow decal (a flat soft-edged dark disc) and register one near-ring shadow
   *  layer per land asset TYPE. Each reuses that type's existing placement in "shadow mode" (variant
   *  -1 → keep every candidate), so the blobs are a single source of truth with the assets — one disc
   *  per palm/tree/rock/log. The `ShadowBlobPlugin` stretches each round disc away from the sun. */
  private registerShadows(scene: Scene): void {
    // DAPPLED CANOPY shadow (alpha): instead of a smooth grey ellipse, a broken-edged blob with radial frond
    // streaks and light gaps punched through — so it reads as dappled tree shade, not a flat decal. Rotationally
    // symmetric, so it still works with the ShadowBlobPlugin's sun-direction stretch (no per-frame UV rotation).
    const S = 256, c = S / 2, R = S / 2 - 6;
    const grad = new DynamicTexture('scatter_shadow_grad', S, scene, false);
    const ctx = grad.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, S, S);
    const rnd = (() => { let s = 0x9e3779b9; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
    // 1) base canopy on a WAVY (irregular) disc → no clean ring
    const g = ctx.createRadialGradient(c, c, 2, c, c, R);
    g.addColorStop(0.00, 'rgba(255,255,255,0.82)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.52)');
    g.addColorStop(0.85, 'rgba(255,255,255,0.16)');
    g.addColorStop(1.00, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = g;
    ctx.beginPath();
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = R * (0.80 + 0.18 * Math.sin(a * 5) + 0.06 * Math.sin(a * 11 + 1.3));
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.fill();
    // 2) frond streaks — additive radial spokes (palm/canopy ribs), slightly past the edge
    ctx.lineCap = 'round';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
      const r = R * (0.7 + rnd() * 0.45);
      ctx.strokeStyle = `rgba(255,255,255,${0.10 + rnd() * 0.10})`;
      ctx.lineWidth = 3 + rnd() * 5;
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r); ctx.stroke();
    }
    // 3) dapple — punch light gaps (sun through the leaves)
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (let i = 0; i < 60; i++) {
      const a = rnd() * Math.PI * 2, rr = rnd() * R * 0.92;
      ctx.globalAlpha = 0.12 + rnd() * 0.26;   // subtle light gaps — don't hollow the shadow out
      ctx.beginPath(); ctx.arc(c + Math.cos(a) * rr, c + Math.sin(a) * rr, 2 + rnd() * 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
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

    // ONE near-ring shadow layer for ALL asset types (was four — one per kind — = four draws per patch).
    // The four kinds' blob placements (variant -1 keeps every candidate, shadowMode emits flat discs) are
    // merged into a single mesh per patch: on CPU by concatenating their matrix buffers; on GPU by running
    // all four kernels into one buffer sharing an append counter (ShadowCompute). 1 draw per patch.
    const shadowBuilds: Array<(cx: number, cz: number) => PatchData> = [
      (cx, cz) => this.buildRocks(cx, cz, -1, true),
      (cx, cz) => this.buildDriftwood(cx, cz, -1, true),
      (cx, cz) => this.buildTrees(cx, cz, -1, true),
      (cx, cz) => this.buildPalms(cx, cz, -1, true),
    ];
    const layer = this.makeShadowLayer(disc, (cx, cz) => this.mergeShadowPatches(shadowBuilds, cx, cz));
    layer.tag = 'shadow';   // debug toggle: shadow('all', false)
    if (this.gpuScatterEnabled()) { layer.buildGpu = (cx, cz) => this.buildShadowGpu(cx, cz); }
    this.layers.push(layer);
  }

  /** Merge the four asset-type shadow-blob builds for one patch into a SINGLE matrix buffer (one draw).
   *  Shadow discs carry no per-instance colour, so only the matrices concatenate. */
  private mergeShadowPatches(builds: Array<(cx: number, cz: number) => PatchData>, cx: number, cz: number): PatchData {
    const parts = builds.map((b) => b(cx, cz).matrix);
    let total = 0;
    for (const m of parts) { total += m.length; }
    if (!total) { return EMPTY_PATCH; }
    const matrix = new Float32Array(total);
    let off = 0;
    for (const m of parts) { matrix.set(m, off); off += m.length; }
    return { matrix, color: null };
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

  /** Three CC0 photoreal PBR stone sets (KTX2: albedo + OpenGL normal + roughness). The 5 rock SHAPES are
   *  spread across these as visual variations (shape v → material v % 3). */
  private static readonly ROCK_MATERIALS = [
    { albedo: 'rock_05_albedo.ktx2',      normal: 'rock_05_normal.ktx2',      rough: 'rock_05_rough.ktx2' },
    { albedo: 'rock_04_albedo.ktx2',      normal: 'rock_04_normal.ktx2',      rough: 'rock_04_rough.ktx2' },
    { albedo: 'rock_cracked_albedo.ktx2', normal: 'rock_cracked_normal.ktx2', rough: 'rock_cracked_rough.ktx2' },
  ];

  /** Per-instance stone tints — now GENTLE (near-neutral) since the 3 photoreal textures carry the real colour;
   *  these only add subtle lightness/hue scatter within a set. KEEP IN SYNC with scatter-compute.ts `tints`. */
  private static readonly ROCK_TINTS: ReadonlyArray<readonly [number, number, number]> = [
    [1.00, 1.00, 1.00], [0.92, 0.90, 0.87], [0.87, 0.89, 0.93],
    [1.00, 0.97, 0.92], [0.91, 0.93, 0.90], [0.96, 0.96, 0.99],
  ];

  /** Load the 5 authored rock shapes (geometry-only), each assigned one of the 3 photoreal PBR stone
   *  materials as a variation, with a real decimated *_lod.glb far-LOD per shape. Any load failure → the
   *  procedural-primitive rock. */
  private async registerRocks(scene: Scene): Promise<void> {
    const mats = ScatterService.ROCK_MATERIALS.map((m, i) => {
      const mat = buildScatterRockPBR(scene, `scatter_rock_mat_${i}`, m.albedo, m.normal, m.rough);
      this.sceneService.excludeFromPrePass(mat);
      return mat;
    });
    for (let v = 0; v < ScatterService.ROCK_SHAPES.length; v++) {
      const cfg = ScatterService.ROCK_SHAPES[v];
      const mat = mats[v % mats.length];   // spread the 5 shapes across the 3 stone variations
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

  /** Driftwood IS weathered tree wood — so it reuses the SAME bark PBR sets as the palm + beech (KTX2),
   *  as two material variations (shape v → material v % 2), slightly bleached via albedoTint. */
  private static readonly DRIFT_MATERIALS = [
    { albedo: 'palm_bark_albedo.ktx2',  normal: 'palm_bark_normal.ktx2',  rough: 'palm_bark_rough.ktx2',  tint: [1.04, 1.00, 0.92] as const },
    { albedo: 'beech_bark_albedo.ktx2', normal: 'beech_bark_normal.ktx2', rough: 'beech_bark_rough.ktx2', tint: [0.98, 0.99, 1.00] as const },
  ];

  /** Per-instance driftwood tints — gentle now that the bark texture carries the look: silver, bleached,
   *  tan, brown, driftbrown, waterlogged (subtle). */
  private static readonly DRIFT_TINTS: ReadonlyArray<readonly [number, number, number]> = [
    [1.00, 1.00, 1.02], [1.02, 1.00, 0.96], [0.96, 0.93, 0.88],
    [0.90, 0.86, 0.80], [0.97, 0.94, 0.88], [0.86, 0.88, 0.90],
  ];

  /** Load the 5 authored driftwood shapes (geometry-only), each assigned one of the 2 bark PBR materials,
   *  with a real *_lod.glb far-LOD per shape. Any failure → the primitive. */
  private async registerDriftwood(scene: Scene): Promise<void> {
    const mats = ScatterService.DRIFT_MATERIALS.map((m, i) => {
      const mat = buildScatterRockPBR(scene, `scatter_drift_mat_${i}`, m.albedo, m.normal, m.rough, m.tint);
      this.sceneService.excludeFromPrePass(mat);
      return mat;
    });
    for (let v = 0; v < ScatterService.DRIFT_SHAPES.length; v++) {
      const cfg = ScatterService.DRIFT_SHAPES[v];
      const mat = mats[v % mats.length];
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
        if (l.disabled) { continue; }   // debug: layer toggled off
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
              if (p instanceof GpuScatterPatch) { for (const sc of this.scatterComputes.values()) { sc.cancel(p); } this.shadowCompute?.cancel(p); }
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

  /**
   * Re-centre a tree/palm so its TRUNK AXIS sits at object-space X/Z = 0. Some authored GLBs put the origin
   * under an off-centre vertex (e.g. a drooping palm frond tip that also defeats groundToBase by sitting at
   * y=0), so the trunk lands laterally offset from the placement origin — and since each instance is yaw-
   * rotated, that offset swings to a different direction per tree (shadows scattered, trunk never over its
   * shadow). The frond canopy is roughly symmetric about the trunk, so the vertex CENTROID ≈ the trunk axis;
   * baking −centroid into the geometry plants the trunk under the origin (and thus under its shadow).
   */
  private recenterTrunkXZ(mesh: Mesh, trunkY = 0): void {
    const pos = mesh.getVerticesData('position');
    if (!pos || !pos.length) { return; }
    let sx = 0, sz = 0; const n = pos.length / 3;
    for (let i = 0; i < pos.length; i += 3) { sx += pos[i]; sz += pos[i + 2]; }
    const cx = sx / n, cz = sz / n;
    // `trunkY` (>0 for palms) is the authored height of the trunk BASE above the GLB origin — baking it down
    // moves the base to local y=0 so BOTH the CPU and GPU placement plant the trunk at the ground with no
    // per-scale sink (the GLB's lowest vertex is a drooping frond, which groundToBase can't use).
    if (Math.abs(cx) > 0.03 || Math.abs(cz) > 0.03 || trunkY !== 0) {
      mesh.position.set(-cx, -trunkY, -cz);
      mesh.bakeCurrentTransformIntoVertices();
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
        const core = step01(0.50, 0.78, bush);                        // 0 between bushes → 1 at a bush heart
        const coreD = core * core * core;                             // cubed: concentrates hard into the heart
        const alt = 1 - smoothstep(90, 140, y);                       // fade out toward the rocky uplands

        // FOREST: lush, near-continuous coverage on inland/higher ground. Permissive region gate + a base
        // meadow floor (0.55) so most of the forest carries grass, denser still toward bush hearts.
        const forestRegion = step01(0.34, 0.50, region);
        const forestCover = 0.55 + 0.45 * coreD;
        const lowland = smoothstep(1.5, 13, y);                       // favors higher ground (forest)
        const forestDens = forestRegion * forestCover * lowland;
        // BEACH: modest grass on the sand band (~old forest amount) — cubed bush cores only, no meadow floor.
        const beachBand = smoothstep(0.7, 1.8, y) * (1 - smoothstep(4, 11, y));
        const beachRegion = step01(0.50, 0.62, region);
        const beachDens = beachRegion * coreD * beachBand * 0.85;
        const density = Math.max(forestDens, beachDens) * alt * (1 - slope * 0.7) * this.densityMul;
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
    this.rebuildPatches();
  }

  /** Drop every live patch so ensurePatches regenerates them (after a quality/density/placement change). */
  private rebuildPatches(): void {
    for (const l of this.layers) {
      for (const [, p] of l.patches) {
        if (p) {
          l.manager.removePatch(p);
          if (p instanceof GpuScatterPatch) { for (const sc of this.scatterComputes.values()) { sc.cancel(p); } this.shadowCompute?.cancel(p); }
          p.dispose();
        }
      }
      l.patches.clear();
    }
    this._lastCx = NaN; this._patchPending = true; this._hasFilledOnce = false;   // force ensurePatches to rebuild the grid
    if (this.enabled) { this.ensurePatches(); }
  }

  /** DEBUG: live-tune the per-asset planting sink from the console — __palmSink(0.9) / __treeSink(0.5), then
   *  the value that looks right gets baked as the default. Rebuilds patches on each call. */
  private setupSinkDebug(): void {
    const w = window as unknown as Record<string, (v: number) => void>;
    const palm = (v: number) => { this.palmSink = v; this.rebuildPatches(); console.info(`[probe] palmSink = ${v}`); };
    const tree = (v: number) => { this.treeSink = v; this.rebuildPatches(); console.info(`[probe] treeSink = ${v}`); };
    // Register both bare + underscored names so either form works in the console.
    w['palmSink'] = palm; w['__palmSink'] = palm;
    w['treeSink'] = tree; w['__treeSink'] = tree;
    // Shadow toggle: shadow(false) hides ALL asset shadows (now one merged layer; arg kept for back-compat).
    (w as unknown as Record<string, (k?: unknown, on?: boolean) => void>)['shadow'] = (_kind?: unknown, on = false) => {
      for (const l of this.layers) {
        if (l.tag === 'shadow') {
          l.disabled = !on;
          for (const [, p] of l.patches) { if (p) { l.manager.removePatch(p); p.dispose(); } }
          l.patches.clear();
        }
      }
      this._lastCx = NaN; this._patchPending = true;   // force ensurePatches to re-scan
      console.info(`[probe] shadows ${on ? 'ON' : 'OFF'}`);
    };
    console.info('[probe] tuners ready → palmSink(0.7) · treeSink(0.35) · shadow("drift",false)');
  }

  /** Apply a quality tier's radius/density/enabled flags + the matching fade band (no rebuild). */
  private applyQualityParams(q: number): void {
    const t = ScatterService.QUALITY[Math.max(0, Math.min(4, q))];
    this.enabled = t.enabled;
    this.densityMul = t.density;
    this.RADIUS = Math.max(1, t.radius);
    this.shadowRing = Math.min(this.RADIUS, 3);   // blobs only near the camera (~120 m)
    // Grass dissolves at its OWN (smaller) ring cap, not the global draw radius — so the cheap-LoD grass
    // shrinks to nothing just before GRASS_RING's hard patch cull (no pop), and never reaches out to the
    // distant terrain where it isn't worth the FPS. Fade plugin is grass-only in the active asset path.
    const grassRing = Math.min(ScatterService.GRASS_RING, this.RADIUS);
    GrassFadePlugin.fade.end   = (grassRing + 0.5) * this.PATCH;
    GrassFadePlugin.fade.start = Math.max(20, GrassFadePlugin.fade.end - 60);
    // Palms/beeches dissolve at their OWN (full) draw radius — a fade ring across the last ~1 patch so the
    // camera-following trees melt into the ground at the patch-cull edge instead of popping into a new spot. The
    // band sits OUTSIDE the NearFade cross-dissolve RING (near+band), so the impostor reaches full size and
    // finishes morphing in BEFORE the cull dissolve starts (no double-shrink mid-ring).
    const ringOuter = NearFadePlugin.params.near + NearFadePlugin.params.band;
    this.treeFade.end   = (this.RADIUS + 0.5) * this.PATCH;
    // Prefer the last ~1 patch before the cull, but never start before the cross-dissolve ring ends; and at low
    // quality (cull inside the ring) clamp so start < end (a reversed smoothstep band would mis-fade).
    this.treeFade.start = Math.min(this.treeFade.end - 0.5 * this.PATCH,
                                   Math.max(ringOuter, this.treeFade.end - this.PATCH));
    // Far-coast billboards ramp IN exactly as the near ring's impostor dithers OUT at its cull edge (the coast
    // now matches the near density, so it must be COMPLEMENTARY — start at the ring's far edge, full by the cull —
    // else the [near, cull] zone would render the ring trees AND the coast = double density). Clamp start<end.
    this.coastAppear.end   = (this.RADIUS + 0.5) * this.PATCH;
    this.coastAppear.start = Math.min(ringOuter, this.coastAppear.end - 0.5 * this.PATCH);
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
        posV.set(px, y - this.treeSink * s, pz);   // sink = authored base height × instance scale → plants at any size
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
        posV.set(px, y - this.palmSink, pz);   // trunk base is baked to the origin → just plant it at the ground
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
