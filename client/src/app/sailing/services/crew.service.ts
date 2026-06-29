import { Injectable, inject } from '@angular/core';
import {
  AbstractMesh, AnimationGroup, Bone, BoneIKController, Color3, Mesh, MorphTarget, MorphTargetManager, Node,
  Nullable, Observer, PBRMaterial, Quaternion, Ray, Scene, Skeleton, Texture, TransformNode, Vector3,
} from '@babylonjs/core';
import { Settings } from '../../app.settings';
import { VesselAssetCacheService } from './vessel-asset-cache.service';

// ── Ship-motion presence (crew realism P1) ───────────────────────────────────────────────────────────────────
const BRACE_FACTOR = 0.55;   // crew counter-lean this fraction of the deck slope (0 = ride flat with the deck,
                             // 1 = bolt upright). ~0.55 reads as bracing without looking detached from the deck.
const BRACE_MAX    = 0.45;   // rad cap on the brace lean (a hard knockdown won't over-rotate them)
const SWAY_AMP     = 0.03;   // m — idle weight-shift sway at a station (desynced per member)
const HEEL_SHIFT   = 0.05;   // m of lateral weight-shift per rad of heel (leaning onto the downhill foot)
// ALWAYS-ON idle life so the crew never read as statues even in flat calm (the brace alone only moves them when
// the deck actually heels). A slow, desynced weight-shift LEAN (the head visibly sways) + a breathing bob.
const IDLE_LEAN_AMP  = 0.06;   // rad (~3.4°) idle side-to-side weight-shift lean — the main "alive" cue
const IDLE_PITCH_AMP = 0.03;   // rad fore-aft idle lean (smaller)
const IDLE_BOB       = 0.013;  // m vertical breathing bob
// Default resting hand: drive the 'Relaxed' grip morph so idle fingers are naturally curled, not ramrod-straight.
// (Track A's IK will later modulate hands toward the 'Grip' morph at rope/cannon stations.)
const HAND_RELAX = 0.8;
// Locomotion (P2): scale the Walk clip's playback to the actual ground speed so the FEET PLANT instead of
// skating. STRIDE_SCALE matches the clip's authored stride to walk_speed_mps — tune live via
// localStorage.ignis_crew_stride if a footskate remains. TURN_SLOW slows forward progress while turning sharply
// so they rotate INTO a corner rather than sliding through it.
const STRIDE_SCALE = (() => {
  try { const v = parseFloat(localStorage.getItem('ignis_crew_stride') || ''); return Number.isFinite(v) && v > 0 ? v : 1.0; }
  catch { return 1.0; }
})();
// Life + combat sync (P3).
const WORK_BURST_DUR  = 1.4;   // s a gun crew works visibly harder after their broadside fires
const WORK_BURST_GAIN = 1.1;   // peak extra work-clip speed (×) at the moment of firing
const GLANCE_CHANCE   = 0.02;  // per-second chance a stationed crew breaks off to glance about

// ── Environmental grip IK (crew realism v2, track A1+A2) ─────────────────────────────────────────────────────
// Make working hands actually REACH their station instead of miming in the air. Post-clip 2-bone arm IK
// (UpperArm→Forearm→Hand) plants each Hand on a grip point in front of the station, and the GLB's `Grip` shape
// key closes the fingers (fading the idle `Relaxed` curl). PLAYER-DECK ONLY: gated to crew near the camera
// (which only the player's own ship ever is) — remote/NPC crew keep the canned clips, so the cost stays tiny.
// Opt-out `localStorage.ignis_crew_ik='0'`; the geometry knobs below are all live-tunable for one calibration pass.
const IK_ENABLED   = (() => { try { return (localStorage.getItem('ignis_crew_ik') ?? '1') !== '0'; } catch { return true; } })();
const IK_GATE_NEAR = 16;    // m — build + run IK for crew within this of the camera
const IK_GATE_FAR  = 22;    // m — tear down beyond this (hysteresis band avoids edge flap)
const GRIP_W       = 0.85;  // `Grip` morph influence while a hand is working a station
const GRIP_EASE    = 5.0;   // per-second ease rate for the Grip↔Relaxed hand blend
const IK_SLERP     = 0.35;  // BoneIKController slerp — eases toward the solution so a slightly-off calib drifts, not snaps
// Elbow bend axis + pole angle (rig-dependent → live-tunable). If forearms bend the wrong way, set
// `ignis_crew_ik_bend`="x,y,z" and/or `ignis_crew_ik_pole`=<radians>.
const IK_BEND = (() => {
  try { const p = (localStorage.getItem('ignis_crew_ik_bend') || '').split(',').map(Number);
        if (p.length === 3 && p.every(Number.isFinite)) return new Vector3(p[0], p[1], p[2]); } catch { /* */ }
  return new Vector3(0, 0, 1);
})();
const IK_POLE = (() => { try { const v = parseFloat(localStorage.getItem('ignis_crew_ik_pole') || ''); return Number.isFinite(v) ? v : 0; } catch { return 0; } })();
// Grip-point geometry per work clip, in the member's station frame (fwd = along heading, up = +Y, lat = half-spread
// to each hand). Ship-FIXED (computed from the authored station pos+heading), so hands stay on the work while the
// body micro-sways around them. Cannon = both hands low-forward on the carriage; Ropes = hand-over-hand haul.
const GRIP_CANNON = { fwd: 0.40, up: 0.74, lat: 0.16 };
const GRIP_ROPES  = { fwd: 0.30, up: 1.30, lat: 0.10, haulAmp: 0.16, haulRate: 2.2 };

