import { Injectable, inject } from '@angular/core';
import { Color3, Material, Matrix, Mesh, Observer, Quaternion, Scene, StandardMaterial, Texture, Vector3 } from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { SceneService } from './scene.service';
import { VesselService } from './vessel.service';
import { TerrainService } from './terrain.service';
import { loadScatterGeometry, scatterTextureUrl } from './scatter/asset-loader';

/**
 * Underwater seaweed — murky kelp clumps seen ONLY through the shallow water (and only up close). Like
 * the dolphins, the meshes are named off the `scatter_` prefix so they render into the ocean's seabed
 * refraction RTT (which the water shader reveals only where it's shallow), so the weed shows through clear
 * shallow water and vanishes in deep water. Rooted and STATIC (no per-frame work): instances are written
 * once when a clump spawns and only rebuilt when the clump set changes. We render the LOW-DETAIL LOD
 * meshes exclusively and cull to a short radius — super cheap.
 *
 * Distribution: clumps appear in BUNCHES (a coarse noise gate), with bare stretches between, only over the
 * shallows, on the seabed, near the boat. As the boat moves, far clumps recycle and new ones seed ahead.
 * `?noseaweed` disables it.
 */

interface Weed { x: number; z: number; y: number; rotY: number; scale: number; variant: number; tint: Color3; }
interface Clump { cx: number; cz: number; weeds: Weed[]; }

@Injectable({ providedIn: 'root' })
export class SeaweedService {
  private sceneService  = inject(SceneService);
  private vesselService = inject(VesselService);
  private terrain       = inject(TerrainService);

  private meshes: (Mesh | null)[] = [];   // one LOD mesh per variant (a/b/c)
  private material: StandardMaterial | null = null;
  private observer: Observer<Scene> | null = null;
  private matBufs: Float32Array[] = [];
  private colBufs: Float32Array[] = [];

  private clumps: Clump[] = [];
  private _acc = 0;                         // throttle (re-evaluate clumps ~3×/s)
  private _dirty = false;

  private static readonly VARIANTS = ['seaweed_a_lod.glb', 'seaweed_b_lod.glb', 'seaweed_c_lod.glb'];
  private static readonly CAP = 384;        // thin-instance buffer cap per variant
  private static readonly TINTS: readonly Color3[] = [
    new Color3(0.62, 0.74, 0.42),   // olive
    new Color3(0.50, 0.62, 0.34),   // darker green
    new Color3(0.70, 0.58, 0.34),   // brown kelp
    new Color3(0.44, 0.58, 0.44),   // muted green
  ];

  // Shallows window (water depth, m), leash near the boat, and the clump shape.
  private static readonly DEPTH_MIN = 2.5;
  private static readonly DEPTH_MAX = 18;
  private static readonly CULL = 100;       // draw distance (~100 m)
  private static readonly SPAWN_MIN = 8;
  private static readonly SPAWN_MAX = 88;
  private static readonly MAX_CLUMPS = 16;

