import { Injectable, inject, signal } from '@angular/core';
import { TransformNode, Vector3, Mesh, Material, Scene, PBRMaterial, Color3, PointLight, Observer } from '@babylonjs/core';
import { SceneService } from './scene.service';
import { TerrainService } from './terrain.service';
import { OceanService } from './ocean.service';
import { VesselService } from './vessel.service';
import { VesselAssetCacheService } from './vessel-asset-cache.service';
import { TerrainHarbor } from '../models';

/**
 * Renders the harbor towns detected during terrain generation (manifest.harbors). For now a town =
 * one pier; the structure leaves room to place additional per-town geometry near the pier later.
 *
 * Each pier GLB variant (straight/l/t) is loaded ONCE (shared via the vessel asset cache's container
 * cache — instances share geometry + materials, so 50 piers are cheap) and instantiated per town,
 * dropped at the shore point (origin at the waterline, y=0) and rotated so its body extends SEAWARD
 * along the harbor heading. Piers are static: registered for ocean reflection + sun shadows, then
 * world-matrix + material frozen. Per the pier handoff the origin is the shore-centre at y=0.
 */
@Injectable({ providedIn: 'root' })
export class HarborService {
  private sceneService = inject(SceneService);
  private terrainService = inject(TerrainService);
  private oceanService = inject(OceanService);
  private vesselService = inject(VesselService);
  private assetCache = inject(VesselAssetCacheService);

  private root: TransformNode | null = null;
  // Per-variant yaw (radians) that rotates the model's seaward length-axis onto the parent's +Z, so
  // setting parent.rotation.y = heading then points the pier body seaward. Computed once per variant.
  private readonly seawardOffset = new Map<string, number>();
  private readonly frozenMats = new Set<Material>();

  // One warm "pool" light that follows the nearest pier — it actually illuminates the deck + the
  // player's hull when docking at night (the 50 lanterns are emissive-only). A single always-on,
  // range-limited light keeps us under the per-mesh light cap (sun+moon+ambient+this = 4).
  private pierLight: PointLight | null = null;
  private harbors: TerrainHarbor[] = [];
  private tickObs: Observer<Scene> | null = null;
  // Dock when the hull is within ~10 ft (≈3 m) of the pier DECK EDGE (not the shore point — the pier
  // blocks the centre from ever reaching the shore). Per-variant deck size (m): len = along-seaward
  // from the shore point, halfWidth = half the across-extent (matches the server pier-obstacles dims).
  private readonly DOCK_EDGE_M = 3;
  private readonly PIER_DIMS: Record<string, { len: number; halfWidth: number }> = {
    straight: { len: 14.3, halfWidth: 1.6 },
    l:        { len: 11.0, halfWidth: 6.5 },
    t:        { len: 11.0, halfWidth: 6.5 },
  };

  /** The town the player is currently close enough to dock at, or null. Read by the HUD/game UI. */
  readonly dockable = signal<TerrainHarbor | null>(null);

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    this.harbors = this.terrainService.getHarbors();
    if (!scene || !this.harbors.length) return;
    this.root = new TransformNode('harbors_root', scene);

    this.pierLight = new PointLight('pierLight', new Vector3(0, 6, 0), scene);
    this.pierLight.diffuse = new Color3(1.0, 0.72, 0.42);   // warm lantern light
    this.pierLight.specular = new Color3(0.6, 0.45, 0.25);
    // STANDARD falloff = intensity as a plain multiplier with a range cutoff (PBR's default physical
    // inverse-square makes a small intensity vanish at pier scale). Intensity is driven per-frame by
    // the night factor below — bright after dark, off in daylight (where the sun would wash it out).
    this.pierLight.falloffType = PointLight.FALLOFF_STANDARD;
    this.pierLight.range = 60;
    this.pierLight.intensity = 0;
    this.tickObs = scene.onBeforeRenderObservable.add(() => this.updateNearestPier());
    console.log(`[Harbor] ${this.harbors.length} piers; pool light created`);