// Per-hat FIT corrections (runtime). World-space terms: lower = m DOWN onto the head, fwd = m toward the face,
// scale = uniform. Live-tunable per hat via localStorage ignis_hat_<name> = "lower,fwd,scale".
// All 4 hats now fit on their own in the GLB MESH (2026-06-28 — the 3 brimmed hats reseated; the skullcap's mesh
// already seats snug crown-to-brow), so EVERY hat is at identity here — a runtime nudge now DOUBLE-corrects (the
// skullcap was sliding down onto the face). Kept the table + live `ignis_hat_<name>` override for future tweaks.
const HAT_FIT: Record<string, { lower: number; fwd: number; scale: number }> = {
  Hat_Tricorn:  { lower: 0.000, fwd: 0.000, scale: 1.00 },   // mesh fits — identity
  Hat_WideBrim: { lower: 0.000, fwd: 0.000, scale: 1.00 },   // mesh reseated — identity (was 0.035/0/1.12)
  Hat_Bicorne:  { lower: 0.000, fwd: 0.000, scale: 1.00 },   // mesh reseated — identity (was 0.025/0/1.00)
  Skullcap:     { lower: 0.000, fwd: 0.000, scale: 1.00 },   // mesh fits crown-to-brow — identity (was 0.035/0.025: shoved it onto the face)
};

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
    pinnace:     'crew_stations.pinnace.json',
    sloop:       'crew_stations.sloop.json',
    brig:        'crew_stations.brig.json',
    merchantman: 'crew_stations.merchantman.json',
  };
  private static readonly DEFAULT_COUNT: Record<string, number> = { pinnace: 4, sloop: 7, brig: 12, merchantman: 9 };

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
        handle.addMember(rigged.root, rigged.entries.animationGroups, i, rigged.entries.skeletons);
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
  /** Which local axis is the BEAM (across-ship, the rail-proxy for idle-sway damping). Default 'x' (bow=+Z
   *  ships like the sloop/brig). The merchantman is authored in its GLB-native frame (bow=+X), so its beam is
   *  'z'. */
  beam_axis?: 'x' | 'z';
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
type CrewState = 'station' | 'walk' | 'climb' | 'dead' | 'reserve';

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
  detail: AbstractMesh[];   // tiny parts (buckles/eyes/laces/…) culled when the member is far
  lodFar: boolean;          // true while the detail meshes are hidden (distance LOD)
  // Ship-motion presence (P1): a desynced idle sway + the station anchor it sways around.
  swayPhase: number;
  swayFreq: number;
  stationPos: Vector3;      // the exact station position; sway is a small offset from this
  // Life + combat sync (P3).
  stationClip: string;      // the looping work clip for the current station (to resume after a glance)
  workBurst: number;        // >0 → working harder (e.g. the gun crew right after a broadside); decays
  glanceT: number;          // >0 → briefly broke off work to glance about (Lookout), then resumes
  // Environmental grip IK (track A). Built lazily the first time the member is near the camera.
  skeleton: Skeleton | null;   // this member's cloned 24-joint rig (arm bones live here)
  bodyMesh: AbstractMesh | null; // the skinned 'Human' mesh (BoneIKController world-space anchor)
  ik: CrewIK | null;           // arm-IK controllers + grip-target nodes (null until built)
  ikActive: boolean;           // true while IK is steering the hands this frame
  ikGrip: number;              // eased Grip-morph influence (0 relaxed → GRIP_W gripping)
}

/** Per-member arm-IK rig: a BoneIKController per arm + the (invisible) grip-target / elbow-pole anchor nodes. */
interface CrewIK {
  ctrlL: BoneIKController | null; ctrlR: BoneIKController | null;
  tgtL: Mesh; tgtR: Mesh;       // where each Hand should reach (ship-space, parented under the ship root)
  poleL: Mesh; poleR: Mesh;     // elbow pole targets (steer the elbow direction)
  haulPhase: number;            // hand-over-hand phase for rope-hauling
}