  private readonly _scl = new Vector3();
  private readonly _pos = new Vector3();
  private readonly _q = new Quaternion();
  private readonly _mat = new Matrix();

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene || this.material) { return; }

    // Matte, double-sided, opaque, FROZEN (static) — and NOT named scatter_ so it enters the refraction RTT.
    const mat = new StandardMaterial('seaweed_mat', scene);
    mat.diffuseTexture = new Texture(scatterTextureUrl('seaweed_albedo.png'), scene);
    mat.specularColor = new Color3(0.05, 0.06, 0.06);
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    this.sceneService.excludeFromPrePass(mat);
    this.material = mat;

    for (let v = 0; v < SeaweedService.VARIANTS.length; v++) {
      const mesh = await loadScatterGeometry(scene, SeaweedService.VARIANTS[v], `seaweedClump_${v}`, mat, false);
      if (!mesh) { console.warn(`[seaweed] ${SeaweedService.VARIANTS[v]} failed`); return; }
      this.sceneService.excludeFromGlow(mesh);
      mesh.isVisible = true;
      mesh.alwaysSelectAsActiveMesh = true;
      this.matBufs[v] = new Float32Array(SeaweedService.CAP * 16);
      this.colBufs[v] = new Float32Array(SeaweedService.CAP * 4);
      mesh.thinInstanceSetBuffer('matrix', this.matBufs[v], 16, false);
      mesh.thinInstanceSetBuffer('color', this.colBufs[v], 4, false);
      mesh.thinInstanceCount = 0;
      this.meshes[v] = mesh;
    }
    mat.freeze();   // static material → no per-frame readiness checks

    this.observer = scene.onBeforeRenderObservable.add(() => {
      this._acc += Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
      if (this._acc < 0.33) { return; }   // re-evaluate clumps ~3×/s; otherwise do nothing
      this._acc = 0;
      this.update();
    });
  }

  /** Cheap value noise in [0,1] for the "bunches, then bare" clump distribution. */
  private noise(x: number, z: number): number {
    const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  private update(): void {
    if (!this.meshes.length) { return; }
    const vs = this.vesselService.state();
    if (!vs) { return; }
    const bx = vs.x, bz = vs.z;

    // Leaving the shallows → clear everything.
    const overShallows = (() => {
      const d = -this.terrain.getElevation(bx, bz);
      return d >= SeaweedService.DEPTH_MIN - 1 && d <= SeaweedService.DEPTH_MAX + 4;
    })();
    if (!overShallows) {
      if (this.clumps.length) { this.clumps = []; this._dirty = true; }
    } else {
      // Recycle clumps that have fallen out of range.
      for (let i = this.clumps.length - 1; i >= 0; i--) {
        const c = this.clumps[i];
        if (Math.hypot(c.cx - bx, c.cz - bz) > SeaweedService.CULL) { this.clumps.splice(i, 1); this._dirty = true; }
      }
      // Seed new clumps (a couple per tick) in shallow, seabed spots — gated by a coarse noise so weed grows
      // in bunches with bare gaps between. A couple per tick keeps the wider draw radius populated while sailing.
      for (let s = 0; s < 2 && this.clumps.length < SeaweedService.MAX_CLUMPS; s++) {
        const spot = this.findClumpSpot(bx, bz);
        if (spot) { this.clumps.push(this.makeClump(spot.x, spot.z, spot.seabed)); this._dirty = true; }
      }
    }

    if (this._dirty) { this.rebuild(); this._dirty = false; }
  }

  /** A spot near the boat that's underwater, in the shallows, on the seabed, and inside a "weed patch". */
  private findClumpSpot(bx: number, bz: number): { x: number; z: number; seabed: number } | null {
    for (let t = 0; t < 6; t++) {
      const ang = Math.random() * Math.PI * 2;
      const r = SeaweedService.SPAWN_MIN + Math.random() * (SeaweedService.SPAWN_MAX - SeaweedService.SPAWN_MIN);
      const x = bx + Math.cos(ang) * r, z = bz + Math.sin(ang) * r;
      const seabed = this.terrain.getElevation(x, z);
      const depth = -seabed;
      if (depth < SeaweedService.DEPTH_MIN || depth > SeaweedService.DEPTH_MAX) { continue; }
      // Bunch gate: only ~half the coarse cells grow weed → patches with bare stretches between.
      if (this.noise(Math.floor(x / 26), Math.floor(z / 26)) < 0.55) { continue; }
      // Don't crowd an existing clump.
      let near = false;
      for (const c of this.clumps) { if (Math.hypot(c.cx - x, c.cz - z) < 6) { near = true; break; } }
      if (near) { continue; }
      return { x, z, seabed };
    }
    return null;
  }

  /** A tight bunch of weed rooted on the seabed around (cx,cz). */
  private makeClump(cx: number, cz: number, seabed: number): Clump {
    const n = 8 + Math.floor(Math.random() * 11);     // 8–18 weeds
    const radius = 1.1 + Math.random() * 1.3;          // tighter bunch (1.1–2.4 m)
    const weeds: Weed[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * radius;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      weeds.push({
        x, z,
        y: this.terrain.getElevation(x, z),            // holdfast on the seabed
        rotY: Math.random() * Math.PI * 2,
        scale: 0.6 + Math.random() * 0.7,
        variant: Math.floor(Math.random() * SeaweedService.VARIANTS.length),
        tint: SeaweedService.TINTS[Math.floor(Math.random() * SeaweedService.TINTS.length)],
      });
    }
    return { cx, cz, weeds };
  }

  /** Rebuild the per-variant thin-instance buffers from the live clumps (only on change). */
  private rebuild(): void {
    const counts = [0, 0, 0];
    for (const c of this.clumps) {
      for (const w of c.weeds) {
        const v = w.variant;
        const n = counts[v];
        if (n >= SeaweedService.CAP) { continue; }
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
    this.meshes = []; this.material = null; this.matBufs = []; this.colBufs = []; this.clumps = [];
  }
}
