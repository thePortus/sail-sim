import { Injectable, inject } from '@angular/core';
import {
  Color3, Matrix, Observer, Quaternion, Scene, StandardMaterial, Vector3,
} from '@babylonjs/core';
import { SceneService } from '../scene.service';
import { TerrainService } from '../terrain.service';
import { WeatherService } from '../weather.service';
import { ThinInstancePatch } from './instancing/thin-instance-patch';
import { PatchManager } from './instancing/patch-manager';
import { createGrassBlade } from './grass/grass-blade';
import { GrassFadePlugin } from './grass/grass-fade.plugin';

const EMPTY = new Float32Array(0);
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function hash2(x: number, z: number): number {
  return ((Math.sin(x * 127.1 + z * 311.7) * 43758.5453) % 1 + 1) % 1;
}
/** Smooth value noise in [0,1] — spatially coherent, so grass forms real clumps (not random dots). */
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

/**
 * Per-biome asset scattering (grass for now; trees/butterflies later) using thin instances + LoD
 * patches that follow the camera. Instancing technique ported from Barthélemy Paléologue's
 * "AssetScattering" (MIT). Grass uses a StandardMaterial (thin instances + scene lighting/fog work
 * natively on our WebGPU engine, unlike a custom ShaderMaterial); wind sway is added later via a
 * material plugin.
 */
@Injectable({ providedIn: 'root' })
export class ScatterService {
  private sceneService   = inject(SceneService);
  private terrainService = inject(TerrainService);
  private weatherService = inject(WeatherService);

  private grassMat: StandardMaterial | null = null;
  private grassManager: PatchManager | null = null;
  private readonly patches = new Map<string, ThinInstancePatch | null>();
  private observer: Observer<Scene> | null = null;

  // ── Tuning ──────────────────────────────────────────────────────────────────
  private readonly PATCH = 40;          // metres per patch
  private readonly RADIUS = 9;          // patch rings → ~360 m of grass; outer edge dissolved by GrassFadePlugin
  private readonly RES = 72;            // candidate blades per patch edge (~0.55 m → dense clumps)
  private readonly HIGH_LOD_DIST = 110; // within → detailed 4-stack blade, beyond → flat 1-stack
  private readonly MAX_BUILDS_PER_FRAME = 4;  // fill faster while staying smooth

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    const cam = this.sceneService.camera;
    if (!scene || !cam) { return; }

    const mat = new StandardMaterial('scatterGrass', scene);
    mat.diffuseColor = new Color3(0.10, 0.26, 0.05);   // grass green
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;                        // blades are thin double-sided quads
    mat.twoSidedLighting = true;
    this.grassMat = mat;

    // Dissolve blades toward the draw radius so the patch grid doesn't end in a hard line. Fade
    // band sits just inside the built edge (≈ RADIUS·PATCH) so grass is fully gone before the cut.
    new GrassFadePlugin(mat);
    GrassFadePlugin.fade.end   = (this.RADIUS - 0.4) * this.PATCH;   // ~344 m
    GrassFadePlugin.fade.start = GrassFadePlugin.fade.end - 110;     // ~234 m → 110 m dissolve band

    const high = createGrassBlade(scene, 4); high.isVisible = false; high.material = mat;
    const low  = createGrassBlade(scene, 1); low.isVisible  = false; low.material  = mat;
    this.sceneService.excludeFromGlow(high);
    this.sceneService.excludeFromGlow(low);

    this.grassManager = new PatchManager([low, high], (patch) => {
      const c = this.sceneService.camera;
      return c && Vector3.Distance(patch.getPosition(), c.position) < this.HIGH_LOD_DIST ? 1 : 0;
    });
    this.grassManager.setLodUpdateCadence(this.MAX_BUILDS_PER_FRAME);

    this.ensurePatches();
    this.grassManager.initInstances();