export class CrewHandle {
  private members: CrewMember[] = [];
  private reserved = new Set<string>();
  private climbBusy = false;
  /** Members currently on the move. Capped (not single) so the deck feels busy — a couple can walk at once —
   *  while still keeping the narrow walkways from turning into a crowd. Climbing has its own single-slot lock. */
  private readonly walkers = new Set<CrewMember>();
  private readonly WALKER_CAP = 2;
  private observer: Nullable<Observer<Scene>> = null;
  private readonly adjacency = new Map<string, { to: string; kind: string }[]>();
  private readonly walkSpeed: number;
  private disposed = false;
  private readonly texCache = new Map<string, Texture>();
  private readonly clonedMats: PBRMaterial[] = [];
  // Per-member cloned skeletons (each member is its own instantiateRigged → a cloned 24-joint rig, GPU-texture
  // backed on WebGPU). Disposing the mesh subtree does NOT free these, so they're collected + freed in dispose().
  private readonly skeletons: Skeleton[] = [];
  private readonly rootRng: () => number;
  // Ship-motion presence (P1): the deck's current heel/pitch (rad), recomputed each frame from the ship root's
  // world orientation, and a running clock for the idle sway. Crew counter-lean these so they ride the swell.
  private shipHeel = 0;
  private shipPitch = 0;
  private clock = 0;
  private maxStationX = 0;   // widest station |beam| (rail proxy) — damps idle motion for crew at the bulwarks
  private beamAxis: 'x' | 'z' = 'x';   // which local axis is across-ship (see CrewLayout.beam_axis)
  private deckMeshes: AbstractMesh[] | null = null;   // cached ship structural meshes to raycast feet onto
  private readonly wpSnapCache = new Map<string, Vector3>();   // waypoint id → open-deck-snapped position (static)

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
    // The rail-most station's lateral offset — used to damp idle lean/sway for crew near a bulwark (P1 follow-up).
    this.beamAxis = layout.beam_axis === 'z' ? 'z' : 'x';
    const beamIdx = this.beamAxis === 'z' ? 2 : 0;
    for (const s of layout.stations) this.maxStationX = Math.max(this.maxStationX, Math.abs(s.pos[beamIdx]));
    for (const [a, b, meta] of layout.edges) {
      const kind = meta?.kind ?? 'walk';
      (this.adjacency.get(a) ?? this.adjacency.set(a, []).get(a)!).push({ to: b, kind });
      (this.adjacency.get(b) ?? this.adjacency.set(b, []).get(b)!).push({ to: a, kind });
    }
  }

  /** Build one crew member from an instantiated pirate GLB. */
  addMember(glbRoot: TransformNode, groups: AnimationGroup[], index: number, skeletons: Skeleton[] = []): void {
    const rng = mulberry32((Math.floor(this.rootRng() * 0xffffffff) ^ (index * 0x9e3779b9)) >>> 0);
    for (const sk of skeletons) { if (sk) this.skeletons.push(sk); }   // track for dispose (mesh dispose won't free it)

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
      // Idle hands rest gently curled (set once; tickFace only touches Blink/expressions, so it persists).
      const relax = targets.get('Relaxed');
      if (relax) { relax.influence = HAND_RELAX; }
    }

    // Distance-LOD: the tiny parts (buckles, eye globes, grommets, laces, cuffs, soles, fall flap)
    // are sub-pixel beyond a few dozen metres but cost a draw call each — cull them when the member
    // is far (other ships' crew), keeping just the silhouette (body/shirt/breeches/boots/hat). ~20→~5
    // draws per distant crew member; near crew (your own deck) stay full detail.
    const DETAIL = /^(BootBuckles|BootSideBuckles|BootCuff|BootSideStraps|BootStraps|BootSole|Breeches_buttons|Breeches_cuffs|Breeches_fall|Breeches_waistband|ShirtGrommets|ShirtLacing|Eyes)$/;
    // Strip the loader's `.NNN` dedup suffix AND the `_primitiveN` split that multi-material meshes get
    // (the 3-material Eyes mesh exports as Eyes_primitive0/1/2 — all three are detail).
    const baseName = (me: AbstractMesh) => me.name.replace(/\.\d{3,}$/, '').replace(/_primitive\d+$/, '');
    const detail = glbRoot.getChildMeshes(false).filter((me) => DETAIL.test(baseName(me)));

    const member: CrewMember = {
      holder, clips, current: null, face, state: 'station', stationId: null,
      wpId: Object.keys(this.layout.waypoints)[0], dwell: 2 + rng() * 6,
      legs: [], legT: 0, legFrom: new Vector3(), yaw: 0, yawTarget: 0,
      climb: null, animSpeed: 0.92 + rng() * 0.16, rng,
      detail, lodFar: false,
      swayPhase: rng() * Math.PI * 2, swayFreq: 0.7 + rng() * 0.5, stationPos: new Vector3(),
      stationClip: 'Idle', workBurst: 0, glanceT: 0,
      skeleton: skeletons.find((s) => s && s.bones?.length) ?? skeletons[0] ?? null,
      bodyMesh: human ?? null, ik: null, ikActive: false, ikGrip: 0,
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

    // Headwear: show at most one of the four (or bareheaded). The chosen hat then gets a per-hat FIT correction
    // (the GLB authored 3 of the 4 with one shared head offset, so most float/sit wrong — see HAT_FIT).
    const hats = v.headwear.nodes;
    const choice = Math.floor(rng() * (hats.length + 1));   // == hats.length ⇒ none
    hats.forEach((hat, i) => {
      const mesh = find(hat);
      if (!mesh) return;
      mesh.setEnabled(i === choice);
      if (i === choice) this.fitHat(hat, mesh);
    });
  }

  /** Nudge one hat so it seats on the head. The correction is given in intuitive WORLD terms — `lower` (metres
   *  down), `fwd` (metres toward the face), `scale` (uniform) — and converted into the hat's local frame via its
   *  parent (head-bone) inverse rotation, so it's right regardless of how the bone is oriented. Live-tunable per
   *  hat via localStorage `ignis_hat_<name>` = "lower,fwd,scale" (e.g. ignis_hat_Skullcap = "0.035,0.025,1.1"). */
  private fitHat(name: string, mesh: AbstractMesh): void {
    let fit = HAT_FIT[name] ?? { lower: 0, fwd: 0, scale: 1 };
    try {
      const raw = typeof localStorage !== 'undefined' && localStorage.getItem('ignis_hat_' + name);
      if (raw) {
        const [lower, fwd, scale] = raw.split(',').map((n) => parseFloat(n.trim()));
        if ([lower, fwd, scale].every(Number.isFinite)) fit = { lower, fwd, scale };
      }
    } catch { /* ignore */ }
    const parent = mesh.parent as TransformNode | null;
    // Convert a WORLD-space delta into the hat's local (parent) frame, so corrections are intuitive regardless
    // of how the head bone is oriented.
    const toLocal = (w: Vector3): Vector3 => {
      if (!parent) return w;
      parent.computeWorldMatrix(true);
      const inv = parent.getWorldMatrix().clone(); inv.invert();
      return Vector3.TransformNormal(w, inv);
    };
    // Scale about the hat's WORLD CENTRE (not its mesh pivot): a hat whose pivot sits away from the head — e.g.
    // the skullcap — would otherwise be flung up/down by scaling. Measure the centre, scale, undo the shift.
    if (fit.scale && fit.scale !== 1) {
      mesh.computeWorldMatrix(true);
      const before = mesh.getBoundingInfo().boundingBox.centerWorld.clone();
      mesh.scaling.scaleInPlace(fit.scale);
      mesh.computeWorldMatrix(true);
      const after = mesh.getBoundingInfo().boundingBox.centerWorld;
      mesh.position.addInPlace(toLocal(before.subtract(after)));
    }
    // Position nudge: down (−Y world) + toward the face (−Z world).
    if (fit.lower || fit.fwd) mesh.position.addInPlace(toLocal(new Vector3(0, -fit.lower, -fit.fwd)));
  }

  start(): void {
    this.observer = this.scene.onBeforeRenderObservable.add(() => {
      if (this.shipRoot.isDisposed()) { this.dispose(); return; }
      const dt = Math.min(0.05, this.scene.getEngine().getDeltaTime() / 1000);
      this.clock += dt;
      // Deck slope from the ship root's world orientation: how far its right/forward axes tip off level → the
      // heel (lateral) and pitch (fore-aft) the crew brace against. Works for the local ship + every remote.
      const wm = this.shipRoot.getWorldMatrix();
      const right = Vector3.TransformNormal(Vector3.Right(), wm);
      const fwd = Vector3.TransformNormal(Vector3.Forward(), wm);
      this.shipHeel  = Math.asin(Math.max(-1, Math.min(1, right.y / (right.length() || 1))));
      this.shipPitch = Math.asin(Math.max(-1, Math.min(1, fwd.y / (fwd.length() || 1))));
      for (const m of this.members) this.tick(m, dt);
    });
  }

  /** A broadside just fired on `side` — make the gun crews on that side work harder for a beat (P3). Gun station
   *  ids are `gun_P_*` (port) / `gun_S_*` (starboard); matches the crew_stations layouts. */
  emphasizeGun(side: 'port' | 'stbd'): void {
    const tag = side === 'port' ? 'gun_P' : 'gun_S';
    for (const m of this.members) {
      if (m.state === 'station' && m.stationId && m.stationId.startsWith(tag)) m.workBurst = WORK_BURST_DUR;
    }
  }

  /** Mark one (random alive) crew member as a casualty: stagger, fall, stay down. */
  killOne(): boolean {
    const alive = this.members.filter((m) => m.state !== 'dead' && m.state !== 'reserve');
    if (!alive.length) return false;
    const m = alive[Math.floor(Math.random() * alive.length)];
    if (m.state === 'climb' && m.climb) {
      // Drop to the climb base — no mid-air corpses on the ratlines.
      const base = m.climb.path[0];
      m.holder.position.copyFrom(base);
    }
    const mm = m as CrewMember & { _climb?: CrewClimb | null };
    if (m.state === 'climb' || mm._climb) this.climbBusy = false;   // free the ratlines
    this.walkers.delete(m);                      // free the walkways
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

  /** Bring ONE hand back to work (a fresh hire at the tavern, or a downed casualty). Returns false if the
   *  whole pool is already manning stations. Prefers an UNRECRUITED reserve (walks on fresh) over raising a
   *  fallen body, so a hire reads as a new sailor rather than a resurrection. */
  reviveOne(): boolean {
    const back = this.members.find((m) => m.state === 'reserve')
              ?? this.members.find((m) => m.state === 'dead');
    if (!back) return false;
    if (back.state === 'reserve') back.holder.setEnabled(true);
    back.state = 'station';
    const st = this.pickStation(back);
    if (st) this.arriveAt(back, st, true);
    return true;
  }

  /** Hide one member as UNRECRUITED reserve (invisible, off the stations) — used for the initial underfill so
   *  an under-crewed ship shows fewer hands, NOT a deck of corpses (only combat casualties lie dead). */
  private hideMember(m: CrewMember): void {
    const mm = m as CrewMember & { _climb?: CrewClimb | null };
    if (m.state === 'climb' || mm._climb) this.climbBusy = false;
    this.walkers.delete(m);
    mm._climb = null;
    this.releaseStation(m);
    m.state = 'reserve'; m.legs = []; m.climb = null;
    m.holder.setEnabled(false);
  }

  /** Drive the number of living crew to `target` (authoritative count from the server). The FIRST call is the
   *  initial fill: surplus spawned hands become invisible reserve (no corpses on a fresh deck). Later calls are
   *  live changes — grapeshot losses drop bodies (Death → Dead); tavern hires bring a hand back. */
  setAliveCount(target: number): void {
    const t = Math.max(0, Math.min(this.members.length, Math.round(target)));
    if (this.firstFill) {
      this.firstFill = false;
      for (let i = t; i < this.members.length; i++) this.hideMember(this.members[i]);
      return;
    }
    let alive = this.aliveCount;
    while (alive > t) { if (!this.killOne()) break; alive--; }
    while (alive < t) { if (!this.reviveOne()) break; alive++; }
  }
  private firstFill = true;

  get aliveCount(): number { return this.members.filter((m) => m.state !== 'dead' && m.state !== 'reserve').length; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer) { this.scene.onBeforeRenderObservable.remove(this.observer); this.observer = null; }
    // Per-member cloned animation groups + morph managers (face morphs) are NOT freed by disposing the mesh
    // subtree, so release them explicitly before the holders go — else a churning crew leaks them.
    const seenMorph = new Set<MorphTargetManager>();
    for (const m of this.members) {
      if (m.ik) { for (const n of [m.ik.tgtL, m.ik.tgtR, m.ik.poleL, m.ik.poleR]) n.dispose(); m.ik = null; }
      for (const g of m.clips.values()) { g.stop(); g.dispose(); }
      for (const mesh of m.holder.getChildMeshes(false)) {
        const mgr = (mesh as { morphTargetManager?: MorphTargetManager }).morphTargetManager;
        if (mgr && !seenMorph.has(mgr)) { seenMorph.add(mgr); mgr.dispose(); }
      }
      m.holder.dispose();   // disposes the pirate subtree
    }
    for (const sk of this.skeletons) sk.dispose();   // per-member cloned 24-joint rigs (GPU bone texture)
    this.skeletons.length = 0;
    for (const mat of this.clonedMats) mat.dispose();
    for (const tex of this.texCache.values()) tex.dispose();   // per-handle skin albedos
    this.texCache.clear();
    this.members = [];
  }

  private static readonly LOD_FAR_M = 40;    // beyond this distance, cull the member's detail meshes
  private static readonly LOD_NEAR_M = 32;   // re-show within this (hysteresis band avoids edge flicker)

  /** Distance LOD: hide the sub-pixel detail meshes (buckles/eyes/laces/…) when this member is far
   *  from the camera — i.e. crew on other ships. Near crew (your own deck) keep every part. */
  private tickLod(m: CrewMember): void {
    if (!m.detail.length) return;
    const cam = this.scene.activeCamera;
    if (!cam) return;
    const d = Vector3.Distance(cam.globalPosition, m.holder.getAbsolutePosition());
    if (!m.lodFar && d > CrewHandle.LOD_FAR_M) {
      m.lodFar = true;
      for (const me of m.detail) me.setEnabled(false);
    } else if (m.lodFar && d < CrewHandle.LOD_NEAR_M) {
      m.lodFar = false;
      for (const me of m.detail) me.setEnabled(true);
    }
  }

  // ── deck-surface snapping (react to geometry) ────────────────────────────────
  /** The ship's structural meshes (hull/deck/furniture) to raycast crew feet onto — everything under the ship
   *  root EXCEPT sails/rigging/flags/water and the crew themselves. Merging renames meshes unpredictably, so we
   *  filter by what to EXCLUDE, not by a deck name. Computed once. */
  private deckCands(): AbstractMesh[] {
    if (this.deckMeshes) return this.deckMeshes;
    // INCLUDE all structural ship geometry — the down-ray is short (≈deck±1.8 m) so sails/yards/flags overhead are
    // never hit anyway, and we NEED the cannons/capstan (which live in the merged `*_Rigging` mesh) IN the set so
    // the open-deck search can detect and stand clear of them. Only drop crew themselves + non-physical layers.
    // (Do NOT filter by 'rig' — every brig mesh is named "Brig_…" and contains the substring "rig"!)
    const skip = /water|ocean|impostor/i;
    const isCrew = (n: Nullable<Node>): boolean => {
      for (let a = n; a; a = a.parent) if (a.name?.startsWith('crew_') || a.name?.startsWith('ik_')) return true;
      return false;
    };
    const out: AbstractMesh[] = [];
    for (const me of this.shipRoot.getChildMeshes(false)) {
      if (!me.getTotalVertices() || skip.test(me.name) || isCrew(me)) continue;
      // Picking octree: the hull/deck are big merged meshes; without this every ray tests every triangle. The
      // octree lets ray.intersectsMesh test only nearby submeshes → the open-deck search stays cheap.
      if (me.getTotalVertices() > 1500) { try { (me as unknown as { createOrUpdateSubmeshesOctree?(c: number, d: number): void }).createOrUpdateSubmeshesOctree?.(64, 2); } catch { /* */ } }
      out.push(me);
    }
    this.deckMeshes = out;
    return out;
  }

  // A station's feet must land on OPEN DECK — not on a cannon/capstan/hatch that occupies the authored spot. The
  // authored station Y is a measured deck level (±~0.2 m); deck furniture stands ~0.8–1.3 m proud of it. So a spot
  // is "open" iff a ray cast straight down finds its HIGHEST surface within a tight window of the authored Y (i.e.
  // nothing tall is sitting on it). If the authored spot is blocked, we search outward (biased inboard + fore/aft)
  // for the nearest open spot. This is what makes them stand clear of the guns instead of perched on the barrels.
  private static readonly DECK_WIN_DOWN = 0.7;   // accept a deck up to this far BELOW the authored Y
  private static readonly DECK_WIN_UP   = 0.35;  // …and this far ABOVE (authored can be slightly under the planks)
  private static readonly OPEN_RAY_UP   = 1.8;   // start the down-ray this far above the station (clears tall furniture)
  private static readonly OPEN_RAY_LEN  = 3.0;
  // Candidate offsets, nearest-first: [inboard, fore/aft] in metres (inboard = toward centreline). Mostly inboard
  // and along-deck (where a gun crew's clear footing is), a touch outboard only as a last resort.
  private static readonly OPEN_OFFSETS: [number, number][] = [
    [0, 0],
    [0.5, 0], [0, 0.8], [0, -0.8],
    [0.5, 0.8], [0.5, -0.8], [1.0, 0],
    [0, 1.5], [0, -1.5], [1.0, 0.8], [1.0, -0.8],
    [0.5, 1.5], [0.5, -1.5], [1.5, 0],
    [-0.4, 0.8], [-0.4, -0.8],
  ];

  /** Highest ship-local Y hit by a ray cast straight down the ship vertical through (cx,cz) from `topY`. null if
   *  nothing is hit (off the deck edge). Assumes candidate world matrices are already warm (see findOpenDeck). */
  private castHighest(cx: number, cz: number, topY: number): number | null {
    const wm = this.shipRoot.getWorldMatrix();
    const origin = Vector3.TransformCoordinates(new Vector3(cx, topY, cz), wm);
    const down = Vector3.TransformNormal(new Vector3(0, -1, 0), wm).normalize();
    const ray = new Ray(origin, down, CrewHandle.OPEN_RAY_LEN);
    const inv = wm.clone(); inv.invert();
    let best: number | null = null;
    for (const me of this.deckCands()) {
      const pick = ray.intersectsMesh(me as never, false);
      if (pick.hit && pick.pickedPoint) {
        const ly = Vector3.TransformCoordinates(pick.pickedPoint, inv).y;
        if (best === null || ly > best) best = ly;
      }
    }
    return best;
  }

  /** Find the nearest OPEN deck spot to a station (feet clear of furniture). Returns the ship-local feet position,
   *  or null if every candidate is blocked / off-deck (then we keep the authored spot). */
  private findOpenDeck(local: Vector3): { x: number; y: number; z: number } | null {
    if (!this.deckCands().length) return null;
    this.shipRoot.computeWorldMatrix(true);
    for (const me of this.deckCands()) me.computeWorldMatrix(true);   // warm once (matrices are cold at spawn)
    const inb = local.x >= 0 ? -1 : 1;                                // toward centreline
    const topY = local.y + CrewHandle.OPEN_RAY_UP;
    const lo = local.y - CrewHandle.DECK_WIN_DOWN, hi = local.y + CrewHandle.DECK_WIN_UP;
    for (const [a, b] of CrewHandle.OPEN_OFFSETS) {
      const cx = local.x + inb * a, cz = local.z + b;
      const ly = this.castHighest(cx, cz, topY);
      if (ly !== null && ly >= lo && ly <= hi) return { x: cx, y: ly, z: cz };   // highest hit IS the deck → open
    }
    return null;
  }

  /** Move a station's feet onto the nearest open patch of deck (clear of cannon/capstan/hatch). */
  private deckSnapStation(m: CrewMember): void {
    const open = this.findOpenDeck(m.stationPos);
    if (open) m.stationPos.set(open.x, open.y, open.z);
  }

  /** A waypoint's position nudged to open deck (so walk paths bend AROUND the boat/companionway/hatches instead of
   *  cutting through them). Cached per id — waypoints are static in ship-local space. */
  private snappedWp(id: string, raw: [number, number, number]): Vector3 {
    let v = this.wpSnapCache.get(id);
    if (!v) {
      const p = new Vector3(raw[0], raw[1], raw[2]);
      const open = this.findOpenDeck(p);
      v = open ? new Vector3(open.x, open.y, open.z) : p;
      this.wpSnapCache.set(id, v);
    }
    return v.clone();
  }

  /** Idle-motion damping for crew near a rail: 1 at the centreline, ~0.4 at the rail-most station, so a gun/rope
   *  crew at the bulwark never sways/leans OUT through it. */
  private railDamp(m: CrewMember): number {
    const beam = this.beamAxis === 'z' ? m.stationPos.z : m.stationPos.x;
    const f = Math.abs(beam) / (this.maxStationX || 1);   // 0 centre → 1 rail-most
    return 1 - 0.6 * f * f;
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

  // ── environmental grip IK (track A1+A2) ──────────────────────────────────────
  /** Build this member's arm-IK rig (lazy — only when first near the camera). Two BoneIKControllers steer the
   *  UpperArm/Forearm so each Hand reaches an (invisible) target node; a pole node steers the elbow. */
  private buildIK(m: CrewMember): void {
    const sk = m.skeleton, body = m.bodyMesh;
    if (!sk || !body) { m.ik = null; return; }
    const bone = (n: string): Bone | null =>
      sk.bones.find((b) => b.name === n || b.name.endsWith('.' + n) || b.name.endsWith(n)) ?? null;
    const faL = bone('Forearm.L'), faR = bone('Forearm.R');
    if (!faL || !faR) { m.ik = null; return; }   // unexpected rig — skip IK, keep canned clips
    const node = (tag: string): Mesh => {
      const t = new Mesh(`ik_${tag}_${this.skeletons.indexOf(sk)}`, this.scene);
      t.parent = this.shipRoot; t.isPickable = false; t.setEnabled(false);   // empty mesh: a transform anchor, never drawn
      return t;
    };
    const tgtL = node('tgtL'), tgtR = node('tgtR'), poleL = node('poleL'), poleR = node('poleR');
    const opt = (target: Mesh, pole: Mesh) => ({
      targetMesh: target, poleTargetMesh: pole, bendAxis: IK_BEND.clone(), poleAngle: IK_POLE,
      slerpAmount: IK_SLERP, maxAngle: Math.PI,
    });
    m.ik = {
      tgtL, tgtR, poleL, poleR, haulPhase: 0,
      ctrlL: new BoneIKController(body, faL, opt(tgtL, poleL)),
      ctrlR: new BoneIKController(body, faR, opt(tgtR, poleR)),
    };
  }

  /** Ease the Grip↔Relaxed hand morphs toward `target` (0 idle-curl … GRIP_W gripping). */
  private setGrip(m: CrewMember, target: number, dt: number): void {
    m.ikGrip += (target - m.ikGrip) * Math.min(1, dt * GRIP_EASE);
    const t = m.face?.targets;
    if (!t) return;
    const g = t.get('Grip'), r = t.get('Relaxed');
    if (g) g.influence = m.ikGrip;
    if (r) r.influence = HAND_RELAX * (1 - m.ikGrip);   // relaxed curl fades out as the fist closes
  }

  /** Per frame: when a near member is working a grip station, place the hand/elbow targets and solve the arms. */
  private tickIK(m: CrewMember, dt: number): void {
    if (!IK_ENABLED) return;
    const cam = this.scene.activeCamera;
    const isWork = m.state === 'station' && (m.stationClip === 'Work_Cannon' || m.stationClip === 'Work_Ropes');
    const near = cam ? Vector3.Distance(cam.globalPosition, m.holder.getAbsolutePosition()) : 1e9;
    const want = isWork && near <= (m.ikActive ? IK_GATE_FAR : IK_GATE_NEAR);
    if (want && !m.ik) this.buildIK(m);
    if (!want || !m.ik) {                 // not gripping (far / walking / non-work) — let the clip drive the arms
      if (m.ikGrip > 0.001) this.setGrip(m, 0, dt);   // and release the fist back to the idle curl
      m.ikActive = false;
      return;
    }
    m.ikActive = true;

    // Ship-fixed grip frame from the station heading (the body micro-sways around these fixed points).
    const yaw = m.yaw;
    const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));      // along the station heading
    const rgt = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));     // station-right
    const ropes = m.stationClip === 'Work_Ropes';
    const G = ropes ? GRIP_ROPES : GRIP_CANNON;
    m.ik.haulPhase += dt * (ropes ? GRIP_ROPES.haulRate : 0);
    const haul = ropes ? Math.sin(m.ik.haulPhase) * GRIP_ROPES.haulAmp : 0;   // hand-over-hand: hands rise/fall in anti-phase
    const place = (mesh: Mesh, latSign: number, up: number) => {
      mesh.position.copyFrom(m.stationPos)
        .addInPlace(fwd.scale(G.fwd)).addInPlace(rgt.scale(latSign * G.lat)).addInPlaceFromFloats(0, up, 0);
      mesh.computeWorldMatrix(true);   // disabled node — force the world matrix so the controller reads it fresh
    };
    place(m.ik.tgtL, -1, G.up + haul);
    place(m.ik.tgtR, +1, G.up - haul);
    // Elbows: pole below + outboard of each hand so they bend down-and-out, not into the body.
    const pole = (mesh: Mesh, latSign: number) => {
      mesh.position.copyFrom(m.stationPos)
        .addInPlace(rgt.scale(latSign * (G.lat + 0.30))).addInPlace(fwd.scale(-0.10))
        .addInPlaceFromFloats(0, G.up - 0.45, 0);
      mesh.computeWorldMatrix(true);
    };
    pole(m.ik.poleL, -1); pole(m.ik.poleR, +1);

    m.ik.ctrlL?.update();
    m.ik.ctrlR?.update();
    this.setGrip(m, GRIP_W, dt);
  }

  // ── per-member state machine ────────────────────────────────────────────────
  private tick(m: CrewMember, dt: number): void {
    if (m.state === 'reserve') return;   // unrecruited reserve: hidden, no animation/logic
    this.tickFace(m, dt);
    this.tickLod(m);
    // Smooth yaw toward target everywhere except while dead, then BRACE against the deck slope: counter-lean the
    // heel/pitch so the crew ride the swell instead of standing rigidly perpendicular to a heeled deck. Composed
    // OUTSIDE the yaw so the lean is about the SHIP's fore-aft/lateral axes regardless of which way they face.
    if (m.state !== 'dead') {
      let d = m.yawTarget - m.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      m.yaw += d * Math.min(1, dt * 8);
      let roll  = -this.shipHeel  * BRACE_FACTOR;
      let pitch = -this.shipPitch * BRACE_FACTOR;
      // Always-on idle weight-shift lean while standing at a station — what keeps them from looking like statues
      // in flat calm (walking/climbing have their own motion, so skip there). Damped near a rail (large |x|) so a
      // gun/rope crew at the bulwark never leans OUT through it.
      if (m.state === 'station') {
        roll  += Math.sin(this.clock * m.swayFreq + m.swayPhase) * IDLE_LEAN_AMP * this.railDamp(m);
        pitch += Math.sin(this.clock * m.swayFreq * 0.7 + m.swayPhase * 1.7) * IDLE_PITCH_AMP;
      }
      roll  = Math.max(-BRACE_MAX, Math.min(BRACE_MAX, roll));
      pitch = Math.max(-BRACE_MAX, Math.min(BRACE_MAX, pitch));
      const qYaw = Quaternion.RotationAxis(Vector3.Up(), m.yaw);
      m.holder.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, pitch, roll).multiply(qYaw);
    }
    // Idle weight-shift sway + breathing bob at a station (desynced) + a lean onto the downhill foot as she
    // heels. Skipped while walking/climbing (their position is driven by the path) and while dead.
    if (m.state === 'station') {
      const rd = this.railDamp(m);
      m.holder.position.x = m.stationPos.x + (Math.sin(this.clock * m.swayFreq + m.swayPhase) * SWAY_AMP + this.shipHeel * HEEL_SHIFT) * rd;
      m.holder.position.z = m.stationPos.z + Math.cos(this.clock * m.swayFreq * 0.8 + m.swayPhase) * SWAY_AMP * 0.6;
      m.holder.position.y = m.stationPos.y + Math.sin(this.clock * 0.9 + m.swayPhase) * IDLE_BOB;

      // Glance (P3): occasionally break off the work loop to look about (Lookout), then resume the station clip.
      if (m.glanceT > 0) {
        m.glanceT -= dt;
        if (m.glanceT <= 0) this.play(m, m.stationClip, true);
      } else if (m.workBurst <= 0 && m.dwell > 5 && m.clips.has('Lookout') && m.rng() < GLANCE_CHANCE * dt) {
        m.glanceT = 2 + m.rng() * 2.5;
        this.play(m, 'Lookout', true);
      }
      // Work burst (P3): a gun crew works harder right after their broadside — speed up the work clip, decaying.
      if (m.workBurst > 0) m.workBurst = Math.max(0, m.workBurst - dt);
      if (m.glanceT <= 0 && m.current) {
        m.current.speedRatio = m.animSpeed * (1 + WORK_BURST_GAIN * (m.workBurst / WORK_BURST_DUR));
      }
    }

    // Environmental grip IK (track A): plant working hands on the station + close the fingers. Runs every frame
    // for near (player-deck) members; internally a no-op when far / not at a work station. Animations are already
    // evaluated by the time onBeforeRender fires, so this cleanly overrides the arm pose post-clip.
    this.tickIK(m, dt);

    switch (m.state) {
      case 'station': {
        m.dwell -= dt;
        if (m.dwell > 0) return;
        // Walkways are single-occupancy: if someone else is on the move, keep
        // working a little longer and check again shortly.
        if (this.walkers.size >= this.WALKER_CAP) { m.dwell = 4 + m.rng() * 6; return; }
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

  /** Ground speed (m/s) for a leg kind. */
  private legSpeed(kind: string): number {
    return kind === 'squeeze' ? this.walkSpeed * 0.4
      : kind === 'ladder' ? 0.5
      : kind === 'step' ? this.walkSpeed * 0.6
      : kind === 'step_over' ? this.walkSpeed * 0.75
      : this.walkSpeed;
  }

  /** Play the right locomotion clip for a leg, with the Walk clip's playback matched to ground speed (feet plant). */
  private playLeg(m: CrewMember, kind: string): void {
    const ladder = kind === 'ladder';
    const g = this.play(m, ladder ? 'Climb' : 'Walk', true);
    if (g && !ladder) g.speedRatio = m.animSpeed * Math.max(0.35, this.legSpeed(kind) / this.walkSpeed) * STRIDE_SCALE;
  }

  private tickWalk(m: CrewMember, dt: number): void {
    const leg = m.legs[0];
    if (!leg) { this.finishWalk(m); return; }
    const span = Vector3.Distance(m.legFrom, leg.to);
    // Face the travel direction; SLOW forward progress while still turning toward it, so a sharp corner is taken
    // as a turn-in-place rather than a slide through it.
    const dx = leg.to.x - m.legFrom.x, dz = leg.to.z - m.legFrom.z;
    if (dx * dx + dz * dz > 0.01) m.yawTarget = Math.atan2(dx, dz);
    let err = m.yawTarget - m.yaw;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const turnSlow = Math.max(0.25, Math.cos(Math.min(Math.abs(err), Math.PI / 2)));   // 1 aligned → 0.25 at ≥90°
    const speed = this.legSpeed(leg.kind) * turnSlow;
    m.legT = span > 1e-4 ? Math.min(1, m.legT + (speed * dt) / span) : 1;
    Vector3.LerpToRef(m.legFrom, leg.to, m.legT, m.holder.position);
    if (leg.kind === 'step_over') {
      m.holder.position.y += 0.45 * Math.sin(Math.PI * m.legT);   // arc over the thwart
    }
    if (m.legT >= 1) {
      m.legFrom.copyFrom(leg.to);
      m.legs.shift();
      m.legT = 0;
      const next = m.legs[0];
      if (!next) { this.finishWalk(m); return; }
      this.playLeg(m, next.kind);   // ladder → climb loop, else speed-matched walk
    }
  }

  private finishWalk(m: CrewMember): void {
    this.walkers.delete(m);   // free the walkways
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
    m.stationPos.set(st.pos[0], st.pos[1], st.pos[2]);   // sway anchor (P1)
    // Plant the feet on the real deck, clear of furniture — EXCEPT seats, which intentionally sit ON a
    // thwart/bench (the open-deck search would shove a rower off his thwart onto the sole).
    if (st.kind !== 'seat') this.deckSnapStation(m);
    m.stationClip = st.clip; m.glanceT = 0;              // remember the work clip to resume after a glance (P3)
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
      m.legs.push({ to: this.snappedWp(id, wps[id]), kind });   // route AROUND deck furniture (boat/companionway/…)
      prev = id;
    }
    if (target) m.legs.push({ to: new Vector3(target.pos[0], target.pos[1], target.pos[2]), kind: 'walk' });
    if (climb) m.legs.push({ to: new Vector3(climb.polyline[0][0], climb.polyline[0][1], climb.polyline[0][2]), kind: 'walk' });
    m.wpId = goalWp;
    (m as CrewMember & { _target?: CrewStation | null })._target = target;
    (m as CrewMember & { _climb?: CrewClimb | null })._climb = climb;
    if (climb) this.climbBusy = true;
    this.walkers.add(m);   // count toward the walker cap
    m.state = 'walk';
    m.legT = 0;
    this.playLeg(m, m.legs[0]?.kind ?? 'walk');
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
