import { Injectable, inject, signal } from '@angular/core';
import { TransformNode, Vector3, Quaternion, Mesh, MeshBuilder, Matrix, Material, Scene, PBRMaterial, Color3, PointLight, Observer,
  StandardMaterial, DynamicTexture, VertexData, Texture } from '@babylonjs/core';
import { ShadowBlobPlugin } from './scatter/props/shadow-blob.plugin';
import { SceneService } from './scene.service';
import { TerrainService } from './terrain.service';
import { OceanService } from './ocean.service';
import { VesselService } from './vessel.service';
import { VesselAssetCacheService } from './vessel-asset-cache.service';
import { TownImpostorPlugin } from './scatter/town-impostor.plugin';
import { ImpostorHazePlugin } from './scatter/impostor-haze.plugin';
import { measureBottomPad } from './scatter/asset-loader';
import { Settings } from '../../app.settings';
import { TerrainHarbor } from '../models';
import { buildNameplate } from './nameplate';
import { factionColor, factionName } from '../faction.config';

// Settlement-type wording for the town-sign subtitle (the raw tier 'small' alone reads as "Spanish Small").
const TOWN_TIER_LABEL: Record<string, string> = { capital: 'Capital', medium: 'Town', small: 'Small Town' };

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

  // ONE shared warm light parked at the nearest town's civic square at night. Only ~1 town is streamed
  // at a time, so a single pooled light suffices, and it also reaches the waterfront/pier (the town
  // square sits just inland), so no separate dock light is needed. Enabled scene lights: 6 existing
  // (ambient+sun+moon+3 cannon-flash; the remote-rig lights are null) + this = 7 → prePass vertex UBO =
  // 3 base + 7 = 10, well under Metal's 12 maxUniformBuffersPerShaderStage cap. Keep ≤9 total (see
  // harbor_towns_v2_roadmap — the prePass G-buffer bakes LIGHTCOUNT = total enabled lights, ignoring
  // maxSimultaneousLights).
  private squareLight: PointLight | null = null;
  // The scoped sky-IBL reflection texture (procedural-sky LUT), fetched lazily on first building build.
  private skyEnv: Texture | null = null;
  private harbors: TerrainHarbor[] = [];
  private tickObs: Observer<Scene> | null = null;
  private frame = 0;

  // Town-building STREAMING: a town's buildings are instantiated only while the player is within
  // BUILD_RANGE and disposed once past DROP_RANGE (towns are ≥1.7 km apart, so ~0–1 are active → ~10
  // resident meshes instead of 360). townNodes = built town id → its root; townLoading guards in-flight
  // async builds against the per-frame scan re-triggering.
  private readonly townNodes = new Map<string, TransformNode>();
  private readonly townLoading = new Set<string>();
  // Cheap fake building shadows (scatter-style soft blob discs, thin-instanced under each building) — ONLY for the
  // nearest STREAMED town (real meshes, not the LOD impostor). Reuses the scatter ShadowBlobPlugin (sun-stretch
  // from the shared global) + a dark soft decal. No real shadow-map casting (that stays the local ship + piers).
  private _townShadowDisc: Mesh | null = null;
  private _townShadowMat: StandardMaterial | null = null;
  private _blobTownId: string | null = null;        // which streamed town currently owns the blobs
  // REAL building shadows (default): the CLOSEST streamed (mesh, not impostor) town casts into the sun's CSG — its
  // ground (square/roads) + the terrain RECEIVE, so the town throws directional shadows. To keep it CHEAP the caster
  // is NOT the real (high-poly, multi-submesh) buildings — that tanked FPS (each ×3 cascades) — but a single merged
  // BOX PROXY: one axis-aligned box per building (its bounding box), all in ONE ~80-vertex mesh = 1 caster, 1 draw
  // per cascade for the whole town. The proxy is invisible to the CAMERA via a layerMask outside the camera's mask
  // (the shadow map has an explicit renderList so it skips the layerMask check — verified in ObjectRenderer), yet
  // still casts. Just ONE town at a time. Opt-out `ignis_town_shadows='0'` → fall back to the fake blob discs.
  private readonly townRealShadows = (() => { try { return localStorage.getItem('ignis_town_shadows') !== '0'; } catch { return true; } })();
  private static readonly SHADOW_PROXY_MASK = 0x10000000;   // bit 28 — outside the default camera mask 0x0FFFFFFF
  // The real proxy shadow is discarded by the CSG past ~150 m (shadowMaxZ); beyond this the nearest town falls back
  // to the cheap fake blob discs so its shadows continue out to the full mesh range with NO scene-wide shadow cost.
  // Biased a little inside the ~150 m cull (camera-vs-ship slack) so the two overlap briefly rather than leaving a
  // gap where the shadow vanishes on the hand-off. Tunable.
  private static readonly SHADOW_FAR2 = 120 * 120;
  private _shadowTownId: string | null = null;       // which streamed town currently casts real shadows
  private _townShadowProxy: Mesh | null = null;      // its merged box-proxy caster (invisible; sun CSG only)
  private _townShadowProxyMat: StandardMaterial | null = null;   // shared opaque depth material for the proxy
  private _blobSunAcc = 1;                            // throttles the night-fade alpha recompute
  private readonly _blobQ = Quaternion.Identity();   // identity — the plugin orients the disc in local space
  private readonly _blobPos = new Vector3();
  private readonly _blobScale = new Vector3();
  private static readonly TOWN_BLOBS = true;          // master toggle
  private static readonly BLOB_LIFT = 0.08;           // raise the decal off the pad (z-fight guard)
  // PIER streaming (50-town map): piers used to be built once for ALL towns and stay resident —
  // every pier mesh then lives in the main pass, the ocean mirror RTT (addToRenderList), the
  // shadow cascades (addShadowCaster) AND the glow include list (lantern), all frame, every frame.
  // A 14 m pier is sub-pixel beyond ~2 km, so stream them like buildings; disposal must unwind
  // those four registrations (see disposePier).
  private readonly pierNodes = new Map<string, TransformNode>();
  private readonly pierLoading = new Set<string>();
  // Distant-town BUILDING IMPOSTOR layer: one camera-facing billboard mesh per building TYPE, thin-instanced
  // across every town (~few draws total), faded in past the mesh-drop range + out by ~5 km (see
  // TownImpostorPlugin). Built once from the baked impostor atlas; keeps distant coastlines populated cheaply.
  private impostorMeshes: Mesh[] = [];
  private readonly PIER_BUILD_RANGE = 2400;
  private readonly PIER_DROP_RANGE = 2800;
  // Shared ground materials (procedural cobblestone for the square, dirt for the roads) — built once.
  private squareMat: StandardMaterial | null = null;
  private roadMat: StandardMaterial | null = null;
  // Building stream ranges: full 3-D buildings only in the CLOSE bubble now that the impostor layer (T3)
  // covers the mid-distance — so we pull this in hard (was 950/1150) to slash near-town building draws.
  // The impostor fade-in band (TownImpostorPlugin.band) is set to reach full right as real meshes drop, so
  // the town never disappears at the handoff. Tune the two together.
  private readonly BUILD_RANGE = 600;
  private readonly DROP_RANGE = 800;
  // Cap on simultaneous full-detail towns: only the nearest MAX_ACTIVE_TOWNS inside BUILD_RANGE may
  // START building. Eviction stays purely range-based (DROP_RANGE) — rank churn between two towns at
  // similar distances never disposes one, so there's no swap-thrash; the cap just stops a dense bay
  // from instantiating 3+ full towns at once.
  private readonly MAX_ACTIVE_TOWNS = 2;
  private readonly STREAM_BUILDINGS = true;
  // Dock when the hull is within ~40 ft (≈12 m) of the pier DECK EDGE (not the shore point — the pier
  // blocks the centre from ever reaching the shore). Per-variant deck size (m): len = along-seaward
  // from the shore point, halfWidth = half the across-extent (matches the server pier-obstacles dims).
  private readonly DOCK_EDGE_M = 12;
  private readonly PIER_DIMS: Record<string, { len: number; halfWidth: number }> = {
    straight: { len: 14.3, halfWidth: 1.6 },
    l:        { len: 11.0, halfWidth: 6.5 },
    t:        { len: 11.0, halfWidth: 6.5 },
  };

  /** The town the player is currently close enough to dock at, or null. Read by the HUD/game UI. */
  readonly dockable = signal<TerrainHarbor | null>(null);

  private _hideLabels = false;   // photo mode hides the floating town signs for a clean screenshot
  /** Photo mode: hide/show the floating town signs (called from the game component's photoMode effect). */
  setLabelsHidden(hidden: boolean): void {
    this._hideLabels = hidden;
    if (hidden) { for (const { plane } of this.townLabels.values()) plane.setEnabled(false); }   // instant hide; the loop restores
  }

  // Floating town signs (same ornate brass plaque as the ship nameplates — see nameplate.ts). Streamed in as
  // the player nears a town and dropped again past LBL_DROP, so only the ~1–2 nearest carry a live billboard.
  // Tinted by the owning nation; a "⚓ NATION CAPITAL/MEDIUM/SMALL" tag under the town name.
  private readonly townLabels = new Map<string, { plane: Mesh; h: TerrainHarbor }>();
  private readonly LBL_SHOW   = 2000;   // build the sign within this range (m)
  private readonly LBL_DROP   = 2400;   // drop it past this (hysteresis vs SHOW)
  private readonly LBL_NEAR   = 350;    // ≤ this → base size; beyond, softened-perspective growth
  private readonly LBL_POW    = 0.6;    // perspective softening (matches the ship labels)
  private readonly LBL_FAR    = 7;      // scale cap
  private readonly LBL_W      = 46;     // base plane size (a town sign is a bigger landmark than a ship plate)
  private readonly LBL_H      = 12.8;   // ≈ LBL_W / 3.6 (texture aspect)
  private readonly LBL_LIFT   = 18;     // lower edge this far above the town's pad (clears the buildings)

  /** Create the civic-square night light (intensity 0). IDEMPOTENT and safe to call BEFORE init() — the game
   *  bootstrap calls it right after the scene boots so the scene's dynamic-light COUNT is fixed before any heavy
   *  PBR material (terrain/vessel/crew) compiles. Adding this light later forces a material recompile that races
   *  the WebGPU bind-group cache → the intermittent "Can't find buffer Light6" crash during the intro swoop.
   *  Parked per-frame at the nearest town's square (intensity driven by the night curve). STANDARD falloff = a
   *  plain range-cutoff multiplier (PBR's default inverse-square would vanish at this scale). */
  reserveLights(): void {
    if (this.squareLight) return;
    const scene = this.sceneService.scene;
    if (!scene) return;
    this.squareLight = new PointLight('townSquareLight', new Vector3(0, 8, 0), scene);
    this.squareLight.diffuse = new Color3(1.0, 0.80, 0.52);
    this.squareLight.specular = new Color3(0.35, 0.26, 0.16);
    this.squareLight.falloffType = PointLight.FALLOFF_STANDARD;
    this.squareLight.range = 85;   // square sits ~28 m inland; reach the pier/waterfront too
    this.squareLight.intensity = 0;
  }

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    this.harbors = this.terrainService.getHarbors();
    if (!scene || !this.harbors.length) return;
    this.root = new TransformNode('harbors_root', scene);

    this.reserveLights();   // civic-square light (idempotent; normally already created early — see reserveLights)

    this.tickObs = scene.onBeforeRenderObservable.add(() => this.sceneService.span('harbor', () => this.tick()));
    // Piers are streamed by the tick (first tick runs on frame 0), nearest-first — nothing to
    // build up front. The 3 variant GLBs parse once into the shared cache on first use.
    this.buildTownImpostors();   // async; distant-town billboard layer (fire-and-forget)
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
    const nf = this.nightFactor();   // 0 in daylight → 1 after dark
    if (this.squareLight) {
      // Park at the nearest town's civic square (world coords) — its pad is flat, so a fixed height
      // lights the cobblestones + the buildings ringing it. Fall back to just inland of the shore point.
      const sx = best.square ? best.square.cx : best.x - fx * 28;
      const sz = best.square ? best.square.cz : best.z - fz * 28;
      this.squareLight.position.set(sx, (best.pad?.elev ?? 0) + 8, sz);
      this.squareLight.intensity = 6 * nf;
    }

    // Distance from the hull to the pier deck edge: nearest point on the pier centreline segment
    // (shore → seaward end), minus the deck half-width.
    const dim = this.PIER_DIMS[best.variant] ?? this.PIER_DIMS['straight'];
    const segD = this.distToSegment(p.x, p.z, best.x, best.z, best.x + fx * dim.len, best.z + fz * dim.len);
    // segD is measured from the ship CENTRE, so scale the allowance by the hull's reach: a big ship
    // (brig half-len 12 m) docks from much farther out than a pinnace (4 m), since its hull edge is
    // alongside the pier while its centre is still a full hull-length off it.
    const inRange = Math.max(0, segD - dim.halfWidth) <= this.DOCK_EDGE_M + this.vesselService.getHullReach();

    const cur = this.dockable();
    if (inRange) { if (!cur || cur.id !== best.id) this.dockable.set(best); }
    else if (cur) { this.dockable.set(null); }
  }

  /**
   * Tie-up berth for harbour `h` given the boat's current pose: a point ALONGSIDE the pier deck edge, on
   * whichever side the boat approaches from, parallel to the pier and offset clear of the deck. Fed to the
   * vessel's auto-dock glide. Returns world XZ + heading°.
   */
  computeBerth(
    h: TerrainHarbor, boatX: number, boatZ: number, boatHeadingDeg: number,
  ): { x: number; z: number; heading: number } {
    const hr = (h.heading * Math.PI) / 180;
    const fx = Math.sin(hr), fz = Math.cos(hr);          // seaward unit (pier centreline direction)
    const px = fz, pz = -fx;                             // unit perpendicular (starboard of seaward)
    const dim = this.PIER_DIMS[h.variant] ?? this.PIER_DIMS['straight'];
    // Project the boat onto the centreline; berth alongside the seaward half of the deck (clamped on-pier).
    const along = Math.max(dim.len * 0.45, Math.min(dim.len * 0.95,
      (boatX - h.x) * fx + (boatZ - h.z) * fz));
    const cx = h.x + fx * along, cz = h.z + fz * along;  // centreline point abreast the berth
    const side = ((boatX - cx) * px + (boatZ - cz) * pz) >= 0 ? 1 : -1;   // boat's side of the pier
    const offset = dim.halfWidth + 3.0;                  // clear of the deck edge (~hull half-beam + fenders)
    const bx = cx + px * side * offset, bz = cz + pz * side * offset;
    // Heading: parallel to the pier, in whichever direction is closest to the boat's current heading
    // (so it eases alongside rather than spinning 180°).
    const fwd = ((h.heading % 360) + 360) % 360;
    const aft = (fwd + 180) % 360;
    const dF = Math.abs(((boatHeadingDeg - fwd + 540) % 360) - 180);
    const dA = Math.abs(((boatHeadingDeg - aft + 540) % 360) - 180);
    return { x: bx, z: bz, heading: dF <= dA ? fwd : aft };
  }

  /** Shortest distance from point P to segment [A,B] in the XZ plane. */
  private distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  }

  /** 0 in daylight → 1 after dark. Drives the warm pier + square pool lights so they glow at night and switch
   *  off when the sun would wash them out. Keyed on the SUN'S ELEVATION (not a fixed clock) so it follows the
   *  actual day length — including the long summer day — instead of a hardcoded symmetric sunrise/sunset. */
  private nightFactor(): number {
    const y = this.sceneService.getSunDirection().y;      // −1 midnight … +1 noon
    return Math.max(0, Math.min(1, (0.12 - y) / 0.22));   // sun ≥ +0.12 → 0 (daylight); ≤ −0.10 → 1 (full night)
  }

  /** Per-frame: keep the pool light on the nearest pier + dockable town (every frame), and stream
   *  piers + town buildings in/out of range (a few times a second — instantiation is far too heavy
   *  to scan per frame). */
  private tick(): void {
    this.updateNearestPier();
    if (this.impostorMeshes.length) { this.updateImpostorCamera(); }
    const f = this.frame++;
    // Towns are STATIC, so their signs' scale/position drift slowly with the camera — refresh at ~15 Hz, not 60.
    if ((f & 3) === 0) { this.updateTownLabels(); }
    if ((f % 20) === 0) { this.streamPiers(); this.streamTowns(); this.streamTownLabels(); this.updateTownBlobs(); }
    this.driveTownBlobSun();   // night-fade the building blobs (throttled internally)
  }

  // ── Cheap fake building shadows (nearest streamed town only) ─────────────────────────────────────

  /** Pick the nearest STREAMED town and (re)build its building blob shadows when that changes. Only towns whose
   *  real meshes are resident (townNodes) are candidates — so blobs never show under the distant LOD impostors. */
  private updateTownBlobs(): void {
    const scene = this.sceneService.scene;
    if (!scene) return;
    const p = this.vesselService.getPosition();
    let nearestId: string | null = null, best = Infinity;
    for (const h of this.harbors) {
      if (!this.townNodes.has(h.id)) continue;
      const d2 = (h.x - p.x) ** 2 + (h.z - p.z) ** 2;
      if (d2 < best) { best = d2; nearestId = h.id; }
    }
    // Real shadows (default): the nearest streamed town casts a real proxy shadow NEAR (the CSG discards it past
    // ~150 m), and the cheap fake blob discs fill the FAR band so shadows continue to the full mesh range with no
    // scene-wide shadow cost. Both run; the distance split (SHADOW_FAR2) keeps them from doubling up much.
    if (this.townRealShadows && this.sceneService.shadowGenerator) {
      this.updateTownRealShadows(nearestId);
      const farTown = (HarborService.TOWN_BLOBS && nearestId && best > HarborService.SHADOW_FAR2) ? nearestId : null;
      this.setBlobTown(scene, farTown);
      return;
    }
    if (!HarborService.TOWN_BLOBS) return;
    this.setBlobTown(scene, nearestId);   // blobs-everywhere fallback (real shadows opted out)
  }

  /** (Re)build the fake blob discs for `blobTown` (or clear when null), skipping the rebuild when unchanged. */
  private setBlobTown(scene: Scene, blobTown: string | null): void {
    if (blobTown === this._blobTownId && (blobTown === null || this._townShadowDisc?.isVisible)) return;
    this._blobTownId = blobTown;
    if (blobTown) { this.ensureTownShadowAssets(scene); this.buildTownBlobsFor(blobTown); }
    else { this.clearTownBlobs(); }
  }

  /** Build a cheap box-proxy caster for the nearest streamed town (and unwind the previous town's). Gated so it
   *  auto-drops past the shadow-distance cull — a resident but far town costs nothing. One town at a time. */
  private updateTownRealShadows(nearestId: string | null): void {
    if (nearestId === this._shadowTownId) return;
    this.detachTownShadowCasters();
    this._shadowTownId = nearestId;
    if (!nearestId) return;
    const node = this.townNodes.get(nearestId);
    if (!node) { this._shadowTownId = null; return; }
    const proxy = this.buildTownShadowProxy(node, nearestId);
    if (proxy) { this._townShadowProxy = proxy; this.sceneService.addGatedShadowCaster(proxy); }
  }

  /** Pull this town's proxy back out of the sun CSG + dispose it (nearest-town change, eviction, or teardown). */
  private detachTownShadowCasters(): void {
    if (this._townShadowProxy) {
      this.sceneService.removeGatedShadowCaster(this._townShadowProxy);
      this._townShadowProxy.dispose();
      this._townShadowProxy = null;
    }
    this._shadowTownId = null;
  }

  /** One merged mesh = an axis-aligned box per building (its world bounding box). Invisible to the camera (layerMask
   *  outside the camera's mask) but cast into the shadow map — so the whole town is a single low-poly shadow caster
   *  instead of dozens of high-poly building submeshes ×3 cascades. Verts are built RELATIVE to the town centre and
   *  the mesh is anchored there, so `absolutePosition` is the town (the gated-caster cull measures the right
   *  distance) — a mesh at the origin with world-baked verts would be culled whenever the player nears the town. */
  private buildTownShadowProxy(node: TransformNode, townId: string): Mesh | null {
    const scene = this.sceneService.scene;
    if (!scene) return null;
    // Pass 1: collect each building's world AABB + the town's overall bounds (→ anchor centre).
    const boxes: { mnx: number; mny: number; mnz: number; mxx: number; mxy: number; mxz: number }[] = [];
    let lox = Infinity, loz = Infinity, hix = -Infinity, hiz = -Infinity;
    for (const bp of node.getChildTransformNodes(true)) {
      if (!bp.name.startsWith('b_')) continue;                       // building parents only (not the ground)
      const bb = bp.getHierarchyBoundingVectors(true);               // world-space AABB of this building
      const mn = bb.min, mx = bb.max;
      if (!(mx.x > mn.x && mx.y > mn.y && mx.z > mn.z)) continue;
      boxes.push({ mnx: mn.x, mny: mn.y, mnz: mn.z, mxx: mx.x, mxy: mx.y, mxz: mx.z });
      lox = Math.min(lox, mn.x); loz = Math.min(loz, mn.z); hix = Math.max(hix, mx.x); hiz = Math.max(hiz, mx.z);
    }
    if (!boxes.length) return null;
    const ax = (lox + hix) * 0.5, az = (loz + hiz) * 0.5;            // town-centre anchor (Y stays 0 — verts carry it)
    const pos: number[] = [], idx: number[] = [];
    // Box faces (winding irrelevant to the depth-only shadow pass; a closed convex box silhouettes either way).
    const FACES = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
    let base = 0;
    for (const b of boxes) {
      const x0 = b.mnx - ax, x1 = b.mxx - ax, z0 = b.mnz - az, z1 = b.mxz - az, y0 = b.mny, y1 = b.mxy;
      pos.push(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,       // bottom 0-3
               x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1);      // top 4-7
      for (const v of FACES) idx.push(base + v);
      base += 8;
    }
    const vd = new VertexData();
    vd.positions = pos; vd.indices = idx;
    const mesh = new Mesh(`town_shadow_proxy_${townId}`, scene);
    vd.applyToMesh(mesh, false);
    mesh.position.set(ax, 0, az);                        // anchor at the town → correct absolutePosition for the cull
    if (!this._townShadowProxyMat) {                     // shared opaque material (never seen; depth only)
      this._townShadowProxyMat = new StandardMaterial('town_shadow_proxy_mat', scene);
      this._townShadowProxyMat.disableLighting = true;
    }
    mesh.material = this._townShadowProxyMat;
    mesh.layerMask = HarborService.SHADOW_PROXY_MASK;   // invisible to the camera; the shadow map ignores the mask
    mesh.isPickable = false;
    return mesh;
  }

  /** Thin-instance one soft blob under each building of the given (streamed) town, sized to its measured footprint. */
  private buildTownBlobsFor(townId: string): void {
    const node = this.townNodes.get(townId), disc = this._townShadowDisc;
    if (!node || !disc) { this.clearTownBlobs(); return; }
    const builds = node.getChildTransformNodes(true).filter((n) => n.name.startsWith('b_'));
    const data = new Float32Array(builds.length * 16);
    let n = 0;
    for (const b of builds) {
      const bb = b.getHierarchyBoundingVectors(true);
      const r = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5 * 1.25;   // a touch wider than the base
      if (!(r > 0.5)) continue;
      this._blobPos.set((bb.min.x + bb.max.x) * 0.5, bb.min.y + HarborService.BLOB_LIFT, (bb.min.z + bb.max.z) * 0.5);
      this._blobScale.set(r * 2, 1, r * 2);
      Matrix.Compose(this._blobScale, this._blobQ, this._blobPos).copyToArray(data, n * 16);
      n++;
    }
    if (n === 0) { this.clearTownBlobs(); return; }
    disc.thinInstanceSetBuffer('matrix', n === builds.length ? data : data.subarray(0, n * 16), 16, false);
    disc.isVisible = true;
  }

  private clearTownBlobs(): void {
    if (this._townShadowDisc) { this._townShadowDisc.thinInstanceCount = 0; this._townShadowDisc.isVisible = false; }
  }

  /** Fade the blobs out at night + soften them as the sun lowers (matches the scatter blobs). Throttled — the sun crawls. */
  private driveTownBlobSun(): void {
    const mat = this._townShadowMat, scene = this.sceneService.scene;
    if (!mat || !scene || !this._townShadowDisc?.isVisible) return;
    this._blobSunAcc += scene.getEngine().getDeltaTime() / 1000;
    if (this._blobSunAcc < 0.5) return;
    this._blobSunAcc = 0;
    const sunY = this.sceneService.getSunDirection().y;
    const t = Math.max(0, Math.min(1, sunY / 0.16));
    const ss = t * t * (3 - 2 * t);                       // smoothstep night fade
    const stretch = ShadowBlobPlugin.SHADOW.stretch;      // shared sun-stretch (driven by ScatterService)
    mat.alpha = 0.30 * ss * (1 - 0.12 * (stretch - 1));
  }

  /** Lazily build the shared blob disc + dark soft-decal material (mirrors ScatterService.registerShadows). */
  private ensureTownShadowAssets(scene: Scene): void {
    if (this._townShadowDisc) { return; }
    const grad = new DynamicTexture('town_shadow_grad', 128, scene, false);
    const ctx = grad.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(64, 64, 1, 64, 64, 63);
    g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.32, 'rgba(255,255,255,0.80)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.84, 'rgba(255,255,255,0.15)');
    g.addColorStop(1.00, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128); grad.update(); grad.hasAlpha = true;

    const mat = new StandardMaterial('town_shadow_mat', scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = new Color3(0.02, 0.03, 0.05);   // dark cool decal (picks up sky ambient), not dead black
    mat.disableLighting = true;
    mat.opacityTexture = grad;
    mat.alpha = 0.30;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;                        // a decal: blend over the pad, don't fight other blobs
    new ShadowBlobPlugin(mat);                           // stretch away from the sun (shared global static)
    this.sceneService.excludeFromPrePass(mat);
    this._townShadowMat = mat;

    const disc = MeshBuilder.CreateGround('town_shadow_disc', { width: 1, height: 1 }, scene);
    disc.material = mat;
    disc.renderingGroupId = 2;                            // world layer — else (default group 0) it draws BEFORE the
                                                          // group-2 terrain and is painted over → invisible (the bug
                                                          // that made the town blobs never show); mirrors the scatter blobs.
    disc.isPickable = false;
    disc.isVisible = false;
    disc.alwaysSelectAsActiveMesh = true;                // thin-instance AABB isn't tracked → never frustum-cull the template
    disc.metadata = { excludeFromRefraction: true };     // never seen through the seabed water
    this.sceneService.excludeFromGlow(disc);
    this._townShadowDisc = disc;
  }

  /** Build a town's floating sign when the player nears it; drop it again once well past (hysteresis). */
  private streamTownLabels(): void {
    const scene = this.sceneService.scene;
    if (!scene) return;
    const p = this.vesselService.getPosition();
    for (const h of this.harbors) {
      const d2 = (h.x - p.x) ** 2 + (h.z - p.z) ** 2;
      const has = this.townLabels.has(h.id);
      if (!has && d2 <= this.LBL_SHOW * this.LBL_SHOW) {
        const nation = h.faction ? factionName(h.faction).toUpperCase() : 'FREE';
        const settle = (TOWN_TIER_LABEL[h.tier ?? ''] ?? 'Town').toUpperCase();   // 'small' → "SMALL TOWN", etc.
        const plane = buildNameplate(scene, 'townlbl_' + h.id, {
          title: h.name,
          subtitle: `⚓ ${nation} ${settle}`,
          baseColor: h.faction ? factionColor(h.faction) : '#4a5560',   // owned → nation tint; free → slate stone
          width: this.LBL_W, height: this.LBL_H,
          kind: 'town',   // swallowtail wooden banner — distinct from a ship's brass plaque
        });
        this.townLabels.set(h.id, { plane, h });
      } else if (has && d2 > this.LBL_DROP * this.LBL_DROP) {
        this.townLabels.get(h.id)!.plane.dispose(false, true);
        this.townLabels.delete(h.id);
      }
    }
  }

  /** Per-frame: soften-perspective scale + bottom-anchor each live town sign above its pad (mirrors ship labels). */
  private updateTownLabels(): void {
    if (!this.townLabels.size) return;
    const cam = this.sceneService.camera;
    if (!cam) return;
    for (const { plane, h } of this.townLabels.values()) {
      if (this._hideLabels) { if (plane.isEnabled()) plane.setEnabled(false); continue; }   // photo mode
      if (!plane.isEnabled()) plane.setEnabled(true);
      const d = Math.hypot(h.x - cam.position.x, h.z - cam.position.z);
      const s = Math.min(this.LBL_FAR, Math.max(1, Math.pow(d / this.LBL_NEAR, this.LBL_POW)));
      plane.scaling.set(s, s, s);
      plane.position.set(h.x, (h.pad?.elev ?? 0) + this.LBL_LIFT + this.LBL_H * s * 0.5, h.z);
    }
  }

  /** Feed the town-impostor billboard plugin the live camera XZ + horizontal right vector (so the quads face
   *  the camera) once per frame. Cheap — two uniform values shared by every impostor material. */
  private updateImpostorCamera(): void {
    const cam = this.sceneService.camera;
    if (!cam) return;
    const f = cam.getForwardRay().direction;            // camera forward (world)
    let rx = f.z, rz = -f.x;                             // horizontal right = up × forward, projected to XZ
    const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const P = TownImpostorPlugin.cam;
    P.x = cam.position.x; P.z = cam.position.z; P.rx = rx; P.rz = rz;
  }

  /** Instantiate piers within PIER_BUILD_RANGE; tear down those past PIER_DROP_RANGE (hysteresis
   *  stops boundary thrash). Keeps ~1–3 piers resident instead of all 50. */
  private streamPiers(): void {
    const scene = this.sceneService.scene;
    if (!scene) return;
    const p = this.vesselService.getPosition();
    const build2 = this.PIER_BUILD_RANGE ** 2, drop2 = this.PIER_DROP_RANGE ** 2;
    for (const h of this.harbors) {
      const d2 = (h.x - p.x) ** 2 + (h.z - p.z) ** 2;
      if (d2 < build2 && !this.pierNodes.has(h.id) && !this.pierLoading.has(h.id)) {
        this.pierLoading.add(h.id);
        this.buildPier(scene, h).then((node) => {
          if (node) this.pierNodes.set(h.id, node);
          this.pierLoading.delete(h.id);
        });
      } else if (d2 > drop2 && this.pierNodes.has(h.id)) {
        this.disposePier(this.pierNodes.get(h.id)!);
        this.pierNodes.delete(h.id);
      }
    }
  }

  /** Unwind everything buildPier registered: ocean mirror render list, shadow casters, lantern glow.
   *  Then dispose meshes only — materials/textures are shared via the asset-cache container. */
  private disposePier(node: TransformNode): void {
    for (const m of node.getChildMeshes(false)) {
      this.oceanService.removeFromRenderList(m);
      this.sceneService.removeGatedShadowCaster(m);
      if (/glass/i.test(m.name)) this.sceneService.removeFromGlow(m as Mesh);
    }
    node.dispose(false, false);
  }

  /** Instantiate the buildings of any town the player has come within BUILD_RANGE of; dispose those past
   *  DROP_RANGE. The hysteresis gap stops a town on the range boundary from thrashing in and out. */
  private streamTowns(): void {
    if (!this.STREAM_BUILDINGS) return;
    const p = this.vesselService.getPosition();
    const build2 = this.BUILD_RANGE * this.BUILD_RANGE, drop2 = this.DROP_RANGE * this.DROP_RANGE;
    const inRange: { h: TerrainHarbor; d2: number }[] = [];
    for (const h of this.harbors) {
      if (!h.buildings || !h.buildings.length) continue;
      const d2 = (h.x - p.x) ** 2 + (h.z - p.z) ** 2;
      if (d2 < build2) {
        inRange.push({ h, d2 });
      } else if (d2 > drop2 && this.townNodes.has(h.id)) {
        // Unwind real shadow casters BEFORE disposing this town's meshes (else disposed meshes linger in the CSG).
        if (this._shadowTownId === h.id) this.detachTownShadowCasters();
        // dispose meshes only, NOT materials/textures: they're shared (cloneMaterials=false) via the
        // asset-cache container and reused by every other town that streams the same GLB. Disposing them
        // here would leave later towns with null materials (white). The container owns them (clearCache).
        this.townNodes.get(h.id)!.dispose(false, false);
        this.townNodes.delete(h.id);
      }
    }
    // Build only the nearest MAX_ACTIVE_TOWNS candidates (closest first).
    inRange.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < inRange.length && i < this.MAX_ACTIVE_TOWNS; i++) {
      const h = inRange[i].h;
      if (this.townNodes.has(h.id) || this.townLoading.has(h.id)) continue;
      this.townLoading.add(h.id);
      this.buildTown(h).then((node) => {
        if (node) this.townNodes.set(h.id, node);
        this.townLoading.delete(h.id);
      });
    }
  }

  /** Instantiate one town's buildings onto its (already-flattened) pad. Each building's GLB is loaded once
   *  via the shared cache; instances are parented per-building so the seaward yaw can be applied on a
   *  quaternion-free parent (the instantiate root carries the loader's RH→LH quaternion — see buildPier). */
  private async buildTown(h: TerrainHarbor): Promise<TransformNode | null> {
    const scene = this.sceneService.scene;
    if (!scene || !h.buildings) return null;
    const root = new TransformNode(`town_${h.id}`, scene);
    root.parent = this.root;
    const padElev = h.pad?.elev ?? 0;
    for (const b of h.buildings) {
      const parent = new TransformNode(`b_${h.id}_${b.asset}`, scene);
      parent.parent = root;
      const node = await this.assetCache.instantiate(`harbors/${b.asset}.glb`, scene, parent, false);
      if (!node) { parent.dispose(); continue; }
      // Stilt-shacks straddle the waterline (origin at y=0); every other asset rests on the flat pad.
      parent.position.set(b.x, b.asset === 'cabin_shack' ? 0 : padElev, b.z);
      parent.rotation.y = (b.rotY * Math.PI) / 180;
      this.applyBuildingRecipe(node);
    }
    this.buildGround(h, root, padElev);
    await this.buildWalls(h, root, padElev);
    return root;
  }

  /** Harbor Forts — WALL-PATH SPIKE. Place PLACEHOLDER box segments along the town's server-derived `walls`
   *  ring so we can validate the auto-generated path in-engine before the real modular wall kit exists: a thin
   *  tall curtain box between consecutive nodes, a taller box tower at each corner/bastion, and a low lintel at
   *  the gate. Parented to the town root so it streams + disposes with the buildings. Cheap StandardMaterial +
   *  frozen meshes (no shadows/prepass) to stay clear of the WebGPU town light/UBO cap. */
  private async buildWalls(h: TerrainHarbor, root: TransformNode, padElev: number): Promise<void> {
    const scene = this.sceneService.scene;
    const W = h.walls;
    if (!scene || !W || W.length < 2) return;
    const MESH_LEN = 6.0, SPACING = 8.0;   // 6 m curtain repeated at ~8 m (fewer instances, mild stretch)
    // Curtain: repeat wall_straight along each segment (OPEN polyline — the last→first gap is the harbor mouth),
    // scaled to fit, oriented so the crenellations (authored -Z) face OUTWARD, away from the town centre.
    // NB: Babylon's glTF import is left-handed — verify the outward side in-engine; flip the `yaw += PI` test if wrong.
    for (let i = 0; i + 1 < W.length; i++) {
      const a = W[i], b = W[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const ux = dx / len, uz = dz / len;
      const midx = (a.x + b.x) / 2, midz = (a.z + b.z) / 2;
      let yaw = Math.atan2(ux, uz) - Math.PI / 2;   // local +X runs along the segment
      if (uz * (midx - h.x) - ux * (midz - h.z) < 0) yaw += Math.PI;   // -Z faces outward
      const count = Math.max(1, Math.round(len / SPACING));
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        const parent = new TransformNode(`fortwall_${h.id}_${i}_${k}`, scene);
        parent.parent = root;
        const node = await this.assetCache.instantiate('forts/wall_straight.glb', scene, parent, false);
        if (!node) { parent.dispose(); continue; }
        parent.position.set(a.x + dx * t, padElev, a.z + dz * t);
        parent.rotation.y = yaw;
        parent.scaling.x = (len / count) / MESH_LEN;
        this.applyBuildingRecipe(node);
      }
    }
    // Small towns get a T1 harbour battery at their seaward strongpoint: the first bastion node
    // (seaward-left). The fort's own corner geometry stands in for the wall tower there, so we skip
    // that tower. Guns face seaward = away from the town centre (authored -Z outward), like the walls.
    // (Medium/capital want T2/T3 forts, not yet authored — walls only for now.)
    let fortIdx = -1;
    if (h.tier === 'small') fortIdx = W.findIndex((n) => n.tag === 'bastion');
    if (fortIdx >= 0) {
      const n = W[fortIdx];
      const parent = new TransformNode(`fort_${h.id}`, scene);
      parent.parent = root;
      const node = await this.assetCache.instantiate('forts/fort_t1.glb', scene, parent, false);
      if (node) {
        parent.position.set(n.x, padElev, n.z);
        parent.rotation.y = Math.atan2(-(n.x - h.x), -(n.z - h.z));   // -Z faces outward (seaward)
        this.applyBuildingRecipe(node);
      } else parent.dispose();
    }
    // Bastion tower at each node (1.25x on bastions; a square tower reads the same at any yaw).
    for (let i = 0; i < W.length; i++) {
      if (i === fortIdx) continue;   // the fort stands in for this tower
      const n = W[i];
      const parent = new TransformNode(`fortnode_${h.id}_${i}`, scene);
      parent.parent = root;
      const node = await this.assetCache.instantiate('forts/wall_tower.glb', scene, parent, false);
      if (!node) { parent.dispose(); continue; }
      const s = n.tag === 'bastion' ? 1.25 : 1.0;
      parent.position.set(n.x, padElev, n.z);
      parent.scaling.set(s, 1, s);
      this.applyBuildingRecipe(node);
    }
  }

  /** Build the static distant-town impostor layer: for EVERY town's buildings, drop a camera-facing billboard
   *  (baked 3/4 view) thin-instanced per building TYPE — so all towns are visible mid-distance for ~a handful
   *  of draws. Hidden up close (real streamed buildings own that) + faded out past ~5 km via TownImpostorPlugin.
   *  Piers have no impostor (they stream as real meshes), so they're simply skipped. */
  private async buildTownImpostors(): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene || !this.harbors.length) return;
    const base = `${Settings.apiUrl}geometry/harbors/impostors/`;
    let sizes: Record<string, { size: number }>;
    try {
      const mani = await (await fetch(`${base}impostors_manifest.json`)).json();
      sizes = mani?.buildings ?? {};
    } catch { return; }

    // Gather all instances grouped by building TYPE (world coords; per-instance translation matrix).
    const byType = new Map<string, number[]>();
    for (const h of this.harbors) {
      if (!h.buildings) continue;
      const y = h.pad?.elev ?? 0;
      for (const b of h.buildings) {
        if (!sizes[b.asset]) continue;                  // no impostor (piers) → skip
        let arr = byType.get(b.asset);
        if (!arr) { arr = []; byType.set(b.asset, arr); }
        Matrix.Translation(b.x, y, b.z).copyToArray(arr, arr.length);
      }
    }
    if (!byType.size || !this.root) return;

    for (const [asset, arr] of byType) {
      const size = sizes[asset].size;
      const url = `${base}${asset}_imp.png`;
      const pad = await measureBottomPad(url, 0.0);      // align the building's base to the instance ground
      if (!this.root) return;                            // disposed mid-await
      const tex = new Texture(url, scene);
      tex.hasAlpha = true;

      const mesh = MeshBuilder.CreatePlane(`town_imp_${asset}`, { width: size, height: size }, scene);
      mesh.bakeTransformIntoVertices(Matrix.Translation(0, size / 2 - pad * size, 0));   // base → local y=0
      const mat = new StandardMaterial(`town_imp_mat_${asset}`, scene);
      mat.diffuseTexture = tex; mat.emissiveTexture = tex;   // pre-lit: show the baked image directly
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.disableLighting = true;
      mat.transparencyMode = Material.MATERIAL_ALPHATEST;
      mat.alphaCutOff = 0.4;
      mat.backFaceCulling = false;
      mat.useAlphaFromDiffuseTexture = true;
      new TownImpostorPlugin(mat);                        // camera-facing billboard + distance-band fade (vertex)
      new ImpostorHazePlugin(mat);                        // aerial haze (fragment) — recede with the terrain
      this.sceneService.excludeFromPrePass(mat);

      mesh.material = mat;
      mesh.parent = this.root;
      mesh.renderingGroupId = 2;                          // world layer (terrain/ocean/vessels)
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;               // billboarded in-shader → bounds meaningless; instances are tiny + fade-gated
      mesh.doNotSyncBoundingInfo = true;
      this.sceneService.excludeFromGlow(mesh);
      mesh.thinInstanceSetBuffer('matrix', new Float32Array(arr), 16, true);
      this.impostorMeshes.push(mesh);
    }
  }

  /** Lazily build the two shared procedural ground materials: cobblestone (the civic square) + dirt (roads).
   *  Self-contained — the textures are drawn to a canvas, so no asset files/server routes are needed. */
  private ensureGroundMaterials(scene: Scene): void {
    if (this.squareMat) return;
    const cob = new StandardMaterial('townCobbleMat', scene);
    cob.diffuseTexture = this.makeCobbleTexture(scene);
    const dirt = new StandardMaterial('townDirtMat', scene);
    dirt.diffuseTexture = this.makeDirtTexture(scene);
    for (const mat of [cob, dirt]) {
      mat.specularColor = new Color3(0, 0, 0);        // matte ground — no plastic highlight
      mat.maxSimultaneousLights = 2;
      mat.fogEnabled = false;
      mat.backFaceCulling = false;                    // flat ground quads — visible regardless of winding
      this.sceneService.excludeFromPrePass(mat);
    }
    // The dirt path uses its texture's alpha for soft, worn edges that blend into the ground (an "airbrushed"
    // trodden look, not a hard-edged laid road). disableDepthWrite avoids z-fighting where roads overlap.
    dirt.useAlphaFromDiffuseTexture = true;
    dirt.transparencyMode = Material.MATERIAL_ALPHABLEND;
    dirt.disableDepthWrite = true;
    this.squareMat = cob;
    this.roadMat = dirt;
  }

  /** Procedural cobblestone: warm-grey rounded stones with mortar gaps, brick-offset rows. */
  private makeCobbleTexture(scene: Scene): DynamicTexture {
    const S = 256, dt = new DynamicTexture('townCobbleTex', S, scene, true);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    let seed = 0x9e37; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    ctx.fillStyle = '#4a453f'; ctx.fillRect(0, 0, S, S);
    const cw = 22, ch = 18;
    for (let y = -ch; y < S + ch; y += ch) {
      const off = (Math.round(y / ch) % 2) * (cw / 2);
      for (let x = -cw; x < S + cw; x += cw) {
        const px = x + off + 1.5, py = y + 1.5, w = cw - 3 - rnd() * 2, h = ch - 3 - rnd() * 2;
        const g = 118 + Math.floor(rnd() * 64);
        ctx.fillStyle = `rgb(${g},${Math.max(0, g - 8)},${Math.max(0, g - 18)})`;
        ctx.beginPath();
        const rr = ctx as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
        if (rr.roundRect) rr.roundRect(px, py, w, h, 4); else ctx.rect(px, py, w, h);
        ctx.fill();
      }
    }
    dt.update();
    dt.wrapU = dt.wrapV = Texture.WRAP_ADDRESSMODE;
    return dt;
  }

  /** Procedural WORN PATH: U across the path (0..1, clamped) = a soft alpha cross-section that wavers + thins
   *  patchily (grass showing through); V along the path (tiling) = trodden-dirt colour noise. Alpha-blended by
   *  the material, so the path airbrushes into the ground rather than reading as a hard-edged laid road. */
  private makeDirtTexture(scene: Scene): DynamicTexture {
    const W = 96, H = 128, P = 8;                      // P = noise tiling period (in V) for a seamless wrap
    const dt = new DynamicTexture('townDirtTex', { width: W, height: H }, scene, true);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    const img = ctx.createImageData(W, H), d = img.data;
    const hash = (x: number, y: number) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const vn = (x: number, y: number) => {            // tileable bilinear value-noise (period P in y)
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
      const hh = (a: number, b: number) => hash(a, ((b % P) + P) % P);
      const n00 = hh(xi, yi), n10 = hh(xi + 1, yi), n01 = hh(xi, yi + 1), n11 = hh(xi + 1, yi + 1);
      return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
    };
    const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (let y = 0; y < H; y++) {
      const vv = y / H;
      for (let x = 0; x < W; x++) {
        const uu = x / (W - 1), distC = Math.abs(uu - 0.5) * 2;       // 0 centre … 1 edge
        const halfW = 0.62 + (vn(uu * 3, vv * P) - 0.5) * 0.30;       // wavering path width
        let alpha = 1 - smooth(halfW - 0.28, halfW + 0.04, distC);    // soft fade past the edge
        alpha *= 0.66 + 0.34 * vn(uu * 5 + 11, vv * P + 3);          // patchy wear (grass peeks through)
        const worn = 1 - (1 - distC) * 0.22;                         // centre darker (trodden)
        const base = (96 + vn(uu * 7 + 3, vv * P * 2) * 30) * worn;  // darker trodden earth (reads in daylight)
        const i = (y * W + x) * 4;
        d[i] = base; d[i + 1] = base * 0.80; d[i + 2] = base * 0.58;
        d[i + 3] = Math.max(0, Math.min(255, alpha * 255));
      }
    }
    ctx.putImageData(img, 0, 0);
    dt.update();
    dt.hasAlpha = true;
    dt.wrapU = Texture.CLAMP_ADDRESSMODE;              // U = cross-section, don't repeat the falloff
    dt.wrapV = Texture.WRAP_ADDRESSMODE;               // V = along the path, tiles
    return dt;
  }

  /** Build a town's ground: a dirt ribbon mesh along the (curving) street segments + a cobblestone square,
   *  laid flat on the pad just above the terrain. One mesh each → cheap; parented to the town so they stream
   *  + dispose with it (materials are shared and survive — see dispose()). */
  private buildGround(h: TerrainHarbor, root: TransformNode, padElev: number): void {
    const scene = this.sceneService.scene;
    if (!scene) return;
    this.ensureGroundMaterials(scene);
    // Drape on the ACTUAL ground (so roads follow the slope down to the pier, not float flat) + 8 cm.
    const yAt = (x: number, z: number) => (this.sceneService.getTerrainHeight(x, z) ?? padElev) + 0.08;

    // ── Dirt roads: each street segment → a SUBDIVIDED ribbon that conforms to the terrain; all one mesh ──
    if (h.streets?.length) {
      const pos: number[] = [], idx: number[] = [], uv: number[] = [], nrm: number[] = [];
      for (const s of h.streets) {
        const dx = s.x2 - s.x1, dz = s.z2 - s.z1, len = Math.hypot(dx, dz) || 1;
        const px = (-dz / len) * (s.width / 2), pz = (dx / len) * (s.width / 2);
        const n = Math.max(1, Math.ceil(len / 4));     // ~4 m steps so it tracks the slope
        for (let i = 0; i <= n; i++) {
          const t = i / n, cx = s.x1 + dx * t, cz = s.z1 + dz * t;
          const lx = cx + px, lz = cz + pz, rx = cx - px, rz = cz - pz;
          const b = pos.length / 3;
          pos.push(lx, yAt(lx, lz), lz, rx, yAt(rx, rz), rz);
          nrm.push(0, 1, 0, 0, 1, 0);
          const v = (len * t) / 6;
          uv.push(0, v, 1, v);                         // U=0/1 across the path, V tiles along it
          if (i > 0) idx.push(b - 2, b, b - 1, b - 1, b, b + 1);
        }
      }
      const vd = new VertexData(); vd.positions = pos; vd.indices = idx; vd.uvs = uv; vd.normals = nrm;
      const mesh = new Mesh(`roads_${h.id}`, scene);
      vd.applyToMesh(mesh);
      mesh.material = this.roadMat; mesh.parent = root; mesh.renderingGroupId = 2;
      mesh.isPickable = false; mesh.receiveShadows = this.townRealShadows; mesh.freezeWorldMatrix();
    }

    // ── Cobblestone square (on the flat pad; sampled corners + 3 cm above the roads where they meet) ──
    if (h.square) {
      const sq = h.square, hr = (sq.rotY * Math.PI) / 180;
      const ax = Math.sin(hr), az = Math.cos(hr);     // along heading (halfZ axis)
      const bx = Math.cos(hr), bz = -Math.sin(hr);    // across (halfX axis)
      const corner = (a: number, c: number) => [sq.cx + ax * a * sq.halfZ + bx * c * sq.halfX, sq.cz + az * a * sq.halfZ + bz * c * sq.halfX];
      const cs = [corner(-1, -1), corner(1, -1), corner(-1, 1), corner(1, 1)];
      const vd = new VertexData();
      vd.positions = cs.flatMap((c) => [c[0], yAt(c[0], c[1]) + 0.03, c[1]]);
      vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
      vd.uvs = [0, 0, sq.halfZ / 2.5, 0, 0, sq.halfX / 2.5, sq.halfZ / 2.5, sq.halfX / 2.5];
      vd.indices = [0, 2, 1, 1, 2, 3];
      const mesh = new Mesh(`square_${h.id}`, scene);
      vd.applyToMesh(mesh);
      mesh.material = this.squareMat; mesh.parent = root; mesh.renderingGroupId = 2;
      mesh.isPickable = false; mesh.receiveShadows = this.townRealShadows; mesh.freezeWorldMatrix();
    }
  }

  /** WebGPU-minimal recipe for a building's meshes. These imported PBR materials otherwise blow the per-
   *  stage uniform-buffer limit (12 vertex UBOs on Metal): every extra pipeline variant (prePass, glow,
   *  shadow-receive) + light slot adds bindings. So we keep buildings DELIBERATELY cheap: no fog, out of
   *  the prePass, NOT shadow casters or glow-included (yet), light slots capped, and every optional PBR
   *  feature block disabled. Buildings are inland → also kept out of the ocean-reflection list.
   *  (Shadows + window glow come back in a later polish phase once the budget is profiled.) */
  private applyBuildingRecipe(node: TransformNode): void {
    for (const m of node.getChildMeshes(false)) {
      m.receiveShadows = false;
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
      // Above-water structure: skip the ocean's seabed-refraction RTT (never seen through the water),
      // cutting the heavy refraction-frame draw count. See OceanService.buildReflectionRTT.
      m.metadata = { ...(m.metadata ?? {}), excludeFromRefraction: true };
      const mat = m.material;
      if (mat && !this.frozenMats.has(mat)) {
        this.frozenMats.add(mat);
        mat.fogEnabled = false;
        this.sceneService.excludeFromPrePass(mat);
        // Cap light slots regardless of the concrete material class (duck-typed — the glTF loader's
        // material may not be `instanceof PBRMaterial` across module boundaries): fewer light UBOs.
        const lit = mat as unknown as { maxSimultaneousLights?: number };
        if (typeof lit.maxSimultaneousLights === 'number') lit.maxSimultaneousLights = 2;
        if (mat instanceof PBRMaterial) {
          mat.clearCoat.isEnabled = false;
          mat.sheen.isEnabled = false;
          mat.anisotropy.isEnabled = false;
          mat.detailMap.isEnabled = false;
          this.applyEnvReflection(mat);
        }
        // Freeze: building materials never change after setup — this skips the per-frame, per-submesh
        // effect readiness re-check (_isReadyInternal) + texture/IBL re-bind (BindTextureMatrix /
        // _afterBind) that the profiler showed dominating mainRender. The container's textures are
        // already loaded by instantiate time, so freezing here won't lock in an unready effect. The
        // sky-IBL reflection still tracks time of day (the LUT texture content updates; freeze only
        // skips material recompilation, not texture sampling). A/B: localStorage ignis_no_matfreeze.
        if (localStorage.getItem('ignis_no_matfreeze') !== '1') {
          (mat as unknown as { freeze?: () => void }).freeze?.();
        }
      }
    }
  }

  /** Give SCOPED sky-IBL reflection to the PBR materials that otherwise read BLACK with no scene-wide
   *  environment texture — the metals (iron/bronze, metallic≈0.9) and the fountain water — and polish the
   *  water so it reads as a reflective pool rather than a flat black disc. Dielectrics (wood/plaster/stone)
   *  are deliberately skipped to keep the forward-pass sampler count minimal. The env source is the
   *  procedural-sky LUT (FIXED_EQUIRECTANGULAR, HDR), so the reflections track time of day for free.
   *  Idempotent — the callers dedup each material via frozenMats before invoking this. */
  private applyEnvReflection(mat: PBRMaterial): void {
    const env = this.skyEnv ?? (this.skyEnv = this.sceneService.getSkyEnvTexture());
    if (!env) return;
    const isWater = /water/i.test(mat.name);
    // NB: post-optimization each building/pier is ONE atlas material with metallicFactor=1.0 (real
    // metalness lives in the MR texture). The old `mat.metallic > 0.2` test therefore tripped on every
    // building, giving the whole shell a sky-reflection sampler + extra pipeline variant near harbors —
    // pure cost for a dielectric. Gate env reflection on NAME only (genuine metal/water assets).
    const isMetal = /bronze|iron/i.test(mat.name);
    if (!isWater && !isMetal) return;
    mat.reflectionTexture = env;                  // shares the LUT's FIXED_EQUIRECTANGULAR coordinatesMode
    if (isWater) {
      mat.metallic = 0;
      mat.roughness = 0.08;                        // glassy → crisp sky reflection
      mat.albedoColor = new Color3(0.09, 0.20, 0.24);   // dark teal base so the reflection dominates
      mat.environmentIntensity = 0.95;
    } else {
      mat.environmentIntensity = 0.5;             // metals catch sky highlights, not mirror-bright
    }
  }

  private async buildPier(scene: Scene, h: TerrainHarbor): Promise<TransformNode | null> {
    const parent = new TransformNode(`harbor_${h.id}`, scene);
    parent.parent = this.root;

    // flipY=false: piers are authored +up, no 180° hull flip. The cache shares geometry+materials.
    const pier = await this.assetCache.instantiate(`harbors/pier_${h.variant}.glb`, scene, parent, false);
    if (!pier) { console.warn(`[Harbor] pier GLB failed to load: pier_${h.variant}.glb`); parent.dispose(); return null; }

    // Determine (once per variant) the base yaw that aligns the model's seaward axis to +Z. Must be
    // measured while the parent is still at identity (so child world AABB == model space).
    let off = this.seawardOffset.get(h.variant);
    if (off === undefined) { off = this.computeSeawardOffset(pier); this.seawardOffset.set(h.variant, off); }

    // Place at the shore point, waterline at y=0, body extending along the seaward heading.
    // IMPORTANT: the seaward yaw (off) is applied to the PARENT, not the pier. The instantiated root
    // carries the glTF loader's RH->LH coordinate-conversion rotationQuaternion, and Babylon ignores a
    // node's Euler `.rotation` whenever a rotationQuaternion is set — so the old `pier.rotation.y = off`
    // was silently a no-op, leaving every pier facing 180 deg landward (invisible on the symmetric
    // straight, but it threw the asymmetric L/T crossbar onto the shore). The parent has no quaternion,
    // so off composes cleanly onto its world Y: rotation.y = heading + off rotates the model's measured
    // seaward axis onto the world seaward direction.
    parent.position.set(h.x, 0, h.z);
    parent.rotation.y = (h.heading * Math.PI) / 180 + off;

    // Static registration. The pier's full PBR (albedo+MR+normal, + emissive lantern) is heavy on
    // WebGPU's hard 16 inter-stage-variable cap. Like the vessel (VesselService.registerMeshesForRendering),
    // cast shadows (depth-only, cheap) but DON'T receive them, drop fog, and exclude from the SSAO/DoF
    // prePass — receiving shadows + the prePass G-buffer variant blow the budget and invalidate the
    // prePass + ocean-reflection render pipelines. Reflection (clip-plane variant) still fits once those
    // are shed.
    for (const m of pier.getChildMeshes(false)) {
      this.oceanService.addToRenderList(m, true);   // gated: distant piers drop out of the mirror
      this.sceneService.addGatedShadowCaster(m);    // gated: distant piers drop out of the shadow pass
      m.receiveShadows = false;
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
      // Above-water structure → skip the seabed-refraction RTT (cuts the heavy refraction frame).
      m.metadata = { ...(m.metadata ?? {}), excludeFromRefraction: true };

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
        if (mat instanceof PBRMaterial) {
          this.applyEnvReflection(mat);                       // pier iron fittings catch the sky (not black)
          if (isLantern) {
            mat.emissiveColor = new Color3(1.0, 0.66, 0.30);  // warm lantern
            mat.emissiveIntensity = 8;                        // strong so it reads at night
          }
        }
        // NOTE: we intentionally do NOT mat.freeze() here — a frozen material can skip per-frame light
        // binding, which would stop the moving pool light from re-lighting the deck. The static-mesh win
        // is freezeWorldMatrix() above; the per-material freeze is negligible and would break lighting.
      }
    }
    return parent;
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
    this.detachTownShadowCasters();   // pull town buildings out of the sun CSG
    this.squareLight?.dispose();
    this.squareLight = null;
    this.skyEnv = null;   // owned by the procedural sky; just drop our reference
    for (const node of this.townNodes.values()) node.dispose(false, false);   // keep shared container materials
    this.townNodes.clear();
    this.townLoading.clear();
    this._townShadowDisc?.dispose();   this._townShadowDisc = null;   // own disc + thin-instance buffer
    this._townShadowMat?.dispose(false, true); this._townShadowMat = null;   // own material + gradient texture
    this._townShadowProxyMat?.dispose(); this._townShadowProxyMat = null;    // shared box-proxy depth material
    this._blobTownId = null;
    for (const { plane } of this.townLabels.values()) plane.dispose(false, true);   // own texture+material
    this.townLabels.clear();
    for (const m of this.impostorMeshes) { m.material?.dispose(true, true); m.dispose(); }   // own texture+material
    this.impostorMeshes = [];
    // Pier nodes die with root below (the scene teardown also disposes the shadow/reflection/glow
    // lists they were registered in) — just drop the refs.
    this.pierNodes.clear();
    this.pierLoading.clear();
    this.squareMat?.dispose(false, true); this.squareMat = null;   // shared ground mats + their procedural textures
    this.roadMat?.dispose(false, true);   this.roadMat = null;
    this.root?.dispose(false, false);
    this.root = null;
    this.harbors = [];
    this.dockable.set(null);
    this.seawardOffset.clear();
    this.frozenMats.clear();
  }
}
