import { Injectable, inject } from '@angular/core';
import { Color3, Material, Matrix, Mesh, Observer, Quaternion, Scene, StandardMaterial, Texture, Vector3 } from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { SceneService } from './scene.service';
import { VesselService } from './vessel.service';
import { TerrainService } from './terrain.service';
import { loadScatterGeometry, scatterTextureUrl } from './scatter/asset-loader';

/**
 * Shoreline reeds — cattails / plume reeds / leafy reeds standing in the shallow water's edge, rooted
 * on the bottom with their tops peeking ABOVE the waterline. They grow only in a thin band at the
 * shoreline (seabed from just-emergent down to ~1.8 m deep), so a reed (~2–2.7 m tall) always pokes out.
 *
 * Like the seaweed, the meshes are named OFF the `scatter_` prefix so they also render into the ocean's
 * seabed refraction RTT — the submerged base reads murky through the shallow water, while the emergent
 * top draws normally in the main camera. Rooted and STATIC (no per-frame work): instances are written
 * once when a clump spawns and only rebuilt when the clump set changes. We render the LOW-DETAIL LOD
 * meshes exclusively and cull to the draw radius — cheap.
 *
 * Distribution: tight stands appear in BUNCHES (a coarse noise gate) along whatever shoreline is near
 * the boat, with bare stretches between. As the boat moves, far stands recycle and new ones seed ahead.
 * `?noreeds` disables it.
 */

interface Reed { x: number; z: number; y: number; rotY: number; scale: number; variant: number; tint: Color3; }
interface Stand { cx: number; cz: number; reeds: Reed[]; }

@Injectable({ providedIn: 'root' })
export class ReedService {
  private sceneService  = inject(SceneService);
  private vesselService = inject(VesselService);
  private terrain       = inject(TerrainService);

  private meshes: (Mesh | null)[] = [];   // one LOD mesh per variant (a/b/c)
  private material: StandardMaterial | null = null;
  private observer: Observer<Scene> | null = null;
  private matBufs: Float32Array[] = [];
  private colBufs: Float32Array[] = [];

  private stands: Stand[] = [];
  private _acc = 0;                         // throttle (re-evaluate stands ~3×/s)
  private _dirty = false;

  private static readonly VARIANTS = ['reed_a_lod.glb', 'reed_b_lod.glb', 'reed_c_lod.glb'];
  private static readonly CAP = 384;        // thin-instance buffer cap per variant
  private static readonly TINTS: readonly Color3[] = [
    new Color3(0.85, 1.00, 0.72),   // green
    new Color3(0.90, 0.95, 0.66),   // mid-green
    new Color3(0.95, 0.92, 0.55),   // yellow-green
    new Color3(1.00, 0.92, 0.60),   // tan
    new Color3(0.92, 0.90, 0.60),   // dry
  ];

  // Shoreline band (seabed elevation, m): from just-emergent (+0.3) down to ~1.8 m underwater, so a
  // ~2–2.7 m reed always peeks out. Plus the draw radius and stand shape.
  private static readonly ELEV_MAX = 0.3;   // a touch above the waterline (reeds on the bank edge)
  private static readonly ELEV_MIN = -1.8;  // deepest the base goes (top still pokes out)
  private static readonly CULL = 95;        // draw distance (~95 m)
  private static readonly SPAWN_MIN = 10;
  private static readonly SPAWN_MAX = 85;
  private static readonly MAX_STANDS = 14;

