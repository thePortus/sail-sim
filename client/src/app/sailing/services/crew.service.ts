import { Injectable, inject } from '@angular/core';
import {
  AbstractMesh, AnimationGroup, Bone, BoneIKController, Color3, DynamicTexture, Material, Mesh, MeshBuilder,
  MorphTarget, MorphTargetManager, Node, Nullable, Observer, PBRMaterial, Quaternion, Ray, Scene, ShadowGenerator,
  Skeleton, StandardMaterial, Texture, TransformNode, Vector3,
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
// skating. STRIDE_SCALE matches the clip's authored stride to walk_speed_mps — calibrated to 1.0 (no footskate).
// TURN_SLOW slows forward progress while turning sharply so they rotate INTO a corner rather than sliding through it.
const STRIDE_SCALE = 1.0;
// Life + combat sync (P3).
const WORK_BURST_DUR  = 2.6;   // s a gun crew breaks into a loading/heave motion after their broadside fires
const WORK_BURST_GAIN = 1.1;   // peak extra work-clip speed (×) at the moment of firing
const GUN_LOAD_CLIP   = 'Work_Cannon';   // the heave/run-out clip a gun crew plays while reloading after a shot
// The haul clip pulls ~51° to the character's RIGHT (measured: hands go more lateral than forward), so a gun crew
// facing their gun would heave toward the bow. While loading, yaw the body by this so the diagonal pull lines up
// with the gun. Calibrated to -51° (measured from the clip).
const LOAD_YAW_OFFSET = (-51 * Math.PI) / 180;
const GLANCE_CHANCE   = 0.02;  // per-second chance a stationed crew breaks off to glance about
// Cross-fade between clips (P3.2): instead of hard-cutting one clip to the next (which snaps mid-pose when a
// member changes activity — walk→work, work→glance, sit→stand), ramp the outgoing clip's weight down while the
// incoming ramps up over this window. Weights sum to 1 so the blended pose stays normalized.
const CLIP_BLEND_S    = 0.22;  // s — clip cross-fade time

// ── Reactions (P4): crew flinch/stagger/brace + facial reactions to combat & the swell ───────────────────────
// No dedicated flinch/stagger CLIPS exist yet (they fall back to Idle), so phase-1 reactions are driven on the
// two channels we DO have: an additive HOLDER pose (a quick duck / sideways lurch, same wrapper the sway uses)
// + FACIAL morphs (wince = Frown+BrowsUp+squint). Dedicated Mixamo clips can replace the pose approximation later.
const FLINCH_FIRE   = 0.6;    // flinch level a (non-gun) crew takes when a gun fires near them
const FLINCH_DECAY  = 0.42;   // s for a flinch to fade
const FLINCH_DUCK_P = 0.20;   // rad forward pitch (duck the head) at full flinch
const FLINCH_DUCK_Y = 0.045;  // m drop (crouch) at full flinch
const STAGGER_DECAY = 0.85;   // s for a hit-stagger to fade
const STAGGER_ROLL  = 0.26;   // rad sideways lurch (away from the impact) at full stagger
const STAGGER_PITCH = 0.10;   // rad forward jolt at full stagger
const STAGGER_DUCK_Y = 0.05;  // m drop at full stagger
const HEEL_TENSE_LO = 0.085;  // rad heel where crew start to look tense (brace face)
const HEEL_TENSE_HI = 0.32;   // rad heel for a full tense/worried face
// One-shot reaction CLIPS (P4): real Mixamo clips that override the work loop for a beat, then resume.
const HIT_CLIP_CHANCE  = 0.5;  // fraction of crew that play the full React_Hit recoil on a hit (rest just lurch via the pose)
const HIT_REACT_DUR    = 1.0;  // s the hit-recoil clip holds before resuming the station clip
const REACT_COOLDOWN   = 3.0;  // s min between a member's one-shot reaction clips (no recoil-spam in a long battle)
const POINT_GLANCE_CHANCE = 0.3;  // fraction of "glance about" breaks that become a point-at-the-horizon (React_Point)
const FLEE_FRAC       = 0.6;   // of the crew whose morale breaks, this fraction SCRAMBLE across the deck; the rest cower in place
const FLEE_SPEED_MUL  = 1.8;   // ×walk speed while fleeing (a frantic scramble; the Walk clip is sped to match so feet still plant)

// ── Environmental grip IK (crew realism v2, track A1+A2) ─────────────────────────────────────────────────────
// Make working hands actually REACH their station instead of miming in the air. Post-clip 2-bone arm IK
// (UpperArm→Forearm→Hand) plants each Hand on a grip point in front of the station, and the GLB's `Grip` shape
// key closes the fingers (fading the idle `Relaxed` curl). PLAYER-DECK ONLY: gated to crew near the camera
// (which only the player's own ship ever is) — remote/NPC crew keep the canned clips, so the cost stays tiny.
// Master opt-out `localStorage.ignis_crew_ik='0'` (the one surviving user knob — the per-station toggles and
// geometry values below are calibrated and baked). Turning this off falls back to the canned Mixamo work clips.
const IK_ENABLED   = (() => { try { return (localStorage.getItem('ignis_crew_ik') ?? '1') !== '0'; } catch { return true; } })();
// ARM-GRIP IK is BAKED OFF: without real gun/tackle geometry at the grip point the hands just clasp in mid-air in a
// stiff, identical pose across the whole gun crew (reads "wrong" up close) — and the canned Mixamo work clips
// (Pulling A Rope) already curl the hands naturally. Left as a const (not deleted) so it can be re-enabled once the
// grip points are tied to real geometry. (Foot-plant IK, HELM/GUN/ROPE grips stay on via IK_ENABLED.)
const ARM_GRIP_ENABLED = false;
// Build + run IK for crew within this of the camera (only the player's own ship is ever this near).
const IK_GATE_NEAR = 28;
const IK_GATE_FAR  = IK_GATE_NEAR + 6;   // tear down beyond this (hysteresis band avoids edge flap)
const GRIP_W       = 0.85;  // `Grip` morph influence while a hand is working a station
const GRIP_EASE    = 5.0;   // per-second ease rate for the Grip↔Relaxed hand blend
const IK_SLERP     = 0.35;  // BoneIKController slerp — eases toward the solution so a slightly-off calib drifts, not snaps
// Elbow bend axis + pole angle — CALIBRATED via the headless-Babylon harness (see [[crew-ik-calibration]]): for
// the mixamorig arm, local Y is along the bone, X is the reaching hinge, and poleAngle 270° puts the elbow
// down+back (verified: hands reach the wheel, elbows below the shoulder). Baked.
const IK_BEND = new Vector3(1, 0, 0);
const IK_POLE = (270 * Math.PI) / 180;
// Hands-on-the-WHEEL IK (real-gear placement): the helmsman grips the ship's actual wheel (located from its B_Wheel
// bone), hands on the rim at ~10 & 2 o'clock. Folded into the master IK toggle; rim radius measured on the merchantman.
const HELM_IK_ENABLED = IK_ENABLED;
const HELM_RIM_R = 0.66;   // merchantman wheel measured 0.66
// Hands-on-the-GUN IK: a gun crew mans their cannon — hands rest on the barrel. The gun sits at ~waist height, so
// it's a STANDING "manning the piece" pose (arm-only IK can't crouch). Station-relative offsets, valid because the
// gun stations are aligned ABAFT the real cannon breech. Folded into the master IK toggle.
const GUN_IK_ENABLED = IK_ENABLED;
const GUN_GRIP = { fwd: 0.40, up: 1.05, spread: 0.14 };   // barrel-top grip in the station frame (headless-verified reach)
// Hands-on-the-FIFE-RAIL IK: rope crew tend the running rigging belayed at the mast-base fife rails — hands on the
// rail/pins, a standing "tending the lines" pose (same shape as the gun grip). Stations aligned facing the rail.
const ROPE_IK_ENABLED = IK_ENABLED;
const ROPE_GRIP = { fwd: 0.40, up: 1.00, spread: 0.20 };   // fife-rail grip, hands spread along the rail
// ── Foot-plant IK (crew realism v2, P3.2) ────────────────────────────────────────────────────────────────────
// Standing crew on a heeling deck: the brace/idle-lean rotates the WHOLE body about its centreline, lifting the
// outboard foot off the deck and sinking the inboard one (the clips are authored on FLAT ground). A 2-bone leg IK
// (UpLeg→Leg→Foot) snaps each ankle back to the deck plane under its current x,z so the feet stay planted while the
// torso rides the swell. It's a SMALL correction (the ankle lands on target regardless of bend axis), so calibration
// risk is low. Player-deck only (same near gate as the arms).
// BAKED OFF: the 2-bone leg IK works, but the mixamorig shin bone's local bend axis isn't known offline, so the
// knees bend in the wrong plane ("weird knee bends", user-confirmed in both axis-sign guesses). The canned-clip legs
// have no weird bends and the foot float on a heeling deck is small. Left as a const (not deleted) so it can be
// re-enabled once the bend axis is calibrated from the runtime [CrewFootIK] log.
const FOOT_IK_ENABLED = false;
const FOOT_ANKLE_UP   = 0.10;   // m the ankle bone rides above the deck plane (so the sole rests ON the deck)
const FOOT_KNEE_FWD   = 0.45;   // m the knee pole sits ahead of the ankle (knees bend forward, not back)
const FOOT_KNEE_UP    = 0.45;   // m the knee pole sits above the ankle
const FOOT_BEND = new Vector3(-1, 0, 0);   // knees bend FORWARD (the +X default bent them backward)
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
    // The new Mixamo crew (crew_spike.glb — faces/skins/beards/hair/clothing variety + the full lifecycle) is now
    // the DEFAULT. It flows through the same lifecycle as the legacy pirate crew (placement, deck-snap, walking,
    // sway/brace, dwell), only the GLB + variant/kit scheme differ. Opt IN to the legacy pirate crew with
    // `localStorage.ignis_crew_legacy='1'`.
    const useNew = typeof localStorage === 'undefined' || localStorage.getItem('ignis_crew_legacy') !== '1';
    const glb = useNew ? 'crew_spike.glb' : CrewService.GLB;
    try {
      const layout = await this.loadLayout(layoutFile);
      // The new crew ships no pirate manifest; synthesize the one field the lifecycle reads (walk speed).
      const manifest = useNew
        ? ({ constants: { walk_speed_mps: 1.2 } } as unknown as PirateManifest)
        : await this.loadManifest();
      if (shipGlbRoot.isDisposed()) return null;
      const n = Math.min(count ?? CrewService.DEFAULT_COUNT[slug] ?? 5, layout.stations.length);
      const handle = new CrewHandle(scene, shipGlbRoot, layout, manifest, this.baseUrl, seed, useNew);
      for (let i = 0; i < n; i++) {
        const rigged = await this.assetCache.instantiateRigged(glb, scene, shipGlbRoot, false);
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
  /** Ship's wheel rim radius (m) for the helmsman's hand placement — varies per ship (merchantman 0.66, brig
   *  0.565). Falls back to HELM_RIM_R when absent. */
  wheel_rim?: number;
  /** Hands-on-gear grip HEIGHT (m above the station deck) for gun / rope crew. Present ONLY when the ship's gear
   *  sits at a reachable (≈waist/chest) height; absent → that crew stand ready instead of gripping (e.g. the brig's
   *  guns & bulwark rail are hip-height, unreachable for a standing arm). */
  gun_grip_up?: number;
  rope_grip_up?: number;
  /** Per-ship vertical correction (m) added to the deck-snapped feet Y. Some merged decks (the merchantman) get
   *  raycast-hit a few cm below their visible plank surface, sinking the crew to the instep — a small positive
   *  lift seats the soles back on the planks. Default 0. */
  deck_lift?: number;
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
  prev: Nullable<AnimationGroup>;  // outgoing clip mid cross-fade (weight ramping to 0), else null
  blend: number;                   // 0→1 fade-in progress of `current` over the prev (1 = no fade in flight)
  face: CrewFace | null;
  state: CrewState;
  stationId: string | null;       // reserved station while at/walking to it
  wpId: string;                   // last waypoint id (graph anchor)
  dwell: number;
  legs: PathLeg[];                // remaining walk legs
  legT: number;                   // 0..1 along current leg
  legFrom: Vector3;
  yaw: number; yawTarget: number; stationYaw: number;   // stationYaw = the station's base heading (gun-load yaw offsets from it)
  climb: { path: Vector3[]; seg: number; t: number; dir: 1 | -1; pause: number } | null;
  animSpeed: number;
  rng: () => number;
  detail: AbstractMesh[];   // tiny parts (buckles/eyes/laces/…) culled when the member is far
  lodFar: boolean;          // true while the detail meshes are hidden (distance LOD)
  lodDist: number;          // camera distance this frame (computed once, shared by all the LOD gates)
  frozen: boolean;          // true while VERY distant → animation paused (skeleton skipped), tick skipped
  lodPhase: number;         // 0/1 — staggers the far-crew half-rate tick so they don't all update the same frame
  // Ship-motion presence (P1): a desynced idle sway + the station anchor it sways around.
  swayPhase: number;
  swayFreq: number;
  stationPos: Vector3;      // the exact station position; sway is a small offset from this
  // Life + combat sync (P3).
  stationClip: string;      // the looping work clip for the current station (to resume after a glance)
  workBurst: number;        // >0 → working harder (e.g. the gun crew right after a broadside); decays
  glanceT: number;          // >0 → briefly broke off work to glance about (Lookout), then resumes
  // Reactions (P4): transient combat startles, decaying 1→0 over their own window. Drive an additive duck/lurch
  // pose + a facial wince; the dominant one wins each frame.
  flinch: number;           // 0..1 — quick duck/wince at a nearby gun blast
  stagger: number;          // 0..1 — bigger lurch when the ship takes a hit
  staggerDir: number;       // ±1 — which way the hit lurches them (away from the struck side)
  reactT: number;           // >0 while a one-shot reaction CLIP (React_Hit/Point/Cheer) overrides the work loop
  reactCD: number;          // cooldown (s) before the next one-shot reaction clip — prevents recoil-spam
  panicT: number;           // >0 while morale is BROKEN — cowering (React_Panic looped) or FLEEING, abandoned the work loop
  fleeing: boolean;         // true while panicking AND scrambling across the deck (walk state) rather than cowering in place
  // Environmental grip IK (track A). Built lazily the first time the member is near the camera.
  skeleton: Skeleton | null;   // this member's cloned 24-joint rig (arm bones live here)
  bodyMesh: AbstractMesh | null; // the skinned 'Human' mesh (BoneIKController world-space anchor)
  ik: CrewIK | null;           // arm-IK controllers + grip-target nodes (null until built)
  ikActive: boolean;           // true while IK is steering the hands this frame
  ikGrip: number;              // eased Grip-morph influence (0 relaxed → GRIP_W gripping)
}

/** Per-member arm-IK rig: a BoneIKController per arm + the (invisible) grip-target / elbow-pole anchor nodes.
 *  Plus optional LEG-IK (foot-plant): a controller per shin steering the ankle onto the deck. */
interface CrewIK {
  ctrlL: BoneIKController | null; ctrlR: BoneIKController | null;
  tgtL: Mesh; tgtR: Mesh;       // where each Hand should reach (ship-space, parented under the ship root)
  poleL: Mesh; poleR: Mesh;     // elbow pole targets (steer the elbow direction)
  haulPhase: number;            // hand-over-hand phase for rope-hauling
  // Foot-plant (built only for the new Mixamo crew when leg bones are present).
  footCtrlL?: BoneIKController | null; footCtrlR?: BoneIKController | null;
  footTgtL?: Mesh; footTgtR?: Mesh;     // deck-snapped ankle targets
  footPoleL?: Mesh; footPoleR?: Mesh;   // knee pole targets (steer the knee forward)
  ankleL?: Bone | null; ankleR?: Bone | null;   // ankle bones — read the clip-posed x,z each frame
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
  // Crew LOD/perf (P5): far crew tick at half-rate + skip the (invisible) face; VERY distant crew freeze their
  // animation (skeleton skipped). Opt out with localStorage ignis_crew_lod='0'.
  private readonly lod = typeof localStorage === 'undefined' || localStorage.getItem('ignis_crew_lod') !== '0';
  private _frame = 0;
  private readonly texCache = new Map<string, Texture>();
  private readonly clonedMats: PBRMaterial[] = [];
  private skinIdx = 0;   // walks SKIN_ORDER so a full crew shows the whole tone range, not random-clustered light
  // Soft projected blob shadow under each crew member — a flat alpha quad on the deck (cheaper than shadow-map
  // RECEIVING, which overflows the ship PBR material's WebGPU varying budget). Shared material/texture. Opt-out
  // `localStorage.ignis_crew_blobshadow='0'`.
  private blobMat: StandardMaterial | null = null;
  private readonly blobShadows = (() => { try { return localStorage.getItem('ignis_crew_blobshadow') !== '0'; } catch { return true; } })();
  // REAL deck shadows (default): cast each crew's silhouette into the sun's shadow map; the VesselService spawns a
  // ShadowOnlyMaterial deck-catcher that RECEIVES them (the ship's own PBR can't receive — varying overflow). Set
  // `localStorage.ignis_deck_shadows='0'` to fall back to the cheap projected blob shadows instead.
  private readonly realDeckShadows = (() => { try { return localStorage.getItem('ignis_deck_shadows') !== '0'; } catch { return true; } })();
  private readonly shadowCasters: AbstractMesh[] = [];
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
  // Ship's wheel (for the helmsman's hands-on-wheel IK): the B_Wheel bone + the skinned mesh that owns it.
  private wheelBone: Bone | null = null;
  private wheelBody: AbstractMesh | null = null;
  private wheelTried = false;

  constructor(
    private scene: Scene,
    private shipRoot: TransformNode,
    private layout: CrewLayout,
    private manifest: PirateManifest,
    private baseUrl: string,
    seed: number,
    private useNew = false,
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

    // Facial expression morph targets live on the body/face mesh — new Mixamo crew = 'CrewM', old pirate = 'Human'.
    // Find it by the morph targets themselves (robust to the mesh-name suffix) rather than a hard-coded name.
    let face: CrewFace | null = null;
    const human = glbRoot.getChildMeshes(false)
      .find((mesh) => mesh.name === 'Human' || mesh.name.endsWith('.Human')) as Mesh | undefined;
    const faceMesh = glbRoot.getChildMeshes(false).find((mesh) => {
      const tm = (mesh as Mesh).morphTargetManager;
      if (!tm) { return false; }
      for (let t = 0; t < tm.numTargets; t++) { const n = tm.getTarget(t).name; if (n === 'BrowsUp' || n === 'Blink') { return true; } }
      return false;
    }) as Mesh | undefined;
    const mgr = (faceMesh ?? human)?.morphTargetManager;
    // BoneIKController needs a skinned mesh to resolve bone world transforms. Old pirate crew = 'Human';
    // the new Mixamo crew's skinned body is 'Crew' (else fall back to any skinned mesh under this member).
    const ikBody: AbstractMesh | undefined = this.useNew
      ? (glbRoot.getChildMeshes(false).find((me) => me.name === 'Crew' || me.name.endsWith('.Crew'))
         ?? glbRoot.getChildMeshes(false).find((me) => (me as Mesh).skeleton != null))
      : human;
    if (mgr && mgr.numTargets > 0) {
      const targets = new Map<string, MorphTarget>();
      for (let t = 0; t < mgr.numTargets; t++) {
        const target = mgr.getTarget(t);
        targets.set(target.name, target);
      }
      face = {
        targets, nextBlink: 1 + rng() * 4, blinkT: 0,
        exprTimer: 5 + rng() * 20,
        cur: { BrowsUp: 0, Frown: 0, Smile: 0, MouthOpen: 0 },
        tgt: { BrowsUp: 0, Frown: 0, Smile: 0, MouthOpen: 0 },
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
      holder, clips, current: null, prev: null, blend: 1, face, state: 'station', stationId: null,
      wpId: Object.keys(this.layout.waypoints)[0], dwell: 2 + rng() * 6,
      legs: [], legT: 0, legFrom: new Vector3(), yaw: 0, yawTarget: 0, stationYaw: 0,
      climb: null, animSpeed: 0.92 + rng() * 0.16, rng,
      detail, lodFar: false, lodDist: 0, frozen: false, lodPhase: this.members.length & 1,
      swayPhase: rng() * Math.PI * 2, swayFreq: 0.7 + rng() * 0.5, stationPos: new Vector3(),
      stationClip: 'Idle', workBurst: 0, glanceT: 0,
      flinch: 0, stagger: 0, staggerDir: 1, reactT: 0, reactCD: 0, panicT: 0, fleeing: false,
      skeleton: skeletons.find((s) => s && s.bones?.length) ?? skeletons[0] ?? null,
      bodyMesh: ikBody ?? null, ik: null, ikActive: false, ikGrip: 0,
    };

    // Shadows: REAL (cast silhouette into the sun's shadow map → deck-catcher receives) or, as a fallback, a cheap
    // projected blob under the feet. Silhouette = body + main garments; disabled hats/layers auto-skip; tiny/inner
    // parts (eyes, sash, hair) are left out to keep the shadow pass cheap.
    if (this.realDeckShadows) {
      const sg = this.scene.getLightByName('sun')?.getShadowGenerator() as ShadowGenerator | null;
      if (sg) {
        for (const me of glbRoot.getChildMeshes(false)) {
          if (!/Crew|base|Shirt|Breeches|Boots|Coat|Vest|Cap|Tricorn|Bandana/i.test(me.name)) continue;
          sg.addShadowCaster(me, true); this.shadowCasters.push(me);
        }
      }
    } else if (this.blobShadows) {
      this.addBlobShadow(holder);
    }

    // Spawn directly at a free station (no walk-in pop).
    const st = this.pickStation(member);
    if (st) this.arriveAt(member, st, true);
    this.members.push(member);
  }

  /** Shared soft-shadow material (one radial-gradient alpha texture for the whole crew). Black quad, alpha-blended,
   *  unlit → it just darkens the deck under each sailor. Lazily built. */
  private getBlobMat(): StandardMaterial {
    if (this.blobMat) return this.blobMat;
    const tex = new DynamicTexture('crewBlob', { width: 128, height: 128 }, this.scene, false);
    const ctx = tex.getContext();
    const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(0.55, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g as unknown as string; ctx.fillRect(0, 0, 128, 128); tex.update(); tex.hasAlpha = true;
    const mat = new StandardMaterial('crewBlobMat', this.scene);
    mat.diffuseColor = new Color3(0, 0, 0); mat.emissiveColor = new Color3(0, 0, 0); mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true; mat.diffuseTexture = tex; mat.useAlphaFromDiffuseTexture = true;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND; mat.backFaceCulling = false; mat.zOffset = -2;
    mat.fogEnabled = false;
    this.blobMat = mat;
    return mat;
  }

  /** A flat soft blob shadow on the deck under a crew member. Child of the holder → follows the sailor as they
   *  walk; lies in the deck plane (the holder's brace-lean is only a few degrees, imperceptible on a 1 m quad). */
  private addBlobShadow(holder: TransformNode): void {
    const blob = MeshBuilder.CreateGround(`${holder.name}_shadow`, { width: 1.05, height: 1.35 }, this.scene);
    blob.material = this.getBlobMat();
    blob.parent = holder;
    blob.position.y = 0.03;          // just above the planks
    blob.isPickable = false;
    blob.renderingGroupId = 2;       // with the ship; alpha-blended → draws after the deck
    blob.alphaIndex = 0;             // behind the crew's own (opaque) meshes
  }

  /** Seeded look: skin texture, garment tints, headwear visibility. */
  private applyVariants(glbRoot: TransformNode, rng: () => number): void {
    if (this.useNew) { this.applyKitVariants(glbRoot, rng); return; }
    if (this.useNew) { this.applyKitVariants(glbRoot, rng); return; }
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

  /** P3 kit variety for the new Mixamo crew: per-member seeded garment colours (cloned PBR materials) +
   *  coat/bandana toggle, with a polygon-offset (zOffset; more-negative = in front) layering so an outer
   *  garment always wins the depth test over the one beneath → no garment-through-garment z-fight. */
  private applyKitVariants(glbRoot: TransformNode, rng: () => number): void {
    const SHIRT = [[0.86, 0.80, 0.66], [0.92, 0.92, 0.86], [0.36, 0.46, 0.60], [0.60, 0.15, 0.11], [0.74, 0.62, 0.44]];
    const COAT  = [[0.24, 0.13, 0.08], [0.07, 0.09, 0.18], [0.05, 0.05, 0.06], [0.34, 0.10, 0.08], [0.09, 0.17, 0.11]];
    const BREE  = [[0.24, 0.17, 0.11], [0.15, 0.10, 0.06], [0.26, 0.26, 0.28], [0.06, 0.06, 0.07], [0.10, 0.12, 0.20]];
    const SASH  = [[0.60, 0.09, 0.07], [0.66, 0.54, 0.11], [0.16, 0.26, 0.52], [0.11, 0.34, 0.14], [0.05, 0.05, 0.06]];
    const BAND  = [[0.60, 0.09, 0.07], [0.16, 0.26, 0.52], [0.05, 0.05, 0.06], [0.22, 0.14, 0.09]];
    const BOOT  = [[0.16, 0.09, 0.05], [0.10, 0.06, 0.04], [0.05, 0.04, 0.035], [0.22, 0.12, 0.06]];
    const meshes = glbRoot.getChildMeshes(false);
    const findMesh = (kw: string) => meshes.find((mm) => new RegExp(kw, 'i').test(mm.name));
    const pick = <T>(a: T[]): T => a[Math.floor(rng() * a.length)];
    // Per-crew BUILD — independent SEX + BULK, driven by the Fem/Heavy/Lean morphs baked on the body + torso
    // garments (Shirt/Coat/Breeches/Sash). Each member is its own instantiateModelsToScene clone, so every mesh
    // carries its OWN morphTargetManager → influences are per-member (not shared across the deck). ~1-in-6 female;
    // bulk splits roughly thirds lean / average / heavy so the crew isn't all one stocky male silhouette.
    const female = rng() < 0.16;
    const bulk = rng();
    const heavy = bulk > 0.64 ? 0.45 + rng() * 0.5 : 0;
    const lean = heavy === 0 && bulk < 0.34 ? 0.35 + rng() * 0.5 : 0;
    const fem = female ? 0.9 + rng() * 0.1 : 0;
    for (const me of meshes) {
      const mm = (me as { morphTargetManager?: MorphTargetManager }).morphTargetManager;
      if (!mm) continue;
      for (let t = 0; t < mm.numTargets; t++) {
        const tg = mm.getTarget(t);
        if (tg.name === 'Fem') tg.influence = fem;
        else if (tg.name === 'Heavy') tg.influence = heavy;
        else if (tg.name === 'Lean') tg.influence = lean;
      }
    }
    // `lin` linearizes the swatch (for FLAT materials with no albedo texture — Cap/Tricorn/Neckerchief — so a chosen
    // sRGB colour renders as intended; textured garments multiply their texture so they pass the raw value).
    const tintMesh = (kw: string, c: number[], zoff: number, lin = false) => {
      const mesh = findMesh(kw);
      if (mesh && mesh.material instanceof PBRMaterial) {
        const mat = mesh.material.clone(`${mesh.material.name}_${this.clonedMats.length}`);
        mat.albedoColor = lin ? new Color3(c[0], c[1], c[2]).toLinearSpace() : new Color3(c[0], c[1], c[2]);
        mat.zOffset = zoff;
        mesh.material = mat;
        if (!mesh.isEnabled()) mesh.setEnabled(true);   // a chosen headwear may have been disabled on a prior pick
        this.clonedMats.push(mat);
      }
    };
    // SHIRT — ~30% wear a striped Breton sailor's shirt (texture swap, navy or red), the rest a plain tinted linen.
    const shirtMesh = findMesh('Shirt');
    if (shirtMesh && shirtMesh.material instanceof PBRMaterial && rng() < 0.3) {
      const stripe = rng() < 0.6 ? 'shirt_stripe_navy' : 'shirt_stripe_red';
      let tex = this.texCache.get(stripe);
      if (!tex) { tex = new Texture(`${this.baseUrl}crew_skins/${stripe}.webp`, this.scene, undefined, false); this.texCache.set(stripe, tex); }
      const mat = shirtMesh.material.clone(`shirt_${this.clonedMats.length}`);
      mat.albedoTexture = tex; mat.albedoColor = new Color3(1, 1, 1); mat.zOffset = -1;
      shirtMesh.material = mat; this.clonedMats.push(mat);
    } else tintMesh('Shirt', pick(SHIRT), -1);
    tintMesh('Breeches', pick(BREE), -1);
    tintMesh('Sash', pick(SASH), -4);
    tintMesh('Boots', pick(BOOT), -1);
    // OUTER LAYER — one of none / waistcoat (Vest) / longcoat (Coat). Women favour none or the vest (the heavy coat
    // hides the female silhouette). Hide the layer not chosen; Vest is a flat mat → linearize its swatch.
    const VEST = [[0.24, 0.17, 0.10], [0.30, 0.30, 0.32], [0.14, 0.16, 0.26], [0.40, 0.12, 0.10], [0.18, 0.22, 0.15], [0.10, 0.10, 0.12]];
    const ro = rng();
    const outer = female ? (ro < 0.30 ? 'Vest' : ro < 0.45 ? 'Coat' : 'none')
                         : (ro < 0.28 ? 'Vest' : ro < 0.60 ? 'Coat' : 'none');
    for (const g of ['Vest', 'Coat']) { if (g !== outer) findMesh(g)?.setEnabled(false); }
    if (outer === 'Vest') tintMesh('Vest', pick(VEST), -2, true);
    else if (outer === 'Coat') tintMesh('Coat', pick(COAT), -3);
    // HEADWEAR — exactly ONE of bare / bandana / knit cap / tricorn (weighted; women favour the head-scarf). Hide the
    // three not chosen, tint the one chosen. Cap/Tricorn flat mats → linearize the swatch.
    const CAP  = [[0.30, 0.20, 0.12], [0.34, 0.34, 0.36], [0.13, 0.17, 0.30], [0.46, 0.13, 0.11], [0.64, 0.56, 0.42], [0.15, 0.24, 0.17]];
    const TRI  = [[0.05, 0.05, 0.06], [0.17, 0.11, 0.07], [0.10, 0.12, 0.22]];
    const NECK = [[0.56, 0.11, 0.09], [0.14, 0.23, 0.44], [0.82, 0.80, 0.74], [0.68, 0.54, 0.13], [0.16, 0.35, 0.19]];
    const r = rng();
    const head = female
      ? (r < 0.55 ? 'Bandana' : r < 0.74 ? 'Cap' : r < 0.82 ? 'Tricorn' : 'bare')
      : (r < 0.30 ? 'Bandana' : r < 0.58 ? 'Cap' : r < 0.72 ? 'Tricorn' : 'bare');
    for (const g of ['Bandana', 'Cap', 'Tricorn']) { if (g !== head) findMesh(g)?.setEnabled(false); }
    if (head === 'Bandana') tintMesh('Bandana', pick(BAND), -2);
    else if (head === 'Cap') tintMesh('Cap', pick(CAP), -2, true);
    else if (head === 'Tricorn') tintMesh('Tricorn', pick(TRI), -2, true);
    // NECKERCHIEF — a knotted neck cloth, independent (~35%).
    if (rng() < 0.35) tintMesh('Neckerchief', pick(NECK), -2, true); else findMesh('Neckerchief')?.setEnabled(false);
    // Per-crew FACE + SKIN — assign a real MakeHuman face/skin TEXTURE (brows, eyes, lips, skin detail + baked
    // tone) to the body's M_Skin (the eye mats are M_Eye_* so /skin/ won't catch them). This REPLACES the old flat
    // per-crew albedoColor tint: the head used to be a blank skin-coloured blob; these textures carry both the FACE
    // and the skin tone, so the deck now reads as real, varied, mixed-ethnicity sailors. Set = the official
    // MakeHuman skins (♂/♀ × african/asian/caucasian × young/middle/old). Female crew get a female face (paired
    // with the Fem body morph). STRATIFIED by skinIdx over an interleaved order so a full crew spans light→dark
    // instead of random-clustering. Tiny webp (~40 KB) from crew_skins/, cached; invertY=false matches the glTF UV
    // convention (like the legacy skin swap). The texture maps via the body's TEXCOORD_0 (kept in the GLB).
    // HAIR + BEARDS are baked into the face textures (scalp + jaw masks composited onto the MakeHuman skins, varied
    // colour) so each face is a distinct bald/haired/bearded/mustached combo across ethnicities — see crew_skins/.
    // (Texture short-hair; geometry long hair/queues is a later step. Interleaved so consecutive crew differ.)
    const MALE_SKINS = ['m_mcm_hairbeard', 'm_yam_hair', 'm_oasm_goatee', 'm_ycm_hair', 'm_mam_hairbeard',
      'm_ocm_beard', 'm_yasm_bald', 'm_masm_must', 'm_ycm_bald', 'm_yam_bald', 'm_ocm_hair', 'm_mcm_beard'];
    const FEMALE_SKINS = ['f_yaf_hair', 'f_mcf_bald', 'f_oasf_hair', 'f_ycf_hair', 'f_maf_hair'];
    const set = female ? FEMALE_SKINS : MALE_SKINS;
    const faceName = set[this.skinIdx++ % set.length];
    const body = meshes.find((mm) => mm.material instanceof PBRMaterial && /skin/i.test(mm.material.name));
    if (body && body.material instanceof PBRMaterial) {
      let tex = this.texCache.get(faceName);
      if (!tex) { tex = new Texture(`${this.baseUrl}crew_skins/${faceName}.webp`, this.scene, undefined, false); this.texCache.set(faceName, tex); }
      const mat = body.material.clone(`skin_${this.clonedMats.length}`);
      mat.albedoTexture = tex;
      mat.albedoColor = new Color3(1, 1, 1);   // texture carries tone; don't double-tint
      body.material = mat; this.clonedMats.push(mat);
    }
    // LONG HAIR — geometry drape, ONLY on a BARE head whose FACE already has (painted) hair, so the long silhouette
    // matches a haired scalp instead of a dark mass stuck on a bald head (the "white face / black back" bug). Women
    // favour it. Hair-colour tint (flat mat → linearize).
    const HAIRCOL = [[0.06, 0.045, 0.03], [0.11, 0.07, 0.04], [0.20, 0.14, 0.08], [0.46, 0.43, 0.41], [0.30, 0.16, 0.07]]; // black/brown/lt-brown/grey/auburn
    if (head === 'bare' && /hair/i.test(faceName) && rng() < (female ? 0.8 : 0.4)) tintMesh('Hair_long', pick(HAIRCOL), -1, true);
    else findMesh('Hair_long')?.setEnabled(false);
    // Per-crew STATURE — a uniform scale on the holder. The body's origin is at the feet, and the holder sits at
    // the deck-snapped station, so scaling only changes height (no float/sink) and leaves the per-frame
    // position/heading the lifecycle writes untouched. Uniform (not per-axis) avoids shearing the rotated GLB.
    const holder = glbRoot.parent as TransformNode | null;
    let stature = 0.93 + rng() * 0.13;   // ~±6% spread
    if (female) stature *= 0.95;         // women a touch shorter
    if (heavy) stature *= 1.02;          // heavyset read a little bigger
    if (holder) holder.scaling.setAll(stature);
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
      this._frame++;   // drives the far-crew half-rate tick (crew LOD, P5)
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

  /** A gun fired (P4) → crew NOT working that piece flinch/duck at the blast (the gun crew on `side` are already
   *  heaving via emphasizeGun, so skip anyone mid-burst). Call AFTER emphasizeGun so the firing crew are exempt. */
  reactToFire(_side: 'port' | 'stbd'): void {
    for (const m of this.members) {
      if (m.state !== 'station' && m.state !== 'walk') continue;
      if (m.workBurst > 0) continue;                 // the gun crew working the piece don't flinch at their own shot
      m.flinch = Math.max(m.flinch, FLINCH_FIRE);
    }
  }

  /** The ship took a hit on `side` (P4) → every hand staggers (face wince + a lurch AWAY from the struck side,
   *  matching the hull's own hit-shudder sense: port hit → lurch to starboard). A random ~half also play the full
   *  React_Hit recoil CLIP (cooldown-gated) so the deck reacts as a mix of recoils + lurches, not a robotic unison. */
  reactToHit(side: 'port' | 'stbd'): void {
    const dir = side === 'port' ? 1 : -1;
    for (const m of this.members) {
      if (m.state === 'dead' || m.state === 'reserve') continue;
      m.stagger = 1; m.staggerDir = dir;
      if (m.state === 'station' && m.reactCD <= 0 && m.rng() < HIT_CLIP_CHANCE) this.playReact(m, 'React_Hit', HIT_REACT_DUR);
    }
  }

  /** Crew celebrate (P4) — a victory cheer on the idle/stationed hands. Call on a kill / battle won. */
  reactCheer(): void {
    for (const m of this.members) {
      if (m.state === 'station' && m.reactCD <= 0 && m.rng() < 0.7) this.playReact(m, 'React_Cheer', 2.2);
    }
  }

  /** Morale BREAKS (P4) — a fraction `frac` of the stationed hands panic and cower (React_Panic, looped) for `dur`
   *  s, abandoning their work. Call on the ship sinking or heavy casualties. Refreshable (re-call to extend). */
  crewPanic(frac: number, dur: number): void {
    for (const m of this.members) {
      if ((m.state !== 'station' && m.state !== 'walk') || !m.clips.has('React_Panic')) continue;
      if (m.panicT > 0) { m.panicT = Math.max(m.panicT, dur); continue; }   // already panicking → just extend
      if (m.rng() >= frac) continue;
      m.panicT = dur;
      if (m.rng() < FLEE_FRAC && Object.keys(this.layout.waypoints).length > 1) { this.startFlee(m); }
      else { this.play(m, 'React_Panic', true); }   // freeze and cower in place at the station
    }
  }

  /** Send a panicking member scrambling to a random waypoint at a run; on arrival they pick another (or recover if
   *  the panic has lifted — handled in finishWalk). */
  private startFlee(m: CrewMember): void {
    const wp = this.randomFleeWp(m);
    if (!wp) { this.play(m, 'React_Panic', true); return; }   // no graph to flee across → cower instead
    m.fleeing = true;
    this.beginWalk(m, wp, null);   // state → 'walk'; the fleeing flag speeds it up + loops it in finishWalk
  }

  private randomFleeWp(m: CrewMember): string | null {
    const ids = Object.keys(this.layout.waypoints);
    if (!ids.length) return null;
    for (let i = 0; i < 5; i++) { const id = ids[Math.floor(m.rng() * ids.length)]; if (id !== m.wpId) return id; }
    return ids[Math.floor(m.rng() * ids.length)];
  }

  /** Play a one-shot reaction clip that overrides the work loop for `dur` s, then resume the station clip. No-op if
   *  the asset lacks the clip (older crew) — the additive pose still handles the body. */
  private playReact(m: CrewMember, clip: string, dur: number): void {
    if (m.state !== 'station' || !m.clips.has(clip)) return;
    m.reactT = dur; m.reactCD = REACT_COOLDOWN;
    this.play(m, clip, false);
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
    const start = alive;
    while (alive > t) { if (!this.killOne()) break; alive--; }
    while (alive < t) { if (!this.reviveOne()) break; alive++; }
    // Heavy casualties (P4): when losses drop the crew to a skeleton, some of the survivors' morale breaks.
    if (t < start && t <= Math.max(3, Math.floor(this.members.length * 0.4))) this.crewPanic(0.3, 6);
  }
  private firstFill = true;

  get aliveCount(): number { return this.members.filter((m) => m.state !== 'dead' && m.state !== 'reserve').length; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer) { this.scene.onBeforeRenderObservable.remove(this.observer); this.observer = null; }
    if (this.shadowCasters.length) {   // pull crew out of the shadow map before their subtree disposes
      const sg = this.scene.getLightByName('sun')?.getShadowGenerator() as ShadowGenerator | null;
      if (sg) for (const me of this.shadowCasters) sg.removeShadowCaster(me, true);
      this.shadowCasters.length = 0;
    }
    // Per-member cloned animation groups + morph managers (face morphs) are NOT freed by disposing the mesh
    // subtree, so release them explicitly before the holders go — else a churning crew leaks them.
    const seenMorph = new Set<MorphTargetManager>();
    for (const m of this.members) {
      if (m.ik) {
        for (const n of [m.ik.tgtL, m.ik.tgtR, m.ik.poleL, m.ik.poleR,
                         m.ik.footTgtL, m.ik.footTgtR, m.ik.footPoleL, m.ik.footPoleR]) n?.dispose();
        m.ik = null;
      }
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
    if (this.blobMat) { this.blobMat.diffuseTexture?.dispose(); this.blobMat.dispose(); this.blobMat = null; }
    for (const tex of this.texCache.values()) tex.dispose();   // per-handle skin albedos
    this.texCache.clear();
    this.members = [];
  }

  private static readonly LOD_FAR_M = 40;    // beyond this distance, cull the member's detail meshes + tick at half-rate + skip the face
  private static readonly LOD_NEAR_M = 32;   // re-show within this (hysteresis band avoids edge flicker)
  private static readonly FREEZE_FAR_M = 150;   // beyond this, PAUSE the animation (skeleton skipped) — motion is invisible this far off
  private static readonly FREEZE_NEAR_M = 130;  // resume within this (hysteresis)

  /** Distance LOD: hide the sub-pixel detail meshes (buckles/eyes/laces/…) when this member is far
   *  from the camera — i.e. crew on other ships. Near crew (your own deck) keep every part. */
  private tickLod(m: CrewMember): void {
    if (!m.detail.length) return;
    const d = m.lodDist;   // already computed in tick() this frame
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
      // ⚠️ Babylon ALSO uses a submesh octree to FRUSTUM-CULL submeshes at RENDER time — on the big merged ships
      // (brig/merchantman) that culls parts of the deck/furniture/rigging whenever the camera sits close on deck
      // (their octree block falls outside the frustum), so they vanish then pop back as you orbit. Turn OFF
      // render-selection so the octree only ever serves the crew raycasts, never hides visible geometry.
      if (me.getTotalVertices() > 1500) {
        try {
          const om = me as unknown as { createOrUpdateSubmeshesOctree?(c: number, d: number): void; useOctreeForRenderingSelection?: boolean };
          om.createOrUpdateSubmeshesOctree?.(64, 2);
          om.useOctreeForRenderingSelection = false;
        } catch { /* */ }
      }
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
    if (this.layout.deck_lift) m.stationPos.y += this.layout.deck_lift;   // per-ship sole-on-planks correction
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

  /** Advance an in-flight clip cross-fade (P3.2): ramp the incoming clip's weight up and the outgoing's down so
   *  their weights sum to 1 (a normalized blended pose), then stop the outgoing when the fade completes. */
  private tickBlend(m: CrewMember, dt: number): void {
    if (!m.prev) return;
    m.blend = Math.min(1, m.blend + dt / CLIP_BLEND_S);
    m.current?.setWeightForAllAnimatables(m.blend);
    m.prev.setWeightForAllAnimatables(1 - m.blend);
    if (m.blend >= 1) { m.prev.stop(); m.prev = null; }
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
    }
    // Reaction overlay (P4): a WINCE on flinch/stagger (brows up + frown + squint) and a TENSE brow as she heels
    // hard in a rough sea — max'd over the idle drift so a reaction always reads, then relaxes back as it decays.
    const react = Math.max(m.flinch, m.stagger);
    const scared = m.panicT > 0 ? 1 : 0;                                           // morale broken → a held terror face
    const tense = Math.min(1, Math.max(0, (Math.abs(this.shipHeel) - HEEL_TENSE_LO) / (HEEL_TENSE_HI - HEEL_TENSE_LO)));
    set('Blink',    Math.max(blink, react * 0.5));                                 // squint under the blast/jolt
    set('BrowsUp',  Math.max(f.cur['BrowsUp'], react * 0.40, tense * 0.22, scared * 0.55));
    set('Frown',    Math.max(f.cur['Frown'],   react * 0.45, tense * 0.18, scared * 0.5));
    set('Smile',    (react > 0.05 || scared) ? 0 : f.cur['Smile']);                // no grinning mid-flinch/panic
    set('MouthOpen', Math.max(react * 0.35, scared * 0.7));                        // a gasp on a jolt; a wide terror mouth in panic
  }

  // ── environmental grip IK (track A1+A2) ──────────────────────────────────────
  private static _ikLogged = false;       // DIAGNOSTIC: logged the bone-find once
  private static _ikActLogged = false;    // DIAGNOSTIC: logged the first activation once
  private static _footLogged = false;     // DIAGNOSTIC: logged the leg-bone axes once (knee-bend calibration)
  /** Build this member's arm-IK rig (lazy — only when first near the camera). Two BoneIKControllers steer the
   *  UpperArm/Forearm so each Hand reaches an (invisible) target node; a pole node steers the elbow. */
  private buildIK(m: CrewMember): void {
    const sk = m.skeleton, body = m.bodyMesh;
    if (!sk || !body) { m.ik = null; return; }
    const bone = (n: string): Bone | null =>
      sk.bones.find((b) => b.name === n || b.name.endsWith('.' + n) || b.name.endsWith(n)) ?? null;
    // Old pirate rig = Forearm.L/.R; the new Mixamo crew = mixamorig:Left/RightForeArm. (BoneIKController plants
    // the WRIST on the target regardless of bendAxis — bendAxis only steers the elbow — so the hands grip even
    // before any elbow calibration; the live ignis_crew_ik_bend / _pole knobs dial the elbow in.)
    const faL = this.useNew ? bone('mixamorig:LeftForeArm')  : bone('Forearm.L');
    const faR = this.useNew ? bone('mixamorig:RightForeArm') : bone('Forearm.R');
    if (!CrewHandle._ikLogged) {                  // DIAGNOSTIC (temporary): confirm the IK rig builds
      CrewHandle._ikLogged = true;
      // eslint-disable-next-line no-console
      console.log('[CrewIK] buildIK rig=', this.useNew ? 'mixamo' : 'pirate',
        'ForeArm.L=', faL?.name ?? 'NOT FOUND', 'ForeArm.R=', faR?.name ?? 'NOT FOUND',
        '| bones:', sk.bones.map((b) => b.name).join(','));
    }
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
    // Foot-plant leg IK (new Mixamo crew only): controller per shin (Leg) places the ankle on a deck target.
    const legL = this.useNew ? bone('mixamorig:LeftLeg')  : null;
    const legR = this.useNew ? bone('mixamorig:RightLeg') : null;
    if (FOOT_IK_ENABLED && legL && legR) {
      const fTgtL = node('ftgtL'), fTgtR = node('ftgtR'), fPoleL = node('fpoleL'), fPoleR = node('fpoleR');
      const fopt = (target: Mesh, pole: Mesh) => ({
        targetMesh: target, poleTargetMesh: pole, bendAxis: FOOT_BEND.clone(), poleAngle: 0,
        slerpAmount: IK_SLERP, maxAngle: Math.PI,
      });
      m.ik.footTgtL = fTgtL; m.ik.footTgtR = fTgtR; m.ik.footPoleL = fPoleL; m.ik.footPoleR = fPoleR;
      m.ik.ankleL = bone('mixamorig:LeftFoot'); m.ik.ankleR = bone('mixamorig:RightFoot');
      m.ik.footCtrlL = new BoneIKController(body, legL, fopt(fTgtL, fPoleL));
      m.ik.footCtrlR = new BoneIKController(body, legR, fopt(fTgtR, fPoleR));
      if (!CrewHandle._footLogged) {   // DIAGNOSTIC: capture the knee geometry so the bend axis can be calibrated.
        CrewHandle._footLogged = true;
        const hip = bone('mixamorig:LeftUpLeg');
        const r3 = (v: Vector3) => v.asArray().map((n) => +n.toFixed(2));
        const dir = (a?: Vector3 | null, b?: Vector3 | null) => (a && b) ? r3(b.subtract(a).normalize()) : '?';
        const hipW = hip?.getAbsolutePosition(body), kneeW = legL.getAbsolutePosition(body), ankW = m.ik.ankleL?.getAbsolutePosition(body);
        // eslint-disable-next-line no-console
        console.log('[CrewFootIK] shin=', legL.name, '| thigh→knee', dir(hipW, kneeW), 'knee→ankle', dir(kneeW, ankW),
          '| shin-localX→world', r3(legL.getDirection(new Vector3(1, 0, 0), body)),
          'Y', r3(legL.getDirection(new Vector3(0, 1, 0), body)),
          'Z', r3(legL.getDirection(new Vector3(0, 0, 1), body)));
      }
    }
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

  /** Per frame: steer a near member's hands onto a grip station (arms) and/or plant their feet on the deck (legs).
   *  Arms run only at WORK stations; feet run for any STANDING member — both player-deck-only via the near gate. */
  private tickIK(m: CrewMember, dt: number): void {
    if (!IK_ENABLED) return;
    const cam = this.scene.activeCamera;
    const standing = m.state === 'station';
    const isWork = standing && (m.stationClip === 'Work_Cannon' || m.stationClip === 'Work_Ropes');
    const near = cam
      ? Vector3.Distance(cam.globalPosition, m.holder.getAbsolutePosition()) <= (m.ikActive ? IK_GATE_FAR : IK_GATE_NEAR)
      : false;
    const wantArms = ARM_GRIP_ENABLED && isWork && near;   // off by default — canned work clips drive the arms
    const wantFeet = FOOT_IK_ENABLED && this.useNew && standing && near;   // every STANDING member plants feet (new crew only)
    // helm grip is per-ship OPT-IN too (gated on wheel_rim): the sloop's wheel is tiny & sits ~hip-low + 0.6 m
    // forward of the helmsman → unreachable standing, so it omits wheel_rim → the helmsman stands ready.
    const wantHelm = HELM_IK_ENABLED && this.useNew && standing && m.stationId === 'helm' && near
      && this.layout.wheel_rim != null;
    // gun/rope hands-on-gear are per-ship OPT-IN (the layout supplies the gear height): only ships whose gear sits
    // at a reachable height (merchantman) set gun_grip_up / rope_grip_up. Ships with low gear (brig — barrels &
    // bulwark rail at ~hip height, which a standing arm can't reach without bending) omit them → crew stand ready.
    const wantGun = GUN_IK_ENABLED && this.useNew && standing && !!m.stationId?.startsWith('gun_') && near
      && this.layout.gun_grip_up != null && m.workBurst <= 0;   // suppressed while reloading; off if ship has no gun grip
    const wantRope = ROPE_IK_ENABLED && this.useNew && standing && !!m.stationId?.startsWith('ropes_') && near
      && this.layout.rope_grip_up != null;
    if ((wantArms || wantFeet || wantHelm || wantGun || wantRope) && !m.ik) this.buildIK(m);
    if ((!wantArms && !wantFeet && !wantHelm && !wantGun && !wantRope) || !m.ik) {   // far / walking — clip drives limbs
      if (m.ikGrip > 0.001) this.setGrip(m, 0, dt);   // release the fist back to the idle curl
      m.ikActive = false;
      return;
    }
    if (!CrewHandle._ikActLogged) {        // DIAGNOSTIC (temporary): confirm IK actually activates in play
      CrewHandle._ikActLogged = true;
      // eslint-disable-next-line no-console
      console.log('[CrewIK] ACTIVATED on', m.stationId, m.stationClip, '@ arms=', wantArms, 'feet=', wantFeet,
        '— bendAxis', IK_BEND.asArray().map((v) => +v.toFixed(2)), 'gate', IK_GATE_NEAR);
    }
    m.ikActive = true;

    if (wantFeet) this.solveFeet(m);

    if (wantHelm) {
      this.solveHelm(m);
    } else if (wantGun) {
      this.solveStationGrip(m, { fwd: GUN_GRIP.fwd, up: this.layout.gun_grip_up!, spread: GUN_GRIP.spread });
    } else if (wantRope) {
      this.solveStationGrip(m, { fwd: ROPE_GRIP.fwd, up: this.layout.rope_grip_up!, spread: ROPE_GRIP.spread });
    } else if (wantArms) {
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
    } else if (m.ikGrip > 0.001) {
      this.setGrip(m, 0, dt);   // standing-but-not-working: feet plant, hands relax
    }

    // Force the skeleton to recompute (incl. the WebGPU bone texture) with the IK'd bones THIS frame. Like the
    // vessel controllers: writing bones post-clip doesn't reliably re-trigger prepare, so the GPU pose stayed at
    // the clip → the IK had no visible effect. (Cheap: only near, IK-active members reach here.)
    if (m.skeleton) { (m.skeleton as unknown as { _isDirty: boolean })._isDirty = true; m.skeleton.prepare(); }
  }

  /** Plant a standing member's ankles on the deck plane: keep each foot at its clip-posed x,z but snap its height
   *  to the station deck level, so the brace/idle-lean (which rotates the whole body about its centreline) can't
   *  lift the outboard foot off the deck or sink the inboard one. A small correction → the knees barely bend. */
  private solveFeet(m: CrewMember): void {
    const ik = m.ik;
    if (!ik || !ik.footCtrlL || !ik.footCtrlR || !m.bodyMesh) return;
    const inv = this.shipRoot.getWorldMatrix().clone(); inv.invert();
    const scale = m.holder.scaling?.y || 1;            // per-crew stature scale → ankle rides proportionally high
    const deckY = m.stationPos.y + FOOT_ANKLE_UP * scale;
    const yaw = m.yaw;
    const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const place = (ankle: Bone | null | undefined, tgt: Mesh | undefined, pole: Mesh | undefined) => {
      if (!ankle || !tgt || !pole) return;
      const fl = Vector3.TransformCoordinates(ankle.getAbsolutePosition(m.bodyMesh!), inv);   // ship-local, clip pose
      tgt.position.set(fl.x, deckY, fl.z);
      tgt.computeWorldMatrix(true);
      pole.position.set(fl.x + fwd.x * FOOT_KNEE_FWD, deckY + FOOT_KNEE_UP * scale, fl.z + fwd.z * FOOT_KNEE_FWD);
      pole.computeWorldMatrix(true);
    };
    place(ik.ankleL, ik.footTgtL, ik.footPoleL);
    place(ik.ankleR, ik.footTgtR, ik.footPoleR);
    ik.footCtrlL.update();
    ik.footCtrlR.update();
  }

  /** Find the ship's wheel: the `B_Wheel` bone on the (non-crew) ship skeleton, + the mesh that owns it (for
   *  world-position reads). Cached; returns null on ships with no wheel (tiller boats) → helm IK simply skips. */
  private getWheelBone(): Bone | null {
    if (this.wheelTried) return this.wheelBone;
    this.wheelTried = true;
    for (const mesh of this.shipRoot.getChildMeshes(false)) {
      let isCrew = false;
      for (let a: Nullable<Node> = mesh; a; a = a.parent) {
        if (a.name?.startsWith('crew_') || a.name?.startsWith('ik_')) { isCrew = true; break; }
      }
      if (isCrew) continue;
      const sk = (mesh as { skeleton?: Skeleton }).skeleton;
      if (!sk) continue;
      const b = sk.bones.find((bo) => bo.name === 'B_Wheel' || bo.name.endsWith('B_Wheel') || /B_Wheel/i.test(bo.name));
      if (b) { this.wheelBone = b; this.wheelBody = mesh; return b; }
    }
    return null;
  }

  /** Helmsman's hands on the SHIP'S WHEEL — real-gear placement. Targets the rim at ~10 & 2 o'clock relative to the
   *  actual B_Wheel hub (athwart = the helmsman's right, up = ship up), using the calibrated arm IK (bendAxis/pole).
   *  Falls back to nothing on wheel-less ships. */
  private solveHelm(m: CrewMember): void {
    const ik = m.ik; const wb = this.getWheelBone();
    if (!ik || !wb || !this.wheelBody) return;
    const inv = this.shipRoot.getWorldMatrix().clone(); inv.invert();
    const hub = Vector3.TransformCoordinates(wb.getAbsolutePosition(this.wheelBody), inv);   // wheel hub, ship-local
    // SANITY GUARD: only grip the wheel if it's actually within arm's reach of the helm station. Some ships have
    // the helm station placed far from the B_Wheel geometry (e.g. merchantman wheel is ~16 m off) or the wheel
    // isn't skinned to B_Wheel (brig) — in those cases DON'T stretch the helmsman's arms across the deck; just let
    // the clip play. (When the ship assets are fixed so the helm station sits at the wheel, this lights up.)
    if (Vector3.Distance(hub, m.stationPos) > 1.5) return;
    const yaw = m.yaw;
    const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));    // helmsman forward (toward the wheel)
    const rgt = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));   // helmsman right (≈ wheel athwart axis)
    const R = this.layout.wheel_rim ?? HELM_RIM_R;   // per-ship wheel size
    const place = (mesh: Mesh, sign: number) => {   // hands at upper rim (≈11 & 1): out ±0.55R, up 0.35R (verified reach)
      mesh.position.copyFrom(hub).addInPlace(rgt.scale(sign * R * 0.55)).addInPlaceFromFloats(0, R * 0.35, 0);
      mesh.computeWorldMatrix(true);
    };
    place(ik.tgtL, -1); place(ik.tgtR, +1);
    const pole = (mesh: Mesh, sign: number) => {   // elbows down + out + behind the rim
      mesh.position.copyFrom(hub).addInPlace(rgt.scale(sign * (R * 0.55 + 0.30))).addInPlace(fwd.scale(-0.40))
        .addInPlaceFromFloats(0, -0.40, 0);
      mesh.computeWorldMatrix(true);
    };
    pole(ik.poleL, -1); pole(ik.poleR, +1);
    ik.ctrlL?.update();
    ik.ctrlR?.update();
  }

  /** Both hands rest on a waist-height object just forward of where the member stands — a gun barrel (gun crew) or
   *  the fife-rail pins (rope crew). The station is aligned to the real gear, so the station-relative grip G lands on
   *  it; elbows down → a standing "ready at the gear" pose. Calibrated arm IK. */
  private solveStationGrip(m: CrewMember, G: { fwd: number; up: number; spread: number }): void {
    const ik = m.ik; if (!ik) return;
    const yaw = m.yaw;
    const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));    // toward the gear (gun port / fife rail)
    const rgt = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const place = (mesh: Mesh, sign: number) => {
      mesh.position.copyFrom(m.stationPos).addInPlace(fwd.scale(G.fwd)).addInPlace(rgt.scale(sign * G.spread))
        .addInPlaceFromFloats(0, G.up, 0);
      mesh.computeWorldMatrix(true);
    };
    place(ik.tgtL, -1); place(ik.tgtR, +1);
    const pole = (mesh: Mesh, sign: number) => {   // elbows down + out + slightly back
      mesh.position.copyFrom(m.stationPos).addInPlace(rgt.scale(sign * (G.spread + 0.30))).addInPlace(fwd.scale(-0.10))
        .addInPlaceFromFloats(0, G.up - 0.50, 0);
      mesh.computeWorldMatrix(true);
    };
    pole(ik.poleL, -1); pole(ik.poleR, +1);
    ik.ctrlL?.update();
    ik.ctrlR?.update();
  }

  // ── per-member state machine ────────────────────────────────────────────────
  private tick(m: CrewMember, dt: number): void {
    if (m.state === 'reserve') return;   // unrecruited reserve: hidden, no animation/logic
    // ── Crew LOD (P5) ── distance (computed ONCE, reused by tickLod) drives three throttles, cheapest saving first.
    const cam = this.scene.activeCamera;
    if (cam) { m.lodDist = Vector3.Distance(cam.globalPosition, m.holder.getAbsolutePosition()); }
    const near = m.lodDist < CrewHandle.LOD_FAR_M;
    if (this.lod) {
      const d = m.lodDist;
      // FREEZE: very-distant crew pause their animation → Babylon stops evaluating the skeleton (the real CPU cost).
      if (d > CrewHandle.FREEZE_FAR_M) { if (!m.frozen) { m.frozen = true; m.current?.pause(); m.prev?.pause(); } return; }
      if (m.frozen) {
        if (d > CrewHandle.FREEZE_NEAR_M) return;                          // stay frozen (hysteresis band)
        m.frozen = false; m.prev = null; m.blend = 1;
        m.current?.play(m.current.loopAnimation);                          // resume (restart-from-0 is invisible this far off)
      }
      // THROTTLE: far (other-ship) crew update pose/logic at HALF rate — imperceptible past 40 m, ~halves the JS cost.
      if (!near) { if ((this._frame + m.lodPhase) & 1) return; dt *= 2; }  // ×2 dt keeps decays/dwell wall-clock-correct
    }
    this.tickBlend(m, dt);
    if (near || !this.lod) { this.tickFace(m, dt); }   // faces are sub-pixel past ~40 m — skip the morph churn for far crew
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
      // Reactions (P4): decay the transient startles, then add their duck (flinch) / sideways lurch (stagger) to
      // the brace pose. The face wince is driven in tickFace from the same flinch/stagger levels.
      if (m.flinch > 0)  m.flinch  = Math.max(0, m.flinch  - dt / FLINCH_DECAY);
      if (m.stagger > 0) m.stagger = Math.max(0, m.stagger - dt / STAGGER_DECAY);
      // The lurch pose is for crew NOT playing the recoil CLIP (reactT>0) — the clip poses their body itself.
      pitch += FLINCH_DUCK_P * m.flinch + (m.reactT > 0 ? 0 : STAGGER_PITCH * m.stagger);
      roll  += m.reactT > 0 ? 0 : STAGGER_ROLL * m.stagger * m.staggerDir;
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
      m.holder.position.y = m.stationPos.y + Math.sin(this.clock * 0.9 + m.swayPhase) * IDLE_BOB
        - (FLINCH_DUCK_Y * m.flinch + (m.reactT > 0 ? 0 : STAGGER_DUCK_Y * m.stagger));   // crouch under the blast / jolt down on a hit

      // Gun-fire loading (P3): right after their broadside, gun crew break from manning the piece into a heave/load
      // motion (emphasizeGun set workBurst on fire), then settle back to hands-on-the-gun. While loading, the clip
      // drives the arms (tickIK suppresses the gun grip-IK on workBurst>0) so the motion reads as real work.
      // One-shot reaction CLIP (P4): a recoil (React_Hit) / point / cheer overrides the work loop for its window,
      // then resumes the station clip. While it plays, the work-burst + glance logic below is suspended.
      if (m.reactCD > 0) m.reactCD = Math.max(0, m.reactCD - dt);
      if (m.panicT > 0) {
        m.panicT -= dt;                                  // morale broken: cowering (React_Panic loops); back to work when it lifts
        if (m.panicT <= 0) this.play(m, m.stationClip, true);
      } else if (m.reactT > 0) {
        m.reactT -= dt;
        if (m.reactT <= 0) this.play(m, m.stationClip, true);
      } else {
        if (m.workBurst > 0) {
          m.workBurst = Math.max(0, m.workBurst - dt);
          if (m.stationId?.startsWith('gun_') && m.glanceT <= 0) {
            const loading = m.workBurst > 0;
            this.play(m, loading ? GUN_LOAD_CLIP : m.stationClip, true);   // heave while loading → resume manning
            m.yawTarget = m.stationYaw + (loading ? LOAD_YAW_OFFSET : 0);   // angle the body so the diagonal pull faces the gun
          }
        }
        // Glance (P3): occasionally break off to look about (Lookout) — and sometimes POINT at the horizon (React_Point,
        // a lookout calling a sail). Resume the station clip when it ends.
        if (m.glanceT > 0) {
          m.glanceT -= dt;
          if (m.glanceT <= 0) this.play(m, m.stationClip, true);
        } else if (m.workBurst <= 0 && m.dwell > 5 && m.clips.has('Lookout') && m.rng() < GLANCE_CHANCE * dt) {
          const point = m.clips.has('React_Point') && m.rng() < POINT_GLANCE_CHANCE;
          m.glanceT = point ? 4.5 : 2 + m.rng() * 2.5;
          this.play(m, point ? 'React_Point' : 'Lookout', !point);   // the point gesture plays once; Lookout loops
        }
        if (m.glanceT <= 0 && m.current) {   // frantic loading right after the shot, decaying
          m.current.speedRatio = m.animSpeed * (1 + WORK_BURST_GAIN * (m.workBurst / WORK_BURST_DUR));
        }
      }
    }

    // Environmental grip IK (track A): plant working hands on the station + close the fingers. Runs every frame
    // for near (player-deck) members; internally a no-op when far / not at a work station. Animations are already
    // evaluated by the time onBeforeRender fires, so this cleanly overrides the arm pose post-clip. Suspended while
    // a reaction clip plays (P4) — the recoil/point/cheer needs its own arms, not the gun grip.
    if (m.reactT <= 0 && m.panicT <= 0) this.tickIK(m, dt);

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
    if (g && !ladder) g.speedRatio = m.animSpeed * Math.max(0.35, this.legSpeed(kind) / this.walkSpeed) * STRIDE_SCALE * (m.fleeing ? FLEE_SPEED_MUL : 1);
  }

  private tickWalk(m: CrewMember, dt: number): void {
    if (m.fleeing && m.panicT > 0) m.panicT = Math.max(0, m.panicT - dt);   // (P4) panic decays while scrambling
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
    const speed = this.legSpeed(leg.kind) * turnSlow * (m.fleeing ? FLEE_SPEED_MUL : 1);
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
    // Panic flee (P4): while morale is still broken, keep scrambling to another random spot; once it lifts, return
    // to a post (or idle if none is free).
    if (m.fleeing) {
      if (m.panicT > 0) { this.startFlee(m); return; }
      m.fleeing = false;
      const st = this.pickStation(m);
      if (st) { this.arriveAt(m, st, false); return; }
      m.state = 'station'; m.dwell = 3; this.play(m, 'Idle', true); return;
    }
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
    m.fleeing = false;   // settled at a post → no longer fleeing (P4)
    m.stationPos.set(st.pos[0], st.pos[1], st.pos[2]);   // sway anchor (P1)
    // Plant the feet on the real deck, clear of furniture — EXCEPT seats, which intentionally sit ON a
    // thwart/bench (the open-deck search would shove a rower off his thwart onto the sole).
    if (st.kind !== 'seat') this.deckSnapStation(m);
    m.stationClip = st.clip; m.glanceT = 0;              // remember the work clip to resume after a glance (P3)
    // Long task dwell — crew settle into a job and only occasionally rotate.
    m.dwell = 45 + m.rng() * 75;
    m.yawTarget = m.stationYaw = (st.heading_deg * Math.PI) / 180;
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
    // Fall back to Idle for clips the asset doesn't have. The new crew ships only Idle/Walk, so station
    // clips (Work_Cannon/Work_Ropes/Lookout/Sit/Climb) resolve to Idle until P2 brings the work animations.
    const g = m.clips.get(name) ?? m.clips.get('Idle') ?? null;
    if (!g) return null;
    if (m.current === g && loop) return g;
    // Cross-fade (P3.2): rather than hard-cut, keep the outgoing clip playing at full weight and ramp it down
    // while `g` ramps up (tickBlend, weights summing to 1). Only ever two clips blend at once — collapse any
    // still-in-flight fade to its target first so weights can't drift.
    if (m.prev) { m.prev.stop(); m.prev = null; }
    if (m.current && m.current !== g) {
      m.prev = m.current;
      m.prev.setWeightForAllAnimatables(1);
      m.blend = 0;
    } else {
      m.blend = 1;
    }
    g.start(loop, m.animSpeed);
    g.setWeightForAllAnimatables(m.prev ? 0 : 1);
    const resolved = g.name.replace(/\.\d{3,}$/, '');
    if (loop && (resolved === 'Idle' || resolved === 'Walk')) {
      // Desync loops so the crew don't move in lockstep.
      g.goToFrame(g.from + m.rng() * (g.to - g.from));
    }
    m.current = g;
    return g;
  }
}
