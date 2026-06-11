import { Injectable, inject } from '@angular/core';
import {
  AnimationGroup, Color3, Mesh, MorphTarget, Nullable, Observer, PBRMaterial,
  Quaternion, Scene, Texture, TransformNode, Vector3,
} from '@babylonjs/core';
import { Settings } from '../../app.settings';
import { VesselAssetCacheService } from './vessel-asset-cache.service';

/**
 * Animated pirate crew for vessel decks.
 *
 * One `pirate.glb` (9 clips, 24-joint rig) is loaded once via the shared
 * VesselAssetCacheService and instantiated per crew member. Each member is
 * randomized (skin / shirt / breeches / boots / headwear — 960 combos) from a
 * deterministic seed so every multiplayer client renders the same crew, then
 * driven by a tiny state machine over the ship's authored station/waypoint
 * graph (`crew_stations.<slug>.json`):
 *
 *   station(work loop) → dwell → walk(waypoint path) → next station → …
 *   plus optional ratline climbs (sloop), and Death/Dead for casualties.
 *
 * Members are parented INSIDE the ship's instantiated GLB root, so all
 * positions/headings live in raw GLB-local coordinates (the station JSONs'
 * space) and deck pitch/roll/handedness come along for free.
 */
@Injectable({ providedIn: 'root' })
export class CrewService {
  private assetCache = inject(VesselAssetCacheService);

  private readonly baseUrl = Settings.apiUrl + 'geometry/';
  /** filename → cached station-layout fetch. */
  private readonly layouts = new Map<string, Promise<CrewLayout>>();
  /** cached pirate manifest fetch. */
  private manifest: Promise<PirateManifest> | null = null;

  /** Crew GLB + companion files (served from /geometry/ like the vessels). */
  private static readonly GLB = 'pirate.glb';
  private static readonly MANIFEST = 'pirate.manifest.json';
  private static readonly LAYOUTS: Record<string, string> = {
    pinnace: 'crew_stations.pinnace.json',
    sloop:   'crew_stations.sloop.json',
  };
  private static readonly DEFAULT_COUNT: Record<string, number> = { pinnace: 4, sloop: 7 };

  /**
   * Spawn a crew on one vessel.
   *
   * @param slug     vessel rig slug ('sloop' | 'pinnace') — picks the station layout.
   * @param shipGlbRoot  the vessel's instantiated GLB root (rigged.root). Crew are
   *                 parented under it so station coordinates apply verbatim.
   * @param seed     deterministic look seed (same seed ⇒ same crew on every client).
   * @param count    crew size (default per ship class).
   * @returns a handle for casualties/disposal, or null if assets failed to load.
   */
  async attach(
    slug: string, shipGlbRoot: TransformNode, scene: Scene, seed: number, count?: number,
  ): Promise<CrewHandle | null> {
    const layoutFile = CrewService.LAYOUTS[slug];
    if (!layoutFile) return null;
    try {
      const [layout, manifest] = await Promise.all([
        this.loadLayout(layoutFile), this.loadManifest(),
      ]);
      if (shipGlbRoot.isDisposed()) return null;
      const n = Math.min(count ?? CrewService.DEFAULT_COUNT[slug] ?? 5, layout.stations.length);
      const handle = new CrewHandle(scene, shipGlbRoot, layout, manifest, this.baseUrl, seed);
      for (let i = 0; i < n; i++) {
        const rigged = await this.assetCache.instantiateRigged(CrewService.GLB, scene, shipGlbRoot, false);
        if (!rigged || shipGlbRoot.isDisposed()) break;
        handle.addMember(rigged.root, rigged.entries.animationGroups, i);
      }
      handle.start();
      return handle;
    } catch (err) {
      console.warn('[Crew] attach failed for', slug, err);
      return null;
    }
  }