  private readonly _scl = new Vector3();
  private readonly _pos = new Vector3();
  private readonly _q = new Quaternion();
  private readonly _mat = new Matrix();

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene || this.material) { return; }

    // Matte, double-sided, opaque, FROZEN (static) — NOT named scatter_ so it enters the refraction RTT.
    // useVertexColors=false: the atlas COLOR_0 carries baked wind data, not albedo.
    const mat = new StandardMaterial('reedBed_mat', scene);
    mat.diffuseTexture = new Texture(scatterTextureUrl('reeds_atlas.png'), scene);
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    this.sceneService.excludeFromPrePass(mat);
    this.material = mat;

    for (let v = 0; v < ReedService.VARIANTS.length; v++) {
      const mesh = await loadScatterGeometry(scene, ReedService.VARIANTS[v], `reedBed_${v}`, mat, false);
      if (!mesh) { console.warn(`[reeds] ${ReedService.VARIANTS[v]} failed`); return; }
      this.sceneService.excludeFromGlow(mesh);
      mesh.isVisible = true;
      mesh.alwaysSelectAsActiveMesh = true;
      this.matBufs[v] = new Float32Array(ReedService.CAP * 16);
      this.colBufs[v] = new Float32Array(ReedService.CAP * 4);
      mesh.thinInstanceSetBuffer('matrix', this.matBufs[v], 16, false);
      mesh.thinInstanceSetBuffer('color', this.colBufs[v], 4, false);
      mesh.thinInstanceCount = 0;
      this.meshes[v] = mesh;
    }
    mat.freeze();   // static material → no per-frame readiness checks

    this.observer = scene.onBeforeRenderObservable.add(() => {
      this._acc += Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
      if (this._acc < 0.33) { return; }   // re-evaluate stands ~3×/s; otherwise do nothing
      this._acc = 0;
      this.update();
    });
  }

  /** Cheap value noise in [0,1] for the "bunches, then bare" stand distribution. */
  private noise(x: number, z: number): number {
    const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  private update(): void {
    if (!this.meshes.length) { return; }
    const vs = this.vesselService.state();
    if (!vs) { return; }
    const bx = vs.x, bz = vs.z;

    // Recycle stands that have fallen out of range.
    for (let i = this.stands.length - 1; i >= 0; i--) {
      const c = this.stands[i];
      if (Math.hypot(c.cx - bx, c.cz - bz) > ReedService.CULL) { this.stands.splice(i, 1); this._dirty = true; }
    }
    // Seed new stands (a couple per tick) on whatever shoreline band is near the boat — gated by a coarse
    // noise so reeds grow in bunches with bare stretches between. (No boat-depth gate: reeds line the
    // shore, which is usually some distance from the boat in open water.)
    for (let s = 0; s < 2 && this.stands.length < ReedService.MAX_STANDS; s++) {
      const spot = this.findStandSpot(bx, bz);
      if (spot) { this.stands.push(this.makeStand(spot.x, spot.z)); this._dirty = true; }
    }

    if (this._dirty) { this.rebuild(); this._dirty = false; }
  }

  /** A spot near the boat in the shoreline band (seabed elevation in [ELEV_MIN, ELEV_MAX]) and a "reed patch". */
  private findStandSpot(bx: number, bz: number): { x: number; z: number } | null {
    for (let t = 0; t < 8; t++) {
      const ang = Math.random() * Math.PI * 2;
      const r = ReedService.SPAWN_MIN + Math.random() * (ReedService.SPAWN_MAX - ReedService.SPAWN_MIN);
      const x = bx + Math.cos(ang) * r, z = bz + Math.sin(ang) * r;
      const elev = this.terrain.getElevation(x, z);
      if (elev < ReedService.ELEV_MIN || elev > ReedService.ELEV_MAX) { continue; }
      // Bunch gate: only ~half the coarse cells grow reeds → stands with bare stretches between.
      if (this.noise(Math.floor(x / 22), Math.floor(z / 22)) < 0.5) { continue; }
      // Don't crowd an existing stand.
      let near = false;
      for (const c of this.stands) { if (Math.hypot(c.cx - x, c.cz - z) < 6) { near = true; break; } }
      if (near) { continue; }
      return { x, z };
    }
    return null;
  }

  /** A tight stand of reeds rooted on the bottom around (cx,cz). */
  private makeStand(cx: number, cz: number): Stand {
    const n = 6 + Math.floor(Math.random() * 9);      // 6–14 reeds
    const radius = 1.2 + Math.random() * 1.6;          // tight stand (1.2–2.8 m)
    const reeds: Reed[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * radius;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      // Variant: mostly cheap leafy reeds (c), some cattails (a), few heavy plumes (b).
      const rv = Math.random();
      const variant = rv < 0.6 ? 2 : rv < 0.85 ? 0 : 1;
      reeds.push({
        x, z,
        y: this.terrain.getElevation(x, z),            // rooted on the bottom
        rotY: Math.random() * Math.PI * 2,
        scale: 0.85 + Math.random() * 0.5,
        variant,
        tint: ReedService.TINTS[Math.floor(Math.random() * ReedService.TINTS.length)],
      });
    }
    return { cx, cz, reeds };
  }

  /** Rebuild the per-variant thin-instance buffers from the live stands (only on change). */
  private rebuild(): void {
    const counts = [0, 0, 0];
    for (const c of this.stands) {
      for (const w of c.reeds) {
        const v = w.variant;
        const n = counts[v];
        if (n >= ReedService.CAP) { continue; }
        this._scl.set(w.scale, w.scale, w.scale);
        this._pos.set(w.x, w.y, w.z);
        Quaternion.RotationAxisToRef(Vector3.UpReadOnly, w.rotY, this._q);
        Matrix.ComposeToRef(this._scl, this._q, this._pos, this._mat);
        this._mat.copyToArray(this.matBufs[v], n * 16);
        const ci = n * 4, t = w.tint;
        this.colBufs[v][ci] = t.r; this.colBufs[v][ci + 1] = t.g; this.colBufs[v][ci + 2] = t.b; this.colBufs[v][ci + 3] = 1;
        counts[v] = n + 1;
      }
    }
    for (let v = 0; v < this.meshes.length; v++) {
      const mesh = this.meshes[v];
      if (!mesh) { continue; }
      mesh.thinInstanceCount = counts[v];
      if (counts[v] > 0) { mesh.thinInstanceBufferUpdated('matrix'); mesh.thinInstanceBufferUpdated('color'); }
    }
  }

  dispose(): void {
    const scene = this.sceneService.scene;
    if (this.observer && scene) { scene.onBeforeRenderObservable.remove(this.observer); }
    this.observer = null;
    for (const m of this.meshes) { m?.dispose(); }
    (this.material as Material | null)?.dispose();
    this.meshes = []; this.material = null; this.matBufs = []; this.colBufs = []; this.stands = [];
  }
}
