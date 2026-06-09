import { Injectable, inject, signal } from '@angular/core';
import { TransformNode, Vector3, Mesh, Material, Scene, PBRMaterial, Color3, PointLight, Observer,
  StandardMaterial, DynamicTexture, VertexData, Texture } from '@babylonjs/core';
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
  private frame = 0;

  // Town-building STREAMING: a town's buildings are instantiated only while the player is within
  // BUILD_RANGE and disposed once past DROP_RANGE (towns are ≥1.7 km apart, so ~0–1 are active → ~10
  // resident meshes instead of 360). townNodes = built town id → its root; townLoading guards in-flight
  // async builds against the per-frame scan re-triggering.
  private readonly townNodes = new Map<string, TransformNode>();
  private readonly townLoading = new Set<string>();
  // Shared ground materials (procedural cobblestone for the square, dirt for the roads) — built once.
  private squareMat: StandardMaterial | null = null;
  private roadMat: StandardMaterial | null = null;
  private readonly BUILD_RANGE = 1500;
  private readonly DROP_RANGE = 1900;
  private readonly STREAM_BUILDINGS = true;
  // Dock when the hull is within ~20 ft (≈6 m) of the pier DECK EDGE (not the shore point — the pier
  // blocks the centre from ever reaching the shore). Per-variant deck size (m): len = along-seaward
  // from the shore point, halfWidth = half the across-extent (matches the server pier-obstacles dims).
  private readonly DOCK_EDGE_M = 6;
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
    this.tickObs = scene.onBeforeRenderObservable.add(() => this.tick());
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

  /** Per-frame: keep the pool light on the nearest pier + dockable town (every frame), and stream town
   *  buildings in/out of range (a few times a second — instantiation is far too heavy to scan per frame). */
  private tick(): void {
    this.updateNearestPier();
    if ((this.frame++ % 20) === 0) this.streamTowns();
  }

  /** Instantiate the buildings of any town the player has come within BUILD_RANGE of; dispose those past
   *  DROP_RANGE. The hysteresis gap stops a town on the range boundary from thrashing in and out. */
  private streamTowns(): void {
    if (!this.STREAM_BUILDINGS) return;
    const p = this.vesselService.getPosition();
    const build2 = this.BUILD_RANGE * this.BUILD_RANGE, drop2 = this.DROP_RANGE * this.DROP_RANGE;
    for (const h of this.harbors) {
      if (!h.buildings || !h.buildings.length) continue;
      const d2 = (h.x - p.x) ** 2 + (h.z - p.z) ** 2;
      if (d2 < build2 && !this.townNodes.has(h.id) && !this.townLoading.has(h.id)) {
        this.townLoading.add(h.id);
        this.buildTown(h).then((node) => {
          if (node) this.townNodes.set(h.id, node);
          this.townLoading.delete(h.id);
        });
      } else if (d2 > drop2 && this.townNodes.has(h.id)) {
        // dispose meshes only, NOT materials/textures: they're shared (cloneMaterials=false) via the
        // asset-cache container and reused by every other town that streams the same GLB. Disposing them
        // here would leave later towns with null materials (white). The container owns them (clearCache).
        this.townNodes.get(h.id)!.dispose(false, false);
        this.townNodes.delete(h.id);
      }
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
    return root;
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
      mesh.isPickable = false; mesh.receiveShadows = false; mesh.freezeWorldMatrix();
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
      mesh.isPickable = false; mesh.receiveShadows = false; mesh.freezeWorldMatrix();
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
        }
      }
    }
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
    for (const node of this.townNodes.values()) node.dispose(false, false);   // keep shared container materials
    this.townNodes.clear();
    this.townLoading.clear();
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