    // Build sequentially: the 3 variant GLBs each parse once (cache), then instantiate cheaply.
    for (const h of this.harbors) {
      await this.buildPier(scene, h);
    }
  }

  /** Each frame: park the pool light at the nearest pier and update the dockable town. */
  private updateNearestPier(): void {
    const p = this.vesselService.getPosition();
    let best: TerrainHarbor | null = null, bestD = Infinity;
    for (const h of this.harbors) {
      const d = (h.x - p.x) ** 2 + (h.z - p.z) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    if (!best) return;
    const hr = (best.heading * Math.PI) / 180;
    const fx = Math.sin(hr), fz = Math.cos(hr);
    if (this.pierLight) {
      this.pierLight.position.set(best.x + fx * 5, 6, best.z + fz * 5);
      // Bright after dark, off in daylight (full night 19:00–05:00, fading across dusk/dawn).
      const t = this.sceneService.gameTime();
      let nf = 0;
      if (t < 5 || t >= 19) nf = 1;
      else if (t < 7) nf = (7 - t) / 2;
      else if (t > 17) nf = (t - 17) / 2;
      this.pierLight.intensity = 7 * Math.max(0, Math.min(1, nf));
    }

    // Distance from the hull to the pier deck edge: nearest point on the pier centreline segment
    // (shore → seaward end), minus the deck half-width.
    const dim = this.PIER_DIMS[best.variant] ?? this.PIER_DIMS['straight'];
    const segD = this.distToSegment(p.x, p.z, best.x, best.z, best.x + fx * dim.len, best.z + fz * dim.len);
    const inRange = Math.max(0, segD - dim.halfWidth) <= this.DOCK_EDGE_M;

    const cur = this.dockable();
    if (inRange) { if (!cur || cur.id !== best.id) this.dockable.set(best); }
    else if (cur) { this.dockable.set(null); }
  }

  /** Shortest distance from point P to segment [A,B] in the XZ plane. */
  private distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  }

  private async buildPier(scene: Scene, h: TerrainHarbor): Promise<void> {
    const parent = new TransformNode(`harbor_${h.id}`, scene);
    parent.parent = this.root;

    // flipY=false: piers are authored +up, no 180° hull flip. The cache shares geometry+materials.
    const pier = await this.assetCache.instantiate(`harbors/pier_${h.variant}.glb`, scene, parent, false);
    if (!pier) { console.warn(`[Harbor] pier GLB failed to load: pier_${h.variant}.glb`); parent.dispose(); return; }

    // Determine (once per variant) the base yaw that aligns the model's seaward axis to +Z. Must be
    // measured while the parent is still at identity (so child world AABB == model space).
    let off = this.seawardOffset.get(h.variant);
    if (off === undefined) { off = this.computeSeawardOffset(pier); this.seawardOffset.set(h.variant, off); }
    pier.rotation.y = off;

    // Place at the shore point, waterline at y=0, body extending along the seaward heading.
    parent.position.set(h.x, 0, h.z);
    parent.rotation.y = (h.heading * Math.PI) / 180;

    // Static registration. The pier's full PBR (albedo+MR+normal, + emissive lantern) is heavy on
    // WebGPU's hard 16 inter-stage-variable cap. Like the vessel (VesselService.registerMeshesForRendering),
    // cast shadows (depth-only, cheap) but DON'T receive them, drop fog, and exclude from the SSAO/DoF
    // prePass — receiving shadows + the prePass G-buffer variant blow the budget and invalidate the
    // prePass + ocean-reflection render pipelines. Reflection (clip-plane variant) still fits once those
    // are shed.
    const sg = this.sceneService.shadowGenerator;
    for (const m of pier.getChildMeshes(false)) {
      this.oceanService.addToRenderList(m);
      sg?.addShadowCaster(m as Mesh, true);
      m.receiveShadows = false;
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();

      // The lantern (the `*_glass` mesh) is the pier's night beacon. 50 real lights would blow the
      // per-mesh light cap + the WebGPU varying budget, so instead we make the lantern strongly
      // EMISSIVE (so its surface reads bright at night on its own) and add it to the glow layer for a
      // bloom halo. (The glow intensity is sun/moon-coupled and can fall to ~0 on a dark night, which
      // is why the emissive surface — not the halo — carries the visibility.)
      const isLantern = /glass/i.test(m.name);
      if (isLantern) this.sceneService.includeInGlow(m as Mesh);

      const mat = m.material;
      if (mat && !this.frozenMats.has(mat)) {
        this.frozenMats.add(mat);
        mat.fogEnabled = false;
        this.sceneService.excludeFromPrePass(mat);
        if (isLantern && mat instanceof PBRMaterial) {
          mat.emissiveColor = new Color3(1.0, 0.66, 0.30);   // warm lantern
          mat.emissiveIntensity = 8;                          // strong so it reads at night
        }
        // NOTE: we intentionally do NOT mat.freeze() here — a frozen material can skip per-frame light
        // binding, which would stop the moving pool light from re-lighting the deck. The static-mesh win
        // is freezeWorldMatrix() above; the per-material freeze is negligible and would break lighting.
      }
    }
  }

  /**
   * Find the yaw (radians) that maps the pier model's SEAWARD walkway axis onto the local +Z axis.
   * The origin is the shore (landward) END, so along the walkway the AABB centre sits a long way from
   * the origin (~half the length), while ACROSS the walkway the geometry is symmetric → centre ≈ 0.
   * So the axis with the larger |centre offset from the origin| is the seaward walkway axis, and the
   * sign of that centre is the seaward direction. This is robust even for the near-square L/T piers
   * (where the bigger AABB *extent* can be the crossbar, not the walkway) and to glTF→Babylon
   * handedness (handoff §4 — don't hard-code axis signs).
   */
  private computeSeawardOffset(pier: TransformNode): number {
    let min: Vector3 | null = null;
    let max: Vector3 | null = null;
    for (const m of pier.getChildMeshes(false)) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min = min ? Vector3.Minimize(min, bb.minimumWorld) : bb.minimumWorld.clone();
      max = max ? Vector3.Maximize(max, bb.maximumWorld) : bb.maximumWorld.clone();
    }
    if (!min || !max) return 0;
    const ctrX = (max.x + min.x) * 0.5, ctrZ = (max.z + min.z) * 0.5;
    if (Math.abs(ctrZ) >= Math.abs(ctrX)) {
      return ctrZ >= 0 ? 0 : Math.PI;                       // seaward +Z → 0 ; −Z → 180°
    }
    return ctrX >= 0 ? -Math.PI / 2 : Math.PI / 2;          // seaward +X → −90° ; −X → +90°
  }

  dispose(): void {
    // The scene teardown disposes these meshes; null our refs + clear caches so a fresh session
    // rebuilds piers (and re-measures the per-variant offsets) cleanly.
    if (this.tickObs) { this.sceneService.scene?.onBeforeRenderObservable.remove(this.tickObs); this.tickObs = null; }
    this.pierLight?.dispose();
    this.pierLight = null;
    this.root?.dispose(false, false);
    this.root = null;
    this.harbors = [];
    this.dockable.set(null);
    this.seawardOffset.clear();
    this.frozenMats.clear();
  }
}
