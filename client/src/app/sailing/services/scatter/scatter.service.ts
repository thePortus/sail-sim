import { Injectable, inject } from '@angular/core';
import {
  Color3, Material, Matrix, Mesh, Observer, Quaternion, Scene, StandardMaterial, Texture, Vector3,
} from '@babylonjs/core';
import { SceneService } from '../scene.service';
import { TerrainService } from '../terrain.service';
import { WeatherService } from '../weather.service';
import { ThinInstancePatch } from './instancing/thin-instance-patch';
import { PatchManager } from './instancing/patch-manager';
import { createGrassBlade } from './grass/grass-blade';
import { createRock } from './props/rock';
import { createDriftwood } from './props/driftwood';
import { createTree } from './props/tree';
import { createPalm } from './props/palm';
import { GrassFadePlugin } from './grass/grass-fade.plugin';
import { PalmWindPlugin } from './props/palm-wind.plugin';
import { loadScatterMesh, createCrossImpostor } from './asset-loader';

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
  patches: Map<string, ThinInstancePatch | null>;
  build: (cx: number, cz: number) => PatchData;
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

  // Reusable temporaries (avoid per-instance allocation in the build loops).
  private readonly _scaleV = new Vector3();
  private readonly _posV = new Vector3();
  private readonly _up = Vector3.UpReadOnly;
  private readonly _stride = new Float32Array(16);   // scratch for the instance shuffle

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

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    const cam = this.sceneService.camera;
    if (!scene || !cam) { return; }

    this.applyQualityParams(this._quality);   // radius / density / enabled + fade band (no rebuild yet)

    // Land grass — green. swayMul 0 → the wind-sway maths is compiled out of the shader (barely
    // visible at this scale, not worth the per-vertex cost). Multi-tier LoD: full detail+density up
    // close, then flat blades at progressively thinned density with distance (most patches are far).
    // (Names start with `scatter_` so the ocean refraction RTT's exclusion predicate skips foliage.)
    this.layers.push(this.makeLayer(scene, 'scatter_grass', new Color3(0.10, 0.26, 0.05), 0, [
      { stacks: 4, nearerThan: 50,       fraction: 1.0 },
      { stacks: 1, nearerThan: 150,      fraction: 0.45 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.22 },
    ], (cx, cz) => this.buildGrass(cx, cz)));

    // Beach rocks — solid faceted stones, per-instance colour (white diffuse × instance colour) and
    // size (small → boulder). No wind sway (swayMul 0). LoD: detailed near, low-poly far.
    this.layers.push(this.makeLayer(scene, 'scatter_rocks', new Color3(1, 1, 1), 0, [
      { stacks: 2, nearerThan: 90,       fraction: 1.0 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.7 },
    ], (cx, cz) => this.buildRocks(cx, cz), createRock, true));

    // Driftwood — weathered logs washed up near the tide line; per-instance length + bleached colour.
    this.layers.push(this.makeLayer(scene, 'scatter_driftwood', new Color3(1, 1, 1), 0, [
      { stacks: 2, nearerThan: 90,       fraction: 1.0 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.7 },
    ], (cx, cz) => this.buildDriftwood(cx, cz), createDriftwood, true));

    // Forest trees — stylised low-poly trees (baked vertex colours: brown trunk + green canopy) in
    // the inland forest-mask zone. White diffuse so the vertex colours show; no wind sway. LoD: full
    // detail near, low-poly + thinned far.
    // solid:false → double-sided + two-sided lighting + matte, so the thin leaves/fronds read from
    // any angle (not one-sided) and shade like foliage.
    this.layers.push(this.makeLayer(scene, 'scatter_trees', new Color3(1, 1, 1), 0, [
      { stacks: 2, nearerThan: 110,      fraction: 1.0 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.6 },
    ], (cx, cz) => this.buildTrees(cx, cz), createTree, false));

    // Beach palms — authored GLB variants (A/B/C) with baked-wind COLOR_0 + crossed-quad impostor
    // far-LOD, replacing the old procedural-primitive palms. Loaded async (streamed + cached) before
    // the patches build; falls back to the primitive palm if a GLB fails to load.
    await this.registerPalms(scene);

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
        PalmWindPlugin.WIND.dirX = wd.x / mag;
        PalmWindPlugin.WIND.dirZ = wd.z / mag;
        PalmWindPlugin.WIND.amplitude = 0.10 + Math.min(0.55, (wd.speed ?? 8) / 24) * 0.30;
      }
      this._palmTime += (scene.getEngine().getDeltaTime() / 1000) * 1.4;
      PalmWindPlugin.WIND.time = this._palmTime;
      this.ensurePatches();
      for (const l of this.layers) { l.manager.update(); }
    });
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
      new PalmWindPlugin(full.material);
      this.sceneService.excludeFromGlow(full);
      this.sceneService.excludeFromPrePass(full.material);

      const tex = new Texture(`/assets/scatter/textures/${cfg.impostor}`, scene);
      const imp = createCrossImpostor(scene, `scatter_palm_${v}_imp`, tex, cfg.height * 0.85, cfg.height);
      this.sceneService.excludeFromGlow(imp);
      if (imp.material) { this.sceneService.excludeFromPrePass(imp.material); }

      this.layers.push(this.makePalmLayer(full, imp, v));
    }
  }

  /** A palm sub-layer: full GLB mesh near, crossed-quad impostor far, swapped per-patch by distance. */
  private makePalmLayer(full: Mesh, imp: Mesh, variant: number): Layer {
    const NEAR = 130;   // metres — full mesh inside, impostor beyond
    const manager = new PatchManager([imp, full], (patch) => {
      const c = this.sceneService.camera;
      const d = c ? Vector3.Distance(patch.getPosition(), c.position) : Infinity;
      return d < NEAR ? 1 : 0;   // 1 = full (near), 0 = impostor (far)
    }, [1, 1]);
    manager.setLodUpdateCadence(this.MAX_BUILDS_PER_FRAME);
    return { mat: full.material as Material, manager, patches: new Map(), build: (cx, cz) => this.buildPalms(cx, cz, variant) };
  }

  /** Fallback: the old procedural-primitive palm as a single (all-variant) scatter layer. */
  private registerPalmFallback(scene: Scene): void {
    this.layers.push(this.makeLayer(scene, 'scatter_palms', new Color3(1, 1, 1), 0, [
      { stacks: 2, nearerThan: 130,      fraction: 1.0 },
      { stacks: 1, nearerThan: Infinity, fraction: 0.7 },
    ], (cx, cz) => this.buildPalms(cx, cz, -1), createPalm, false));
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
    return { mat, manager, patches: new Map(), build };
  }

  /** Build any new cells entering the radius (budgeted across all layers), cull cells that left. */
  private ensurePatches(): void {
    const cam = this.sceneService.camera;
    if (!cam || !this.layers.length || !this.enabled) { return; }
    const cx = Math.round(cam.position.x / this.PATCH);
    const cz = Math.round(cam.position.z / this.PATCH);
    const R = this.RADIUS;

    let built = 0;
    for (let ix = cx - R; ix <= cx + R && built < this.MAX_BUILDS_PER_FRAME; ix++) {
      for (let iz = cz - R; iz <= cz + R && built < this.MAX_BUILDS_PER_FRAME; iz++) {
        const key = ix + ',' + iz;
        for (const l of this.layers) {
          if (built >= this.MAX_BUILDS_PER_FRAME) { break; }
          if (l.patches.has(key)) { continue; }
          const data = l.build(ix * this.PATCH, iz * this.PATCH);
          built++;
          if (data.matrix.length === 0) { l.patches.set(key, null); continue; }
          const p = new ThinInstancePatch(new Vector3(ix * this.PATCH, 0, iz * this.PATCH), data.matrix, data.color);
          l.manager.addPatch(p);
          l.patches.set(key, p);
        }
      }
    }

    const cull = R + 1;
    for (const l of this.layers) {
      for (const [key, p] of l.patches) {
        const c = key.split(',');
        if (Math.abs(+c[0] - cx) > cull || Math.abs(+c[1] - cz) > cull) {
          if (p) { l.manager.removePatch(p); p.dispose(); }
          l.patches.delete(key);
        }
      }
    }
  }

  /** Write one instance (yaw-only rotation — the wind plugin relies on this) into the buffer. */
  private compose(buf: Float32Array, idx: number, px: number, y: number, pz: number, sx: number, sy: number, sz: number): void {
    this._scaleV.set(sx, sy, sz);
    this._posV.set(px, y, pz);
    Matrix.Compose(this._scaleV, Quaternion.RotationAxis(this._up, Math.random() * Math.PI * 2), this._posV)
      .copyToArray(buf, idx * 16);
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

  /** Slope magnitude (rise/run) from a FORWARD difference reusing the already-sampled height — 2
   *  terrain lookups instead of 4, which roughly halves the dominant cost of a patch build. */
  private slopeAt(px: number, pz: number, baseY: number, E: number): number {
    const g = this.terrainService;
    const dyx = g.getElevation(px + E, pz) - baseY;
    const dyz = g.getElevation(px, pz + E) - baseY;
    return Math.sqrt(dyx * dyx + dyz * dyz) / E;
  }

  /** Build one patch's grass: terrain-snapped, biome-gated (sparse on beaches → lush inland, none on
   *  cliffs/peaks/underwater), broken into clumps by low-freq noise. */
  private buildGrass(cx: number, cz: number): PatchData {
    // Sparser sample grid (~35% fewer candidates → fewer instances + cheaper build); each blade is
    // widened (W) to fill the larger gaps, so coverage looks the same for noticeably less geometry.
    const res = 58, size = this.PATCH, cell = size / res, E = 2.0, W = 1.4;
    const tmp = new Float32Array(res * res * 2 * 16);   // ×2: clump cores can place a second blade
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        const px = cx + (x + Math.random()) * cell - size / 2;
        const pz = cz + (z + Math.random()) * cell - size / 2;
        const y = getY(px, pz);
        if (y < 0.6) { continue; }

        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.7) { continue; }

        const clump = fbm2(px / 13, pz / 13);
        const lowland = smoothstep(1.5, 13, y);            // 0 at the shore → 1 on the true lowland
        const alt = 1 - smoothstep(90, 140, y);            // fade out toward the rocky uplands
        const slopeFac = 1 - slope * 0.7;
        const tuft = smoothstep(0.62, 0.88, clump);
        const coreF = smoothstep(0.80, 0.96, clump);
        const clumpD = tuft * (0.9 + 0.7 * coreF);
        const beachD = Math.max(clumpD, 0.008);
        const lushD = Math.max(0.78, clumpD);
        const density = (beachD + (lushD - beachD) * lowland) * alt * slopeFac * this.densityMul;
        if (Math.random() > density) { continue; }

        const s = 0.95 + Math.random() * 0.85;   // ~0.95–1.8 m tall
        this.compose(tmp, kept++, px, y, pz, s * W, s, s);   // widened across (X); height stays natural
        if (coreF > 0.35 && Math.random() < coreF * 0.85) {
          const s2 = 0.85 + Math.random() * 0.75;
          this.compose(tmp, kept++, px + (Math.random() - 0.5) * cell * 0.8, y, pz + (Math.random() - 0.5) * cell * 0.8, s2 * W, s2, s2);
        }
      }
    }
    return this.finish(tmp, kept);
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
      for (const [, p] of l.patches) { if (p) { l.manager.removePatch(p); p.dispose(); } }
      l.patches.clear();
    }
    if (this.enabled) { this.ensurePatches(); }
  }

  /** Apply a quality tier's radius/density/enabled flags + the matching fade band (no rebuild). */
  private applyQualityParams(q: number): void {
    const t = ScatterService.QUALITY[Math.max(0, Math.min(4, q))];
    this.enabled = t.enabled;
    this.densityMul = t.density;
    this.RADIUS = Math.max(1, t.radius);
    GrassFadePlugin.fade.end   = (this.RADIUS - 0.4) * this.PATCH;
    GrassFadePlugin.fade.start = Math.max(20, GrassFadePlugin.fade.end - 110);
  }

  /** Build one patch's beach rocks: scattered on the sand/low-dune band, mostly small with some
   *  bigger ones and the rare boulder, each a random size, tumble orientation and stone colour. */
  private buildRocks(cx: number, cz: number): PatchData {
    const res = 24, size = this.PATCH, cell = size / res, E = 2.0;
    const matTmp = new Float32Array(res * res * 16);
    const colTmp = new Float32Array(res * res * 4);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const scaleV = this._scaleV, posV = this._posV;
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        const px = cx + (x + Math.random()) * cell - size / 2;
        const pz = cz + (z + Math.random()) * cell - size / 2;
        const y = getY(px, pz);
        if (y < 0.25 || y > 7) { continue; }              // beach + low dune band only
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.85) { continue; }

        // Scattered, with subtle clusters (rocks gather a little, slightly sparser between).
        const clump = fbm2(px / 15, pz / 15);
        const dens = (0.022 + 0.24 * smoothstep(0.52, 0.84, clump)) * (1 - slope * 0.4) * this.densityMul;
        if (Math.random() > dens) { continue; }

        // Size mix: mostly small, some bigger, the occasional boulder.
        const r = Math.random();
        const base = r < 0.05 ? 1.8 + Math.random() * 1.7         // ~5% boulders (1.8–3.5 m)
          : r < 0.30 ? 0.7 + Math.random() * 0.7                  // ~25% bigger (0.7–1.4 m)
          : 0.25 + Math.random() * 0.4;                           // small (0.25–0.65 m)
        scaleV.set(base * (0.85 + Math.random() * 0.35), base * (0.6 + Math.random() * 0.4), base * (0.85 + Math.random() * 0.35));
        posV.set(px, y - base * 0.1, pz);                  // settle slightly into the sand
        const q = Quaternion.RotationYawPitchRoll(
          Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5);
        Matrix.Compose(scaleV, q, posV).copyToArray(matTmp, kept * 16);

        // Per-instance stone colour: pick a palette entry, jitter each channel.
        const c = STONE[(Math.random() * STONE.length) | 0];
        const ci = kept * 4;
        colTmp[ci]     = Math.max(0, c[0] + (Math.random() - 0.5) * 0.10);
        colTmp[ci + 1] = Math.max(0, c[1] + (Math.random() - 0.5) * 0.10);
        colTmp[ci + 2] = Math.max(0, c[2] + (Math.random() - 0.5) * 0.10);
        colTmp[ci + 3] = 1;
        kept++;
      }
    }
    return this.finish(matTmp, kept, colTmp);
  }

  /** Build one patch's driftwood: weathered logs lying flat near the tide line — occasional, varied
   *  length/thickness, random yaw with a slight settle, bleached wood colours. */
  private buildDriftwood(cx: number, cz: number): PatchData {
    const res = 20, size = this.PATCH, cell = size / res, E = 2.0;
    const matTmp = new Float32Array(res * res * 16);
    const colTmp = new Float32Array(res * res * 4);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const scaleV = this._scaleV, posV = this._posV;
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        const px = cx + (x + Math.random()) * cell - size / 2;
        const pz = cz + (z + Math.random()) * cell - size / 2;
        const y = getY(px, pz);
        if (y < 0.25 || y > 6) { continue; }              // sand / low beach band
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.75) { continue; }

        // Occasional, with subtle clusters along the drift line.
        const clump = fbm2(px / 14 + 40, pz / 14 - 22);
        const dens = (0.022 + 0.20 * smoothstep(0.52, 0.84, clump)) * (1 - slope * 0.4) * this.densityMul;
        if (Math.random() > dens) { continue; }

        // Length mix: mostly medium logs, some long, some short chunks. Thickness varies separately.
        const r = Math.random();
        const len = r < 0.15 ? 1.2 + Math.random() * 0.7      // ~15% long logs
          : r < 0.70 ? 0.6 + Math.random() * 0.5              // medium
          : 0.35 + Math.random() * 0.25;                      // short chunks
        const thick = 0.5 + Math.random() * 0.7;
        scaleV.set(len, thick, thick);                        // local X = length, Y/Z = thickness
        posV.set(px, y - 0.03, pz);                           // settle into the sand
        const q = Quaternion.RotationYawPitchRoll(
          Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3);
        Matrix.Compose(scaleV, q, posV).copyToArray(matTmp, kept * 16);

        const c = DRIFTWOOD[(Math.random() * DRIFTWOOD.length) | 0];
        const ci = kept * 4;
        colTmp[ci]     = Math.max(0, c[0] + (Math.random() - 0.5) * 0.08);
        colTmp[ci + 1] = Math.max(0, c[1] + (Math.random() - 0.5) * 0.08);
        colTmp[ci + 2] = Math.max(0, c[2] + (Math.random() - 0.5) * 0.08);
        colTmp[ci + 3] = 1;
        kept++;
      }
    }
    return this.finish(matTmp, kept, colTmp);
  }

  /** Build one patch's forest trees: clustered in the inland forest-mask zone (mid elevation, gentle
   *  slope), broken into stands by low-freq noise with clearings. Sparse — trees are big. */
  private buildTrees(cx: number, cz: number): PatchData {
    const res = 16, size = this.PATCH, cell = size / res, E = 3.0;
    const tmp = new Float32Array(res * res * 16);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const scaleV = this._scaleV, posV = this._posV, up = this._up;
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        const px = cx + (x + Math.random()) * cell - size / 2;
        const pz = cz + (z + Math.random()) * cell - size / 2;
        const y = getY(px, pz);
        if (y < 7 || y > 80) { continue; }                 // inland band, below the rocky uplands
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.5) { continue; }                     // trees on gentle ground only

        // Big forest stands (low-freq) with clearings inside (mid-freq) → grouped woods, open gaps.
        const stand = fbm2(px / 45, pz / 45);
        const clearing = fbm2(px / 13 + 9, pz / 13 - 4);
        const dens = smoothstep(0.46, 0.72, stand) * smoothstep(0.4, 0.62, clearing)
          * (1 - slope * 0.8) * 0.6 * this.densityMul;
        if (Math.random() > dens) { continue; }

        const s = 0.8 + Math.random() * 0.6;               // ~4–7 m trees
        const w = s * (0.85 + Math.random() * 0.3);
        scaleV.set(w, s, w);
        posV.set(px, y - 0.1, pz);
        Matrix.Compose(scaleV, Quaternion.RotationAxis(up, Math.random() * Math.PI * 2), posV)
          .copyToArray(tmp, kept * 16);
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
  private buildPalms(cx: number, cz: number, variant: number): PatchData {
    const res = 14, size = this.PATCH, cell = size / res, E = 2.5;
    const tmp = new Float32Array(res * res * 16);
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    const scaleV = this._scaleV, posV = this._posV, up = this._up;
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        const px = cx + (x + hash2(cx + x * 12.9, cz + z * 78.2)) * cell - size / 2;
        const pz = cz + (z + hash2(cx + x * 39.3 + 7.1, cz + z * 11.7 - 3.3)) * cell - size / 2;
        const y = getY(px, pz);
        if (y < 0.5 || y > 8) { continue; }                // sand + low coastal band
        const slope = this.slopeAt(px, pz, y, E);
        if (slope > 0.5) { continue; }

        // Groves: a high, sharp threshold on a low-freq field → rare clustered stands, open between.
        const stand = fbm2(px / 28 + 60, pz / 28 - 40);
        const dens = smoothstep(0.58, 0.84, stand) * (1 - slope * 0.6) * 0.4 * this.densityMul;
        if (hash2(px * 3.1 + 1.7, pz * 2.9 - 3.3) > dens) { continue; }

        // Deal each accepted candidate to exactly one variant (so the 3 sub-layers don't stack).
        if (variant >= 0 && Math.floor(hash2(px * 0.71 + 50, pz * 0.67 - 50) * 3) !== variant) { continue; }

        const s = 0.92 + hash2(px * 5.3 - 2.0, pz * 4.7 + 8.0) * 0.16;   // ~±8 % (world-correct height)
        scaleV.set(s, s, s);
        posV.set(px, y - 0.1, pz);
        Matrix.Compose(scaleV, Quaternion.RotationAxis(up, hash2(px * 1.13 + 7, pz * 1.07 - 7) * Math.PI * 2), posV)
          .copyToArray(tmp, kept * 16);
        kept++;
      }
    }
    return this.finish(tmp, kept);
  }

  dispose(): void {
    if (this.observer) { this.sceneService.scene?.onBeforeRenderObservable.remove(this.observer); this.observer = null; }
    for (const l of this.layers) {
      for (const [, p] of l.patches) { p?.dispose(); }
      l.patches.clear();
      l.manager.dispose();
      l.mat.dispose();
    }
    this.layers = [];
  }
}