  private loadLayout(filename: string): Promise<CrewLayout> {
    let pending = this.layouts.get(filename);
    if (!pending) {
      pending = fetch(this.baseUrl + filename)
        .then((r) => { if (!r.ok) throw new Error(`${filename}: HTTP ${r.status}`); return r.json(); })
        .catch((err) => { this.layouts.delete(filename); throw err; });
      this.layouts.set(filename, pending);
    }
    return pending;
  }

  private loadManifest(): Promise<PirateManifest> {
    if (!this.manifest) {
      this.manifest = fetch(this.baseUrl + CrewService.MANIFEST)
        .then((r) => { if (!r.ok) throw new Error(`pirate manifest: HTTP ${r.status}`); return r.json(); })
        .catch((err) => { this.manifest = null; throw err; });
    }
    return this.manifest;
  }
}

/** Deterministic 32-bit PRNG (mulberry32) — keeps crew looks identical across clients. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → crew seed from a player id/callsign. */
export function crewSeedFrom(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// ── station layout + manifest typings (the authored JSON companions) ─────────
interface CrewLayout {
  waypoints: Record<string, [number, number, number]>;
  edges: [string, string, { kind?: string }][];
  stations: CrewStation[];
  climb_paths?: CrewClimb[];
}
interface CrewStation {
  id: string; kind: string; pos: [number, number, number];
  heading_deg: number; clip: string; wp: string;
}
interface CrewClimb {
  id: string; clip: string; approach_wp: string; polyline: [number, number, number][];
}
interface PirateManifest {
  constants: Record<string, number>;
  variants: {
    skin: { options: Record<string, { texture: string }> };
    shirt: { options: Record<string, [number, number, number]> };
    breeches: { options: Record<string, [number, number, number]>;
                linked_slot: { factor: number } };
    boots: { options: Record<string, [number, number, number]> };
    headwear: { nodes: string[] };
  };
}

// ── per-ship crew runtime ────────────────────────────────────────────────────
type CrewState = 'station' | 'walk' | 'climb' | 'dead';

interface PathLeg { to: Vector3; kind: string; }

/** Facial morph-target driver state (blink + slow expression drift). */
interface CrewFace {
  targets: Map<string, MorphTarget>;   // Blink / BrowsUp / Frown / Smile
  nextBlink: number;                   // seconds until the next blink starts
  blinkT: number;                      // >0 while a blink envelope is playing
  exprTimer: number;                   // seconds until the next expression change
  cur: Record<string, number>;         // eased current weights
  tgt: Record<string, number>;         // target weights
}

interface CrewMember {
  holder: TransformNode;          // wrapper we move/yaw (GLB root stays untouched inside)
  clips: Map<string, AnimationGroup>;
  current: Nullable<AnimationGroup>;
  face: CrewFace | null;
  state: CrewState;
  stationId: string | null;       // reserved station while at/walking to it
  wpId: string;                   // last waypoint id (graph anchor)
  dwell: number;
  legs: PathLeg[];                // remaining walk legs
  legT: number;                   // 0..1 along current leg
  legFrom: Vector3;
  yaw: number; yawTarget: number;
  climb: { path: Vector3[]; seg: number; t: number; dir: 1 | -1; pause: number } | null;
  animSpeed: number;
  rng: () => number;
}

export class CrewHandle {
  private members: CrewMember[] = [];
  private reserved = new Set<string>();
  private climbBusy = false;
  /** The one member currently allowed on the walkways — keeps crew from
   *  threading the same narrow path (and colliding) simultaneously. */
  private walker: CrewMember | null = null;
  private observer: Nullable<Observer<Scene>> = null;
  private readonly adjacency = new Map<string, { to: string; kind: string }[]>();
  private readonly walkSpeed: number;
  private disposed = false;
  private readonly texCache = new Map<string, Texture>();
  private readonly clonedMats: PBRMaterial[] = [];
  private readonly rootRng: () => number;

  constructor(
    private scene: Scene,
    private shipRoot: TransformNode,
    private layout: CrewLayout,
    private manifest: PirateManifest,
    private baseUrl: string,
    seed: number,
  ) {
    this.rootRng = mulberry32(seed);
    this.walkSpeed = manifest.constants?.['walk_speed_mps'] ?? 1.2;
    for (const [a, b, meta] of layout.edges) {
      const kind = meta?.kind ?? 'walk';
      (this.adjacency.get(a) ?? this.adjacency.set(a, []).get(a)!).push({ to: b, kind });
      (this.adjacency.get(b) ?? this.adjacency.set(b, []).get(b)!).push({ to: a, kind });
    }
  }

  /** Build one crew member from an instantiated pirate GLB. */
  addMember(glbRoot: TransformNode, groups: AnimationGroup[], index: number): void {
    const rng = mulberry32((Math.floor(this.rootRng() * 0xffffffff) ^ (index * 0x9e3779b9)) >>> 0);

    // Wrapper node: we position/rotate this, leaving the GLB root's importer
    // transform (handedness conversion) intact underneath.
    const holder = new TransformNode(`crew_${index}`, this.scene);
    holder.parent = this.shipRoot;
    holder.rotationQuaternion = Quaternion.Identity();
    glbRoot.parent = holder;

    const clips = new Map<string, AnimationGroup>();
    for (const g of groups) { g.stop(); clips.set(g.name.replace(/\.\d{3,}$/, ''), g); }

    this.applyVariants(glbRoot, rng);

    // Facial morph targets (Blink/BrowsUp/Frown/Smile) live on the body mesh.
    let face: CrewFace | null = null;
    const human = glbRoot.getChildMeshes(false)
      .find((mesh) => mesh.name === 'Human' || mesh.name.endsWith('.Human')) as Mesh | undefined;
    const mgr = human?.morphTargetManager;
    if (mgr && mgr.numTargets > 0) {
      const targets = new Map<string, MorphTarget>();
      for (let t = 0; t < mgr.numTargets; t++) {
        const target = mgr.getTarget(t);
        targets.set(target.name, target);
      }
      face = {
        targets, nextBlink: 1 + rng() * 4, blinkT: 0,
        exprTimer: 5 + rng() * 20,
        cur: { BrowsUp: 0, Frown: 0, Smile: 0 },
        tgt: { BrowsUp: 0, Frown: 0, Smile: 0 },
      };
    }

    const member: CrewMember = {
      holder, clips, current: null, face, state: 'station', stationId: null,
      wpId: Object.keys(this.layout.waypoints)[0], dwell: 2 + rng() * 6,
      legs: [], legT: 0, legFrom: new Vector3(), yaw: 0, yawTarget: 0,
      climb: null, animSpeed: 0.92 + rng() * 0.16, rng,
    };

    // Spawn directly at a free station (no walk-in pop).
    const st = this.pickStation(member);
    if (st) this.arriveAt(member, st, true);
    this.members.push(member);
  }

  /** Seeded look: skin texture, garment tints, headwear visibility. */
  private applyVariants(glbRoot: TransformNode, rng: () => number): void {
    const v = this.manifest.variants;
    const meshes = glbRoot.getChildMeshes(false);
    const find = (name: string) =>
      meshes.find((m) => m.name === name || m.name.endsWith('.' + name) || m.name.replace(/\.\d{3,}$/, '') === name);
    const pick = <T>(obj: Record<string, T>): T => {
      const keys = Object.keys(obj);
      return obj[keys[Math.floor(rng() * keys.length)]];
    };
    const tint = (meshName: string, rgb: [number, number, number], scale = 1) => {
      const mesh = find(meshName);
      if (!mesh || !(mesh.material instanceof PBRMaterial)) return;
      const mat = mesh.material.clone(`${mesh.material.name}_${this.clonedMats.length}`);
      mat.albedoColor = new Color3(rgb[0] * scale, rgb[1] * scale, rgb[2] * scale);
      mesh.material = mat;
      this.clonedMats.push(mat);
    };

    // Skin: swap the baked albedo texture (4 variants ship beside the GLB).
    const skin = pick(v.skin.options);
    const human = find('Human');
    if (human && human.material instanceof PBRMaterial) {
      const mat = human.material.clone(`skin_${this.clonedMats.length}`);
      let tex = this.texCache.get(skin.texture);
      if (!tex) {
        // invertY=false to match glTF UV convention of the baked PNGs.
        tex = new Texture(this.baseUrl + skin.texture, this.scene, undefined, false);
        this.texCache.set(skin.texture, tex);
      }
      mat.albedoTexture = tex;
      human.material = mat;
      this.clonedMats.push(mat);
    }

    tint('Shirt', pick(v.shirt.options));
    const briches = pick(v.breeches.options);
    tint('Breeches', briches);
    tint('Breeches_fall', briches, v.breeches.linked_slot?.factor ?? 0.75);
    tint('Boots', pick(v.boots.options));

    // Headwear: show at most one of the four (or bareheaded).
    const hats = v.headwear.nodes;
    const choice = Math.floor(rng() * (hats.length + 1));   // == hats.length ⇒ none
    hats.forEach((hat, i) => {
      const mesh = find(hat);
      mesh?.setEnabled(i === choice);
    });
  }

  start(): void {
    this.observer = this.scene.onBeforeRenderObservable.add(() => {
      if (this.shipRoot.isDisposed()) { this.dispose(); return; }
      const dt = Math.min(0.05, this.scene.getEngine().getDeltaTime() / 1000);
      for (const m of this.members) this.tick(m, dt);
    });
  }

  /** Mark one (random alive) crew member as a casualty: stagger, fall, stay down. */
  killOne(): boolean {
    const alive = this.members.filter((m) => m.state !== 'dead');
    if (!alive.length) return false;
    const m = alive[Math.floor(Math.random() * alive.length)];
    if (m.state === 'climb' && m.climb) {
      // Drop to the climb base — no mid-air corpses on the ratlines.
      const base = m.climb.path[0];
      m.holder.position.copyFrom(base);
    }
    const mm = m as CrewMember & { _climb?: CrewClimb | null };
    if (m.state === 'climb' || mm._climb) this.climbBusy = false;   // free the ratlines
    if (this.walker === m) this.walker = null;                      // free the walkways
    mm._climb = null;
    this.releaseStation(m);
    m.state = 'dead'; m.legs = []; m.climb = null;
    const death = this.play(m, 'Death', false);
    death?.onAnimationGroupEndObservable.addOnce(() => {
      if (!this.disposed && m.state === 'dead') this.play(m, 'Dead', true);
    });
    return true;
  }

  /** Bring all casualties back to work (post-battle reset). */
  reviveAll(): void {
    for (const m of this.members) {
      if (m.state !== 'dead') continue;
      m.state = 'station';
      const st = this.pickStation(m);
      if (st) this.arriveAt(m, st, true);
    }
  }

  get aliveCount(): number { return this.members.filter((m) => m.state !== 'dead').length; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer) { this.scene.onBeforeRenderObservable.remove(this.observer); this.observer = null; }
    for (const m of this.members) m.holder.dispose();   // disposes pirate subtree
    for (const mat of this.clonedMats) mat.dispose();
    for (const tex of this.texCache.values()) tex.dispose();   // per-handle skin albedos
    this.texCache.clear();
    this.members = [];
  }

  /** Blink envelope + slow, subtle expression drift. Dead crew keep eyes shut. */
  private tickFace(m: CrewMember, dt: number): void {
    const f = m.face;
    if (!f) return;
    const set = (name: string, w: number) => { const t = f.targets.get(name); if (t) t.influence = w; };
    if (m.state === 'dead') {
      set('Blink', 1); set('BrowsUp', 0); set('Frown', 0.3); set('Smile', 0);
      return;
    }
    // Blink: ~0.18s sinusoidal close/open every few seconds.
    let blink = 0;
    if (f.blinkT > 0) {
      f.blinkT -= dt;
      blink = Math.sin(Math.PI * Math.max(0, 1 - f.blinkT / 0.18));
    } else {
      f.nextBlink -= dt;
      if (f.nextBlink <= 0) { f.blinkT = 0.18; f.nextBlink = 2.5 + m.rng() * 5; }
    }
    set('Blink', blink);
    // Expression drift: mostly neutral, occasionally a mild brow/smile/frown.
    f.exprTimer -= dt;
    if (f.exprTimer <= 0) {
      f.exprTimer = 12 + m.rng() * 28;
      f.tgt['BrowsUp'] = 0; f.tgt['Frown'] = 0; f.tgt['Smile'] = 0;
      const roll = m.rng();
      if (roll > 0.55) {
        const which = roll > 0.85 ? 'Smile' : roll > 0.70 ? 'Frown' : 'BrowsUp';
        f.tgt[which] = 0.15 + m.rng() * 0.3;   // subtle — working sailors, not actors
      }
    }
    for (const k of Object.keys(f.cur)) {
      f.cur[k] += (f.tgt[k] - f.cur[k]) * Math.min(1, dt * 2.5);
      set(k, f.cur[k]);
    }
  }

  // ── per-member state machine ────────────────────────────────────────────────
  private tick(m: CrewMember, dt: number): void {
    this.tickFace(m, dt);
    // Smooth yaw toward target everywhere except while dead.
    if (m.state !== 'dead') {
      let d = m.yawTarget - m.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      m.yaw += d * Math.min(1, dt * 8);
      Quaternion.RotationAxisToRef(Vector3.Up(), m.yaw, m.holder.rotationQuaternion!);
    }

    switch (m.state) {
      case 'station': {
        m.dwell -= dt;
        if (m.dwell > 0) return;
        // Walkways are single-occupancy: if someone else is on the move, keep
        // working a little longer and check again shortly.
        if (this.walker) { m.dwell = 4 + m.rng() * 6; return; }
        // Occasionally go aloft (one climber at a time), otherwise change station.
        if (!this.climbBusy && (this.layout.climb_paths?.length ?? 0) > 0 && m.rng() < 0.08) {
          const climb = this.layout.climb_paths![Math.floor(m.rng() * this.layout.climb_paths!.length)];
          this.beginWalk(m, climb.approach_wp, null, climb);
        } else {
          const st = this.pickStation(m, true);
          if (st) this.beginWalk(m, st.wp, st);
          else m.dwell = 10 + m.rng() * 15;   // nowhere free — keep working here
        }
        return;
      }
      case 'walk': this.tickWalk(m, dt); return;
      case 'climb': this.tickClimb(m, dt); return;
      case 'dead': return;
    }
  }

  private tickWalk(m: CrewMember, dt: number): void {
    const leg = m.legs[0];
    if (!leg) { this.finishWalk(m); return; }
    const span = Vector3.Distance(m.legFrom, leg.to);
    const speed = leg.kind === 'squeeze' ? this.walkSpeed * 0.4
      : leg.kind === 'ladder' ? 0.5
      : leg.kind === 'step' ? this.walkSpeed * 0.6
      : leg.kind === 'step_over' ? this.walkSpeed * 0.75
      : this.walkSpeed;
    m.legT = span > 1e-4 ? Math.min(1, m.legT + (speed * dt) / span) : 1;
    Vector3.LerpToRef(m.legFrom, leg.to, m.legT, m.holder.position);
    if (leg.kind === 'step_over') {
      m.holder.position.y += 0.45 * Math.sin(Math.PI * m.legT);   // arc over the thwart
    }
    // Face travel direction (horizontal component only — ladders keep prior yaw).
    const dx = leg.to.x - m.legFrom.x, dz = leg.to.z - m.legFrom.z;
    if (dx * dx + dz * dz > 0.01) m.yawTarget = Math.atan2(dx, dz);
    if (m.legT >= 1) {
      m.legFrom.copyFrom(leg.to);
      m.legs.shift();
      m.legT = 0;
      const next = m.legs[0];
      if (!next) { this.finishWalk(m); return; }
      // Ladder legs play the climb loop, everything else walks.
      this.play(m, next.kind === 'ladder' ? 'Climb' : 'Walk', true);
    }
  }

  private finishWalk(m: CrewMember): void {
    if (this.walker === m) this.walker = null;   // free the walkways
    const target = (m as CrewMember & { _target?: CrewStation | null })._target;
    const climb = (m as CrewMember & { _climb?: CrewClimb | null })._climb;
    if (climb) {
      m.state = 'climb';
      m.climb = {
        path: climb.polyline.map((p) => new Vector3(p[0], p[1], p[2])),
        seg: 0, t: 0, dir: 1, pause: 0,
      };
      m.holder.position.copyFrom(m.climb.path[0]);
      this.play(m, 'Climb', true);
      return;
    }
    if (target) { this.arriveAt(m, target, false); return; }
    // No explicit target (shouldn't happen): idle in place.
    m.state = 'station'; m.dwell = 5; this.play(m, 'Idle', true);
  }

  private tickClimb(m: CrewMember, dt: number): void {
    const c = m.climb!;
    if (c.pause > 0) {
      c.pause -= dt;
      if (c.pause <= 0) { c.dir = -1; m.current?.play(true); }   // resume, head down
      return;
    }
    const speed = 0.45;
    const a = c.path[c.seg], b = c.path[c.seg + 1];
    const span = Vector3.Distance(a, b);
    c.t += (speed * dt) / Math.max(span, 1e-4) * c.dir;
    if (c.t >= 1 || c.t < 0) {
      c.seg += c.dir;
      c.t = c.t >= 1 ? 0 : 1;
      if (c.dir > 0 && c.seg >= c.path.length - 1) {
        // Reached the masthead: hang on for a few seconds (anim paused mid-cycle).
        c.seg = c.path.length - 2; c.t = 1;
        c.pause = 3 + m.rng() * 5;
        m.current?.pause();
        return;
      }
      if (c.dir < 0 && c.seg < 0) {
        // Back on deck: release the ratlines, find a station.
        m.climb = null; this.climbBusy = false;
        m.state = 'station'; m.dwell = 0.5;
        this.play(m, 'Idle', true);
        return;
      }
    }
    const p0 = c.path[c.seg], p1 = c.path[c.seg + 1];
    Vector3.LerpToRef(p0, p1, c.t, m.holder.position);
    // Face inboard along the ratline slope (horizontal heading of the segment).
    const dx = (p1.x - p0.x) * c.dir, dz = (p1.z - p0.z) * c.dir;
    if (dx * dx + dz * dz > 1e-4) m.yawTarget = Math.atan2(dx, dz);
  }

  // ── station + path helpers ─────────────────────────────────────────────────
  private pickStation(m: CrewMember, excludeCurrent = false): CrewStation | null {
    const free = this.layout.stations.filter((s) =>
      !this.reserved.has(s.id) && (!excludeCurrent || s.id !== m.stationId));
    if (!free.length) return null;
    return free[Math.floor(m.rng() * free.length)];
  }

  private releaseStation(m: CrewMember): void {
    if (m.stationId) { this.reserved.delete(m.stationId); m.stationId = null; }
  }

  private arriveAt(m: CrewMember, st: CrewStation, teleport: boolean): void {
    if (m.stationId && m.stationId !== st.id) this.releaseStation(m);
    this.reserved.add(st.id);
    m.stationId = st.id;
    m.wpId = st.wp;
    m.state = 'station';
    // Long task dwell — crew settle into a job and only occasionally rotate.
    m.dwell = 45 + m.rng() * 75;
    m.yawTarget = (st.heading_deg * Math.PI) / 180;
    if (teleport) {
      m.holder.position.set(st.pos[0], st.pos[1], st.pos[2]);
      m.yaw = m.yawTarget;
      Quaternion.RotationAxisToRef(Vector3.Up(), m.yaw, m.holder.rotationQuaternion!);
    }
    (m as CrewMember & { _target?: CrewStation | null })._target = null;
    (m as CrewMember & { _climb?: CrewClimb | null })._climb = null;
    this.play(m, st.clip, true);
  }

  /** Queue a waypoint walk from the member's current anchor to `goalWp`
   *  (then on to the station position / climb base). */
  private beginWalk(m: CrewMember, goalWp: string, target: CrewStation | null, climb: CrewClimb | null = null): void {
    this.releaseStation(m);
    // Reserve the destination immediately so two walkers can't race for one station.
    if (target) { this.reserved.add(target.id); m.stationId = target.id; }
    const ids = this.bfs(m.wpId, goalWp);
    const wps = this.layout.waypoints;
    m.legs = [];
    m.legFrom.copyFrom(m.holder.position);
    let prev = m.wpId;
    for (const id of ids) {
      const kind = this.edgeKind(prev, id);
      const p = wps[id];
      m.legs.push({ to: new Vector3(p[0], p[1], p[2]), kind });
      prev = id;
    }
    if (target) m.legs.push({ to: new Vector3(target.pos[0], target.pos[1], target.pos[2]), kind: 'walk' });
    if (climb) m.legs.push({ to: new Vector3(climb.polyline[0][0], climb.polyline[0][1], climb.polyline[0][2]), kind: 'walk' });
    m.wpId = goalWp;
    (m as CrewMember & { _target?: CrewStation | null })._target = target;
    (m as CrewMember & { _climb?: CrewClimb | null })._climb = climb;
    if (climb) this.climbBusy = true;
    this.walker = m;   // single-occupancy walkways
    m.state = 'walk';
    m.legT = 0;
    this.play(m, m.legs[0]?.kind === 'ladder' ? 'Climb' : 'Walk', true);
  }

  /** Shortest hop path between waypoints (graphs are <20 nodes — BFS is plenty). */
  private bfs(from: string, to: string): string[] {
    if (from === to) return [];
    const prev = new Map<string, string>();
    const q = [from];
    prev.set(from, '');
    while (q.length) {
      const cur = q.shift()!;
      if (cur === to) break;
      for (const e of this.adjacency.get(cur) ?? []) {
        if (!prev.has(e.to)) { prev.set(e.to, cur); q.push(e.to); }
      }
    }
    if (!prev.has(to)) return [to];   // disconnected (bad data) — beeline as fallback
    const path: string[] = [];
    for (let cur = to; cur !== from; cur = prev.get(cur)!) path.unshift(cur);
    return path;
  }

  private edgeKind(a: string, b: string): string {
    for (const e of this.adjacency.get(a) ?? []) if (e.to === b) return e.kind;
    return 'walk';
  }

  /** Switch the member's looping clip (exact name from the manifest/clip set). */
  private play(m: CrewMember, name: string, loop: boolean): Nullable<AnimationGroup> {
    const g = m.clips.get(name) ?? null;
    if (!g) return null;
    if (m.current === g && loop) return g;
    m.current?.stop();
    g.start(loop, m.animSpeed);
    if (loop && (name === 'Idle' || name === 'Walk')) {
      // Desync loops so the crew don't move in lockstep.
      g.goToFrame(g.from + m.rng() * (g.to - g.from));
    }
    m.current = g;
    return g;
  }
}
