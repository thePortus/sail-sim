import { Injectable, inject } from '@angular/core';
import {
  Color3, Matrix, Observer, Quaternion, Scene, StandardMaterial, Vector3,
} from '@babylonjs/core';
import { SceneService } from '../scene.service';
import { TerrainService } from '../terrain.service';
import { ThinInstancePatch } from './instancing/thin-instance-patch';
import { PatchManager } from './instancing/patch-manager';
import { createGrassBlade } from './grass/grass-blade';

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

  private grassMat: StandardMaterial | null = null;
  private grassManager: PatchManager | null = null;
  private readonly patches = new Map<string, ThinInstancePatch | null>();
  private observer: Observer<Scene> | null = null;

  // ── Tuning ──────────────────────────────────────────────────────────────────
  private readonly PATCH = 40;          // metres per patch
  private readonly RADIUS = 8;          // patch rings → ~320 m of grass (≈2× the old draw distance)
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
    const tmp = new Float32Array(res * res * 16);
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

        // Spatially-coherent clump field — large scale so clumps are spaced far apart.
        const clump = vnoise(px / 22, pz / 22);
        const lowland = smoothstep(0.6, 9, y);             // 0 at the shore → 1 on the lowland
        const alt = 1 - smoothstep(90, 140, y);            // fade out toward the rocky uplands
        // Beach: rare but DENSE tufts — a high, sharp threshold means most of the sand stays bare,
        // and where a clump exists it's packed (~full density). Lowland: lush everywhere.
        const beachTuft = smoothstep(0.70, 0.80, clump);   // few clumps, ~100% fill inside them
        const lush = 0.70 + 0.30 * clump;
        const density = (beachTuft + (lush - beachTuft) * lowland) * alt * (1 - slope * 0.7);
        if (Math.random() > density) { continue; }

        const s = 0.9 + Math.random() * 0.8;   // ~0.9–1.7 m
        scaleV.set(s, s, s);
        posV.set(px, y, pz);
        Matrix.Compose(scaleV, Quaternion.RotationAxis(up, Math.random() * Math.PI * 2), posV)
          .copyToArray(tmp, kept * 16);
        kept++;
      }
    }
    return kept ? tmp.slice(0, kept * 16) : EMPTY;
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