    this.observer = scene.onBeforeRenderObservable.add(() => {
      const c = this.sceneService.camera;
      if (c) { GrassFadePlugin.camera.x = c.position.x; GrassFadePlugin.camera.z = c.position.z; }
      this.updateWind(scene.getEngine().getDeltaTime() / 1000);
      this.ensurePatches();
      this.grassManager?.update();
    });
  }

  private ensurePatches(): void {
    const cam = this.sceneService.camera;
    if (!cam || !this.grassManager) { return; }
    const cx = Math.round(cam.position.x / this.PATCH);
    const cz = Math.round(cam.position.z / this.PATCH);
    const R = this.RADIUS;

    let built = 0;
    for (let ix = cx - R; ix <= cx + R && built < this.MAX_BUILDS_PER_FRAME; ix++) {
      for (let iz = cz - R; iz <= cz + R && built < this.MAX_BUILDS_PER_FRAME; iz++) {
        const key = ix + ',' + iz;
        if (this.patches.has(key)) { continue; }
        const buf = this.buildPatch(ix * this.PATCH, iz * this.PATCH);
        built++;
        if (buf.length === 0) { this.patches.set(key, null); continue; }
        const p = new ThinInstancePatch(new Vector3(ix * this.PATCH, 0, iz * this.PATCH), buf);
        this.grassManager.addPatch(p);
        this.patches.set(key, p);
      }
    }

    const cull = R + 1;
    for (const [key, p] of this.patches) {
      const c = key.split(',');
      if (Math.abs(+c[0] - cx) > cull || Math.abs(+c[1] - cz) > cull) {
        if (p) { this.grassManager.removePatch(p); p.dispose(); }
        this.patches.delete(key);
      }
    }
  }

  /** Build one patch's grass: terrain-snapped, biome-gated (sparse on beaches, lush lowland, none on
   *  cliffs/peaks/underwater), broken into clumps by low-freq noise. */
  private buildPatch(cx: number, cz: number): Float32Array {
    const res = this.RES, size = this.PATCH, cell = size / res, E = 2.0;
    const tmp = new Float32Array(res * res * 2 * 16);   // ×2: clump cores can place a second blade
    const scaleV = new Vector3(), posV = new Vector3();
    const up = Vector3.UpReadOnly;
    const getY = (x: number, z: number) => this.terrainService.getElevation(x, z);
    let kept = 0;

    for (let x = 0; x < res; x++) {
      for (let z = 0; z < res; z++) {
        const px = cx + (x + Math.random()) * cell - size / 2;
        const pz = cz + (z + Math.random()) * cell - size / 2;
        const y = getY(px, pz);
        if (y < 0.6) { continue; }

        const dyx = getY(px + E, pz) - getY(px - E, pz);
        const dyz = getY(px, pz + E) - getY(px, pz - E);
        const slope = Math.sqrt(dyx * dyx + dyz * dyz) / (2 * E);
        if (slope > 0.7) { continue; }

        // Multi-octave clump field — small base scale → small clumps, with finer sub-detail.
        const clump = fbm2(px / 13, pz / 13);
        // Fill grows with distance from the water (elevation proxy): sparse right at the shore, then
        // a long, gentle ramp so it gets fuller as you head inland — reaching lush only well in, so
        // it never turns jungly near the beach. (Was 6→18; widened + pulled toward the waterline.)
        const lowland = smoothstep(1.5, 13, y);            // 0 at the shore → 1 on the true lowland
        const alt = 1 - smoothstep(90, 140, y);            // fade out toward the rocky uplands
        const slopeFac = 1 - slope * 0.7;
        // Clump shape (shared by beach & inland): a WIDE ramp so the clump's density runs off
        // smoothly at its edges (no hard rim), plus a core boost so the very centre is packed.
        // Higher tuft threshold → fewer clumps (rarer patches on this low beach).
        const tuft = smoothstep(0.62, 0.88, clump);        // 0 at the edge → 1 toward the core (faded runoff)
        const coreF = smoothstep(0.80, 0.96, clump);       // only the very centre of a clump
        const clumpD = tuft * (0.9 + 0.7 * coreF);         // ramps 0 → ~1.6 (≥1 = fully packed core)
        // Beach (lowland→0): bare sand with only the rarest stray blade between clumps.
        // Inland lowland (→1): lush everywhere, clumps add extra body.
        const beachD = Math.max(clumpD, 0.008);
        const lushD = Math.max(0.78, clumpD);
        const density = (beachD + (lushD - beachD) * lowland) * alt * slopeFac;
        if (Math.random() > density) { continue; }

        const s = 0.9 + Math.random() * 0.8;   // ~0.9–1.7 m
        scaleV.set(s, s, s);
        posV.set(px, y, pz);
        Matrix.Compose(scaleV, Quaternion.RotationAxis(up, Math.random() * Math.PI * 2), posV)
          .copyToArray(tmp, kept * 16);
        kept++;

        // Denser core: drop a second blade right beside this one in the heart of a clump.
        if (coreF > 0.35 && Math.random() < coreF * 0.85) {
          const s2 = 0.8 + Math.random() * 0.7;
          scaleV.set(s2, s2, s2);
          posV.set(px + (Math.random() - 0.5) * cell * 0.8, y, pz + (Math.random() - 0.5) * cell * 0.8);
          Matrix.Compose(scaleV, Quaternion.RotationAxis(up, Math.random() * Math.PI * 2), posV)
            .copyToArray(tmp, kept * 16);
          kept++;
        }
      }
    }
    return kept ? tmp.slice(0, kept * 16) : EMPTY;
  }

  /** Feed the live weather wind to the grass sway plugin (unit direction + height-scaled amplitude). */
  private updateWind(dt: number): void {
    const w = this.weatherService.weather();
    const wind = GrassFadePlugin.wind;
    wind.time += dt;
    if (w) {
      const len = Math.hypot(w.wind.x, w.wind.z) || 1;
      wind.dirX = w.wind.x / len;
      wind.dirZ = w.wind.z / len;
      // Gentle idle sway in calm air → firmer lean as it builds (sway amplitude in metres at the tip).
      wind.strength = 0.04 + Math.min(0.16, w.wind.speed / 70);
    }
  }

  dispose(): void {
    if (this.observer) { this.sceneService.scene?.onBeforeRenderObservable.remove(this.observer); this.observer = null; }
    for (const [, p] of this.patches) { p?.dispose(); }
    this.patches.clear();
    this.grassManager?.dispose();
    this.grassManager = null;
    this.grassMat?.dispose();
    this.grassMat = null;
  }
}
