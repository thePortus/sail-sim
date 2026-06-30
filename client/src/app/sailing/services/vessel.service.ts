import { Injectable, NgZone, effect, inject, signal } from '@angular/core';
import {
  MeshBuilder, Vector3, Color3, Color4, StandardMaterial, PBRMaterial, Mesh, Material,
  AbstractMesh, TransformNode, DynamicTexture, ParticleSystem, Scene, PointerEventTypes, PointLight,
  DirectionalLight, Ray,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';   // registers GLB/GLTF plugin with SceneLoader
import { SceneService } from './scene.service';
import { TerrainService } from './terrain.service';
import { OceanService }  from './ocean.service';
import { bakeHullCutProfile, bakeHullSilhouette, buildHullStencilProxy } from './ocean-fft/hull-cut-mask';
import { VesselBuoyancyService } from './vessel-buoyancy.service';
import { VesselAssetCacheService } from './vessel-asset-cache.service';
import { VesselController, createVesselController, applyShipMetalEnv, rigForSlug, baseYawDegFor, floatDraftFor, maskFloorFor, VesselRig, SailRig } from './vessel-controller';
import { applyFlagColor, flagColor3, FlagColorHandle } from './flag-color';
import { CrewService, CrewHandle, crewSeedFrom } from './crew.service';
import { CombatService } from './combat.service';
import { MastCrackService } from './mast-crack.service';
import { listingFor, capsizeFor, zoneHpFor, sinkProgress, SINK_DEPTH,
         mastHealth, mastSpeedMult, MAST_DOWN_TURN_MAX } from './combat.constants';
import { Vessel, VesselPart, VesselCannon, SailState, Wind, SeaConditions, VesselState, VesselPhysics } from '../models';

// The rigged GLB + manifest are now resolved per-vessel (see this.rig in init / vessel-controller.ts).

@Injectable({ providedIn: 'root' })
export class VesselService {
  private sceneService     = inject(SceneService);
  private terrainService   = inject(TerrainService);
  private oceanService     = inject(OceanService);
  private buoyancyService  = inject(VesselBuoyancyService);
  private assetCache       = inject(VesselAssetCacheService);
  private crewService      = inject(CrewService);
  private combatService    = inject(CombatService);
  private mastCrackService = inject(MastCrackService);
  private zone             = inject(NgZone);

  /** Previous mast-health fraction, for one-shotting the demasting crack on the 0-crossing (−1 = unset). */
  private prevMastH = -1;

  /** Animated deck crew on the local vessel (null until the GLB + crew assets load). */
  private crewHandle: CrewHandle | null = null;

  /** Per-vessel flag-colour override (null until the GLB loads). */
  private flagHandle: FlagColorHandle | null = null;
  /** The player's custom flag colour (#rrggbb) — applied to the flags whenever they (re)build; via setFlagColor. */
  private flagColor = '#b22222';

  /** Reflect the authoritative crew count onto the deck as it changes — grapeshot casualties drop, tavern
   *  hires return. Runs in the injection context (field initializer); the handle may be null early (guarded). */
  private readonly _crewCasualtySync = effect(() => {
    const n = this.combatService.crew();
    this.crewHandle?.setAliveCount(n);
  });

  // ── Public reactive state ─────────────────────────────────────────────────
  grounded = signal<boolean>(false);
  /** True while the anchor is down (boat parked/tethered). */
  anchored = signal<boolean>(false);
  /** True while auto-steering toward a berth (the docking glide; input is ignored during it). */
  docking = signal<boolean>(false);
  /** True while moored at a berth — helm + throttle frozen (like anchored) until castOff(). */
  tiedUp = signal<boolean>(false);

  state = signal<VesselState>({
    x: 7200, z: 0, heading: 270, speed: 0,
    sailState: 'reefed', windAngle: 90, isPortTack: false, heelAngle: 0,
    sheetAngle: 30, trimQuality: 1, anchored: false, anchorSide: 'S',
  });

  // ── Physics ────────────────────────────────────────────────────────────────
  private x          = 7200;
  private z          = 0;
  private heading    = 270;   // compass bearing 0=N(+Z) 90=E(+X)
  private speed      = 0;
  private prevHeading       = 270;   // last frame's heading, for angular-velocity calc
  private turnRateSmoothed  = 0;     // smoothed heading deg/s, broadcast for remote dead-reckoning
  private sailState:  SailState = 'reefed';
  private isGrounded: boolean   = false;

  private physics: VesselPhysics = {
    maxSpeed: 8, accelerationRate: 0.25, minTackAngle: 38, sailAreaFactor: 0.32, weight: 2800,
  };

  // ── Realistic physics v2 (force-based; gated by localStorage.ignis_physics='v2') ──────────────────
  // P1: apparent wind + drive-vs-quadratic-drag + mass momentum. Calibrated to keep ~current top speeds
  // (hand-checked vs the legacy lag model at wind 9 m/s). Constants are global for P1; per-rig polars
  // arrive in P3. See sailing-physics-roadmap. Trim/turn/in-irons stay on the legacy model until P2/P4.
  // v2 force-based sailing is now the DEFAULT; opt back to the old model with localStorage.ignis_physics='legacy'.
  private readonly physV2 = !(typeof localStorage !== 'undefined' && localStorage.getItem('ignis_physics') === 'legacy');
  // The tuning overlay is off by default now; show it again with localStorage.ignis_physics_debug='1'.
  private readonly physDebugOn = (typeof localStorage !== 'undefined' && localStorage.getItem('ignis_physics_debug') === '1');
  private readonly SAIL_FORCE_K   = 0.26;    // drive scale: thrust = K·sailAreaFactor·driveC·V_app²
  private readonly DRAG_K         = 1.0;     // hull drag: F = DRAG_K·v² (quadratic) — sets where drive=drag
  private readonly FORCE_RESPONSE = 0.04;    // accel gain (sets momentum/time-constant; lower = weightier)
  private readonly WEIGHT_REF     = 2800;    // sloop weight → massK = physics.weight / WEIGHT_REF
  private prevSpeedMod = 0;                  // last frame's buoy.speedModifier, fed back as wave-surf accel
  private trimQ = 1;                         // last frame's trim quality (0..1) at the drive angle — for the HUD
  // P4 turning realism (v2): the helm commands a TARGET yaw rate that eases in (angular inertia) instead of
  // snapping; hard turns scrub speed (broadside drag); and a stalled bow head-to-wind is gently blown off
  // the eye so you can never be permanently stuck in irons (recoverable).
  private yawRate = 0;                       // current heading rate (deg/s); eased toward the rudder target
  private readonly YAW_RESPONSE   = 4;       // how fast yaw eases to target (1/s; ~0.25 s time constant)
  private readonly TURN_SCRUB     = 0.06;    // speed lost to turning: extra drag = TURN_SCRUB·|yaw|·|speed|
  private readonly IRONS_FALLOFF  = 6;       // deg/s the wind blows the bow off the eye when stalled in irons
  // P5 sea-state + reefing (v2): heel comes from wind SIDE-FORCE (not speed); over-canvassed sails heel past
  // comfort and SPILL wind → forward drive drops, so reefing pays in a blow and full sail wins in light air.
  // Rough/head seas add drag. Heel feeds the visual lean + leeway.
  private heelV2 = 0;                         // current wind-pressure heel (deg, magnitude) under v2
  private heelSpill = 0;                      // 0..1 over-canvassed wind-spill (also the HUD "reef" hint)
  private readonly HEEL_K        = 0.22;      // heel = HEEL_K·SAF·canvas·V_app²·sin(angle), capped below
  private readonly COMFORT_HEEL  = 16;        // ° before the sail starts spilling wind
  private readonly SPILL_RANGE   = 14;        // ° of heel over comfort that ramps spill 0→1
  private readonly SPILL_MAX     = 0.75;      // max forward-drive fraction lost to an over-pressed (heeled) sail
  private readonly MAX_HEEL_VIS  = 26;        // ° cap on the visual/leeway heel
  private readonly SEA_DRAG_K    = 0.06;      // chop resistance: extra drag = SEA_DRAG_K·rough·(0.5+intoSea)·|v|
  /** Live force-model telemetry for the tuning overlay (only set when physV2). null on the legacy model. */
  physDebug = signal<{ appAngle: number; appWind: number; trueAngle: number; thrust: number; drag: number; speed: number; vmg: number; trim: number; heel: number; reef: boolean } | null>(null);

  /**
   * Seconds the vessel has been continuously blocked by land.
   * The aground signal only fires once this exceeds GROUNDED_DELAY,
   * so glancing contacts (headland scrape, tight manoeuvre) don't
   * trigger the overlay — only a genuine, sustained grounding does.
   */
  private groundedTime  = 0;
  private readonly GROUNDED_DELAY = 5.0;   // seconds of continuous blocking → aground

  // ── Mesh handles ──────────────────────────────────────────────────────────
  private root!:         TransformNode;


  // ── Rigged vessel animation driver (single GLB: skeleton clips + morphs) ────
  private controller: VesselController | null = null;
  private vesselSlug = 'sloop';
  private rig: VesselRig = rigForSlug('sloop');
  /** World starboard in vessel-local X (+1 = +X, −1 = −X). Used by sign-sensitive visuals (Phase E). */
  rightSign: 1 | -1 = 1;
  /** Per-vessel gun layout from the server vessel def (null → CannonService default sloop battery). */
  private vesselCannons: { port: VesselCannon[]; stbd: VesselCannon[] } | null = null;

  // Water-contact shadow projected beneath the hull.
  private waterShadow: Mesh | null = null;
  private waterShadowMat: StandardMaterial | null = null;
  /** Hull-stencil proxy (stencil mode only) — masks the FFT sea out of the open hull. Parented to root. */
  private hullStencilCap: Mesh | null = null;

  // ── PBR material / texture pools ─────────────────────────────────────────
  private matPool         = new Map<string, PBRMaterial>();
  private texPool         = new Map<string, DynamicTexture>();

  // ── Cannon recoil ────────────────────────────────────────────────────────
  // Shot-triggered lateral roll impulse model (spring + damper):
  //   shot applies angular-velocity impulse away from firing side,
  //   then hull naturally returns with heavy naval damping.
  private recoilRoll = 0;
  private recoilRollVel = 0;
  // Damage listing — eased toward the tilt from our own hull state (combatService.zones).
  private listRoll  = 0;
  private listPitch = 0;
  // Sink/capsize: while `sinking`, a 0→1 progress (from `sinkStartT`) settles the hull deep and rolls it
  // over toward the damaged side; held at the wreck pose until repair, then eased back out.
  private sinking    = false;
  private sinkStartT = 0;     // sim time `t` at which the sinking began
  private sinkEnv    = 0;     // applied progress (eased out on repair)
  private readonly RECOIL_SPRING = 7.2;
  private readonly RECOIL_DAMPING = 5.8;
  private readonly RECOIL_IMPULSE = 0.40;   // rad/s heel kick PER shot
  private readonly RECOIL_MAX_ROLL = 0.17;  // ~9.7° hard safety cap

  // Lateral shudder: a damped sideways lurch AWAY from the firing side (fire
  // starboard → hull jolts to port), layered on top of the sim position.
  private recoilSway = 0;
  private recoilSwayVel = 0;
  private readonly RECOIL_SWAY_SPRING  = 9.0;
  private readonly RECOIL_SWAY_DAMPING = 6.0;
  private readonly RECOIL_SWAY_IMPULSE = 0.95;  // m/s lateral kick PER shot
  private readonly RECOIL_SWAY_MAX     = 0.95;  // m hard cap

  // Hit shudder — a SEPARATE, much heavier roll+sway transient for taking a cannonball
  // (so it reads as violent without changing the tuned firing recoil).
  private hitRoll = 0;
  private hitRollVel = 0;
  private hitSway = 0;
  private hitSwayVel = 0;
  private readonly HIT_SPRING       = 8.5;
  private readonly HIT_DAMPING      = 4.6;
  private readonly HIT_ROLL_IMPULSE = 1.1;   // rad/s — violent heel
  private readonly HIT_SWAY_IMPULSE = 2.6;   // m/s — violent lurch
  private readonly HIT_MAX_ROLL     = 0.34;  // ~19° cap
  private readonly HIT_MAX_SWAY     = 1.8;   // m cap

  // Camera shake (trauma model): firing and taking a hit add trauma; updateCamera applies a decaying,
  // high-frequency positional jitter scaled by trauma² (punchy falloff). The offset is removed before the
  // follow-ease each frame so it never feeds back into the camera's base position.
  private camTrauma = 0;
  private shakeTime = 0;   // oscillation clock — reset when a fresh shake starts so it swings from zero
  private readonly camShakeOffset = new Vector3();
  private readonly CAM_TRAUMA_DECAY = 0.6;    // SLOW decay → the shake rings for ~1 s (not a single flick)
  private readonly CAM_SHAKE_MAX    = 1.2;    // max camera position offset (m) at trauma = 1
  private readonly CAM_SHAKE_FREQ   = 12.6;   // rad/s ≈ 2 Hz → a visible back-and-forth, not a fast jitter
  // 3rd-person amplifiers (a fixed metre offset is invisible 60 m out): distance-compensate the positional
  // shake so it reads the same at any zoom, and add a higher-frequency ROTATIONAL view jolt — the part that
  // makes it feel jarring rather than a gentle drift. (First-person is untouched — it sits ON the eye.)
  private readonly SHAKE_DIST_REF   = 12;     // camDist (m) at which the positional shake is 1×
  private readonly SHAKE_DIST_MAX   = 2;      // cap on the distance scale so a far zoom doesn't over-shake
  private readonly CAM_SHAKE_ROT    = 0.02;   // view-jolt angle (rad, ~2.9°) at trauma = 1 — the jarring kick

  /** Add camera-shake trauma (0..1, clamped). Trauma decays in updateCamera. */
  addShakeTrauma(amount: number): void {
    if (this.camTrauma < 0.01) { this.shakeTime = 0; }   // fresh shake → start the swing from zero
    this.camTrauma = Math.min(1, this.camTrauma + amount);
  }

  /** Heavy shudder from taking a cannonball on the given struck side. */
  addHitShudder(side: 'port' | 'stbd'): void {
    const dir = side === 'port' ? 1 : -1;
    this.hitRollVel += dir * this.HIT_ROLL_IMPULSE;
    this.hitSwayVel += dir * this.HIT_SWAY_IMPULSE;
    this.addShakeTrauma(0.85);   // taking a hit: a big, ringing shake (~2-3 swings)
  }

  addCannonRecoil(side: 'port' | 'stbd'): void {
    // Reaction shoves the hull AWAY from the firing side: a port broadside heels +
    // lurches to starboard (+Z roll, +sway), a starboard broadside to port.
    const dir = side === 'port' ? 1 : -1;
    this.recoilRollVel += dir * this.RECOIL_IMPULSE;
    this.recoilSwayVel += dir * this.RECOIL_SWAY_IMPULSE;
    this.addShakeTrauma(0.32);   // per shot — a broadside (3 shots) stacks toward a big jolt
  }

  // ── Gunnery animation delegators (CannonService → SloopController) ──────────
  // Map game-layer 'port'/'stbd' to the model's 'S'/'P' bone-side codes in ONE place.
  // Verified at runtime: the model's 'P' bones sit on the vessel's port (−x) side, which
  // matches the port muzzle offsets — so game 'port' drives the model's 'P' clips.
  private gunSide(side: 'port' | 'stbd'): 'S' | 'P' { return side === 'port' ? 'P' : 'S'; }

  /** 0 = stowed (gun in, ports closed) .. 1 = ready (ports open, gun run out). */
  setGunDeploy(side: 'port' | 'stbd', t: number): void {
    this.controller?.setGunDeployTarget(this.gunSide(side), t);
  }
  /** Recoil kick on a side (call once per cannon shot). */
  addGunRecoilKick(side: 'port' | 'stbd', kick = 0.7): void {
    this.controller?.addGunRecoil(this.gunSide(side), kick);
  }
  /** A gun on `side` just fired → the deck crew at that side's gun stations work harder for a beat (crew P3). */
  crewGunWork(side: 'port' | 'stbd'): void {
    this.crewHandle?.emphasizeGun(side);
  }
  /** True once a side has finished running out (safe to fire). */
  isGunReady(side: 'port' | 'stbd'): boolean {
    return this.controller?.isGunReady(this.gunSide(side)) ?? false;
  }
  /** True once a side's stow animation + recoil have fully settled. */
  isGunSettled(side: 'port' | 'stbd'): boolean {
    return this.controller?.gunSettled(this.gunSide(side)) ?? true;
  }
  /** Per-ship reload window (seconds), stretched when short-handed: fewer gun crew → slower reload (up to ~2×
   *  with no crew, via the 0.5 crew-efficiency floor). The cannon service reads this for both the progress bar
   *  and the reload-complete check, so the whole gun cycle slows with crew losses. */
  getReloadWindow(): number { return (this.physics.reloadWindow ?? 6) / this.combatService.crewFactor(); }

  /** Returns the vessel root TransformNode. Used by CannonService to parent cannon pivots. */
  getRoot(): TransformNode { return this.root; }

  /** Per-vessel muzzle layout (vessel-local offsets per side), or null to use CannonService's default. */
  getCannons(): { port: VesselCannon[]; stbd: VesselCannon[] } | null { return this.vesselCannons; }

  // ── Sheet (sail trim) ─────────────────────────────────────────────────────
  // sheetAngleDeg: degrees from the boat's centreline the boom swings out.
  //   5 = close-hauled (sail sheeted hard in)
  //  88 = fully eased (sail right out, running downwind)
  // The player adjusts with Q (ease) / E (haul in).
  private sheetAngleDeg = 30;    // sensible default for a reaching start

  // ── Anchor (parking) ───────────────────────────────────────────────────────
  // While anchored the boat is tethered within ANCHOR_RADIUS of the drop point: it can
  // sail/drift only a metre or two before the rode snubs taut, and can't drift in current.
  private isAnchored   = false;
  private anchorSide: 'S' | 'P' = 'S';   // which anchor dropped (random per drop)
  private anchorX      = 0;
  private anchorZ      = 0;
  private anchorDeploy = 0;              // animated 0=stowed .. 1=lowered
  private readonly ANCHOR_RADIUS = 2.5;  // metres of scope before the rode snubs

  /** Drop or weigh anchor (P key / HUD button). Dropping picks a random side. */
  toggleAnchor(): void {
    this.isAnchored = !this.isAnchored;
    if (this.isAnchored) {
      this.anchorSide = Math.random() < 0.5 ? 'S' : 'P';
      this.anchorX = this.x;
      this.anchorZ = this.z;
    }
    this.anchored.set(this.isAnchored);
  }

  // ── Docking (auto-moor to a pier berth) ──────────────────────────────────────
  // dockAt() eases the boat from its current pose to a tie-up point over a short glide (player input
  // ignored during it), then PINS it there — tied up, like an anchor with zero scope — until castOff().
  // Position-only: buoyancy still bobs the hull. No tie-rope animation (per design).
  private dockPhase: 'free' | 'approaching' | 'tied' = 'free';
  private dockElapsed = 0;
  private dockDuration = 0;
  private dockStartX = 0; private dockStartZ = 0; private dockStartHdg = 0;
  private dockBerthX = 0; private dockBerthZ = 0; private dockBerthHdg = 0;

  /** Begin auto-steering to a berth: glide to (x,z,heading°) then moor. No-op if already docking/tied. */
  dockAt(berth: { x: number; z: number; heading: number }): void {
    if (this.dockPhase !== 'free' || !this.root) { return; }
    this.isAnchored = false; this.anchored.set(false);   // can't be anchored AND tied
    this.dockStartX = this.x; this.dockStartZ = this.z; this.dockStartHdg = this.heading;
    this.dockBerthX = berth.x; this.dockBerthZ = berth.z;
    this.dockBerthHdg = ((berth.heading % 360) + 360) % 360;
    const dist = Math.hypot(berth.x - this.x, berth.z - this.z);
    this.dockDuration = Math.min(4, Math.max(1.4, dist / 6));   // ~6 m/s glide, clamped 1.4–4 s
    this.dockElapsed = 0;
    this.dockPhase = 'approaching';
    this.docking.set(true);
    this.keys.left = this.keys.right = this.keys.sheetIn = this.keys.sheetOut = false;
    this.speed = 0;
  }

  /** Cast off the mooring so the helm/throttle answer again. */
  castOff(): void {
    if (this.dockPhase === 'free') { return; }
    this.dockPhase = 'free';
    this.docking.set(false);
    this.tiedUp.set(false);
  }

  /** Shortest signed delta a→b in degrees, in [-180, 180] (for berth-heading interpolation). */
  private angleDeltaDeg(a: number, b: number): number {
    return ((b - a) % 360 + 540) % 360 - 180;
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  private keys = { left: false, right: false, sheetIn: false, sheetOut: false };
  private keyHandler!:    (e: KeyboardEvent) => void;
  private keyUpHandler!:  (e: KeyboardEvent) => void;
  private repeatSwallow!: (e: KeyboardEvent) => void;
  private wheelHandler!:  (e: WheelEvent) => void;
  private pointerObserver: any = null;

  // ── Camera orbit ──────────────────────────────────────────────────────────
  private camAzimuth   = 0;    // degrees offset from dead-astern (0 = behind vessel)
  private camElevation = 22;   // degrees above horizon
  private camDist      = 24;   // follow distance (units)
  private isDragging   = false;

  // ── First-person ("on deck") camera ────────────────────────────────────────
  /** On = camera sits at the deck eye point (fpEye) looking forward; drag = free-look. */
  readonly firstPerson = signal(false);
  private fpEye: Vector3 | null = null;   // vessel-local eye position (from the server vessel def)
  private fpYaw   = 0;   // free-look yaw offset from the bow (deg)
  private fpPitch = 0;   // free-look pitch (deg, + = up)
  private invertCamY = false;   // invert the vertical look axis (settings toggle 'ignis_invert_camera'); read per-drag

  // Deck-walk: while ON DECK (first-person) with the LEFT BUTTON HELD, WASD/arrows walk the eye across the deck.
  // The eye Y is clamped to a downward raycast onto the ship's deck geometry every frame, so it rides up the
  // stairs to the quarterdeck and back down to the main deck on ANY ship. Keys are read each frame by updateCamera.
  private walk = { fwd: false, back: false, left: false, right: false };
  private deckCamMeshes: AbstractMesh[] | null = null;   // cached ship structural meshes for the walk raycast
  private readonly WALK_SPEED = 4.5;   // m/s across the deck
  private readonly WALK_EYE   = 1.65;  // standing eye height above the planks

  private clearWalk(): void { this.walk.fwd = this.walk.back = this.walk.left = this.walk.right = false; }

  toggleFirstPerson(): void {
    this.firstPerson.update(v => !v);
    if (!this.firstPerson()) this.clearWalk();
  }

  /** Current free-look camera offset in degrees — third-person orbit (azimuth from dead-astern + elevation),
   *  or the first-person look offset when on deck. Used by the intro tutorial to detect "look about your ship". */
  cameraOrbit(): { azimuth: number; elevation: number } {
    return this.firstPerson()
      ? { azimuth: this.fpYaw, elevation: this.fpPitch }
      : { azimuth: this.camAzimuth, elevation: this.camElevation };
  }
  private lastMouseX   = 0;
  private lastMouseY   = 0;

  // ── Weather ────────────────────────────────────────────────────────────────
  private currentWind: Wind = { x: 5, z: 3, speed: 6, fromBearingDeg: 330, cardinalDir: 'NNW', beaufort: 2 };
  private currentSea: SeaConditions = { waveHeight: 0.5, choppiness: 0.1 };
  private simTime   = 0;
  private gustPhase = 0;   // independent phase for gust oscillation

  // ── World-scale travel multiplier ─────────────────────────────────────────
  // The HUD displays physics speed (realistic knots), but world position advances
  // at TRAVEL_SCALE × that rate — a classic video-game map-compression trick.
  // Raise this to make island-to-island sailing feel snappier; lower it for realism.
  // MUST match the server (combat-constants.js TRAVEL_SCALE, which movement-constants imports) or the server's
  // movement validation snaps the local ship back (rubber-banding). Currently 3.
  private readonly TRAVEL_SCALE = 3.0;

  // ── Hull collision ──────────────────────────────────────────────────────────
  // The aground check used to test only the boat's CENTRE point, so the long bow
  // could plunge ~half a hull-length into an island before the centre reached land
  // (the "sailing inside the island" bug). We instead sample several points along
  // the hull's length so the bow/stern stops at the shoreline like a solid body.
  private readonly HULL_SAMPLES  = 4;     // points sampled fore-of-centre to the bow (HULL half-len from rig)

  /**
   * True if any point along the hull centreline (from centre toward the moving end)
   * lies on land — so the bow/stern is blocked the instant it touches shore, not
   * once the centre arrives. `dirSign` is +1 when moving ahead, -1 when reversing.
   */
  private hullHitsLand(cx: number, cz: number, hr: number, dirSign: number): boolean {
    const fx = Math.sin(hr) * dirSign;   // unit heading vector (forward / reverse)
    const fz = Math.cos(hr) * dirSign;
    for (let i = 1; i <= this.HULL_SAMPLES; i++) {
      const d = (this.rig.hullHalfLen * i) / this.HULL_SAMPLES;
      if (this.terrainService.isOnLand(cx + fx * d, cz + fz * d)) return true;
    }
    return false;
  }

  // ── Wake / hull-wash particle systems ────────────────────────────────────
  // Four ParticleSystems share one foam texture and use plain Vector3 emitters
  // that are repositioned every physics tick to follow the hull.  Particles are
  // emitted into world space, so they stay put while the boat moves away from
  // them — this naturally builds up a V-shaped foam trail behind the vessel.

  private readonly WAKE_Y = 0.30;          // at the waterline — slightly above wave trough

  // Particle-sprite wake disabled: the additive white foam sprites read as flat
  // billboards on the water and looked bad. The wake is now rendered entirely in
  // the ocean shader (displacement trench + foam trail driven by setBoatTransform).
  // Set true to bring the sprites back.
  private readonly WAKE_PARTICLES_ENABLED = false;

  private wakeTex!:   DynamicTexture;
  private bowSpray!:  ParticleSystem;      // bow-wave V pushing water sideways
  private sternFoam!: ParticleSystem;      // long-life foam forming the wake V-trail
  private portFroth!: ParticleSystem;      // hull wash along port side
  private stbdFroth!: ParticleSystem;      // hull wash along stbd side

  // Emitter positions — updated every tick, referenced (not copied) by the systems
  private bowEmit   = new Vector3(0, this.WAKE_Y, 0);
  private sternEmit = new Vector3(0, this.WAKE_Y, 0);
  private portEmit  = new Vector3(0, this.WAKE_Y, 0);
  private stbdEmit  = new Vector3(0, this.WAKE_Y, 0);

  // ─────────────────────────────────────────────────────────────────────────
  async init(vessel: Vessel, spawnX: number, spawnZ: number, spawnHeading = 270): Promise<void> {
    this.x       = spawnX;
    this.z       = spawnZ;
    this.heading = spawnHeading;
    if (vessel.physics) Object.assign(this.physics, vessel.physics);

    // Resolve the rig (GLB + manifest + orientation + handedness). The server vessel def is authoritative;
    // fall back to the slug→rig map.
    this.vesselSlug = vessel.slug;
    const base = rigForSlug(vessel.slug);
    this.rig = {
      glb:        vessel.glb        ?? base.glb,
      manifest:   vessel.manifest   ?? base.manifest,
      importFlipY: vessel.importFlipY ?? base.importFlipY,
      rightSign:  vessel.rightSign  ?? base.rightSign,
      controller: base.controller,
      floatDraft: base.floatDraft,
      hullCut:    base.hullCut,
      buoyancy:   base.buoyancy,
      hullHalfLen:  base.hullHalfLen,
      hullHalfBeam: base.hullHalfBeam,
      baseYawDeg:  base.baseYawDeg,
      sail:        base.sail,
      oceanMask:   base.oceanMask,
      oceanMaskFloorY: base.oceanMaskFloorY,
    };
    this.rightSign = this.rig.rightSign;

    // Per-vessel gun layout (muzzle offsets per side, vessel-local). Null → CannonService falls back to
    // its built-in sloop battery (3/side). The pinnace ships 1/side with its own handedness baked in.
    this.vesselCannons = vessel.cannons ?? null;

    // First-person ("on deck") eye position (vessel-local), from the server vessel def. Falls back to a
    // sensible helm position if a vessel doesn't define one, so the toggle always does something.
    const fp = vessel.firstPersonCam ?? { x: 0.6, y: 2.6, z: -2.8 };
    this.fpEye = new Vector3(fp.x, fp.y, fp.z);

    const { scene } = this.sceneService;
    // Group 2 renders after ocean (groups 0+1) but keeps the ocean's depth values
    // so the wave surface correctly occludes submerged hull geometry.
    scene.setRenderingAutoClearDepthStencil(2, false);
    await this.buildMesh(vessel, scene);
    this.setupInput();
    this.setupCameraInput();
    this.startLoop(scene);
  }

  // ─────────────────────────────────────────────────────────────────────────
  private async buildMesh(vessel: Vessel, scene: Scene): Promise<void> {
    this.root = new TransformNode('vessel_root', scene);
    this.root.position = new Vector3(this.x, 0, this.z);
    this.root.rotation.y = this.heading * Math.PI / 180;

    // Build structural parts
    for (const part of vessel.parts) {
      this.createPart(part, scene);
    }

    // Build wake trail (world-space, not parented to root)
    this.buildWake(scene);

    // Projected hull shadow on the water surface.
    this.buildWaterShadow(scene);

    // Load GLB geometry parts (hull, mast, flag, sails, cannons)
    await this.buildGLBMeshes(scene);

    // Register every hull / rig / sail mesh for ocean reflection + shadows + the WebGPU
    // varying-budget trims (see helper).
    this.registerMeshesForRendering(this.root.getChildMeshes());

    // Clip the sea out of the hull interior (open, low boats) so wave crests never show
    // inside the floor while the sea still laps the outer planking.
    this.applyHullCut();
  }

  /** Bake this vessel's hull silhouette into the ocean's interior cut (rig.hullCut vessels only;
   *  off otherwise). Local boat only — the ocean shader tracks a single boat transform. The per-frame
   *  floor height (waterY) is pushed from the physics loop so the cut rides the bob. */
  private applyHullCut(): void {
    // Tear down any stencil proxy from a previous hull (vessel swap/reload re-runs this); default both cut
    // modes off until re-enabled below.
    this.hullStencilCap?.dispose(false, true);
    this.hullStencilCap = null;
    this.oceanService.setHullStencilMask(false);
    if (!this.root) { this.oceanService.setHullCutEnabled(false); return; }

    // Per-rig opt-out: DECKED, deep-draft hulls (merchantman) skip the mask entirely — the stencil would
    // reveal their big underwater hull (keel visible through the sea) + cut foreground waves, and the deck
    // already hides the interior so there's nothing to mask. Live override: ignis_oceanmask_<slug>=on|off.
    const omo = (typeof localStorage !== 'undefined') ? localStorage.getItem('ignis_oceanmask_' + this.vesselSlug) : null;
    const oceanMask = omo === 'on' ? true : omo === 'off' ? false : (this.rig.oceanMask !== false);
    if (!oceanMask) { this.oceanService.setHullStencilMask(false); this.oceanService.setHullCutEnabled(false); return; }

    const hull = this.root.getChildMeshes()
      .find(m => /hull/i.test(m.name) && m.getTotalVertices() > 0);

    // STENCIL mask = the DEFAULT open-hull occlusion on WebGPU: mask the sea out of the hull with a stencil
    // proxy built from the boat's REAL geometry — perfect silhouette adherence, no carve, no tears. It's
    // INDEPENDENT of the per-rig hullCut config (only needs a hull mesh), so EVERY vessel — open pinnace or
    // decked sloop — gets the same clean mask from one cheap stencil-only draw. It only masks the FFT ocean,
    // so the WebGL/procedural ocean keeps the legacy shader carve below. `ignis_hullcut` is now an opt-OUT
    // override: 'carve' or 'discard' force the legacy shader path even on WebGPU; 'stencil' forces stencil.
    const override = (typeof localStorage !== 'undefined' && localStorage.getItem('ignis_hullcut')) || '';
    const useStencil = override === 'stencil' || (override === '' && this.sceneService.isWebGPU);
    if (useStencil && hull) {
      // TRUE-3D proxy: clone the live hull mesh (shared geometry + skeleton) and stamp it into the stencil
      // buffer. A boat's cross-section changes with height, so no flat sheet matches it at every angle — a
      // gunwale-height lid floats above the sea (parallax), a waterline lid pokes its wide outline past the
      // narrower waterline hull (a skirt). The hull's own geometry is the only silhouette that's exactly
      // right from any camera, so we mask to that.
      // Clamp the proxy at the hull-local DECK level (oceanMaskFloorY) so it masks only the open deck — well
      // above the wave zone, so it never masks the sea surface in front of the submerged hull (clamping at the
      // waterline still revealed the keel, because the proxy's flat bottom sat right where the line of sight to
      // the underwater hull crosses the sea). Undefined → mask the whole hull (shallow open boats).
      this.hullStencilCap = buildHullStencilProxy(
        hull, this.root, this.sceneService.scene, maskFloorFor(this.vesselSlug, this.rig));
      if (this.hullStencilCap) {
        this.oceanService.setHullStencilMask(true);
        this.oceanService.setHullCutEnabled(false);   // proxy does the masking — no shader carve/discard
        return;
      }
    }

    // ── Legacy shader carve/discard (any non-stencil mode), driven by the per-rig hullCut config. ──
    const hc = this.rig.hullCut;
    if (!hc || !hull) { this.oceanService.setHullCutEnabled(false); return; }
    // Footprint = the WIDEST-beam (gunwale/deck) outline, NOT the waterline contour. The dry region the cut
    // must cover is the whole open COCKPIT, which extends out to the gunwales; the narrower waterline slice
    // left the outer cockpit (and bow/stern flare) un-cut → waves flooded it. The gunwale outline also robustly
    // avoids any "where is the waterline in this hull's frame?" guess. `waterlineY` (a per-rig opt-in) still
    // forces a true waterline slice if ever wanted, but the pinnace omits it → widest-beam.
    const baked = bakeHullCutProfile(hull, this.root, OceanService.HULL_CUT_N, hc.waterlineY);
    if (!baked) { this.oceanService.setHullCutEnabled(false); return; }
    this.oceanService.setHullCutProfile(
      baked.profile, baked.alongMin, baked.alongLen, baked.acrossCenter, hc.alongSign);
    // Also bake the HEIGHT-AWARE silhouette (along × height) for the discard path (used only when the ocean
    // shader is built with HULL_DISCARD; the along meta is shared with the profile above via _HullCutMeta).
    const sil = bakeHullSilhouette(hull, this.root, OceanService.HULL_SIL_NA, OceanService.HULL_SIL_NH);
    if (sil) { this.oceanService.setHullSilhouette(sil.table, sil.hMin, sil.hMax); }

    this.oceanService.setHullCutEnabled(true);
  }

  /** Register a set of vessel meshes for ocean reflection/refraction, shadow casting, and
   *  the WebGPU varying-budget trims. The single rigged GLB's PBR materials carry more vertex
   *  varyings than the old split parts; combined with the SSAO prePass, shadow receipt, fog,
   *  and the ocean-reflection clip-plane they blow past WebGPU's hard 16 inter-stage limit,
   *  which invalidates EVERY pipeline that includes the vessel (black screen). So: cast
   *  shadows (depth-only, cheap) but don't receive them, drop fog.
   *
   *  The vessel is now KEPT IN the prePass (the excludeFromPrePass call was removed): with shadow
   *  receipt + fog already dropped there's room under the 16 limit, and being in the prePass gives
   *  SSAO/DoF the boat's true depth+normals — without it, SSAO sampled the ocean/shore BEHIND the
   *  boat and painted their AO onto the hull/sails (the "transparent boat" artifact). If this turns
   *  out to still overflow 16 (black screen with the vessel pipeline invalid), the next varying to
   *  shed is the ocean-reflection clip-plane (drop oceanService.addToRenderList → loses boat-in-water
   *  reflection/refraction), then re-exclude from the prePass as the last resort. */
  private registerMeshesForRendering(meshes: AbstractMesh[]): void {
    const sg = this.sceneService.shadowGenerator;
    const seenMats = new Set<Material>();
    // PERF: sails + flags are SKINNED cloth re-rendered into all 3 shadow cascades EVERY frame, and
    // (transparencyShadow=true) as the priciest alpha shadow draws — yet their shadow on the deck/water
    // is faint. Skip them from the shadow pass (they still render in the main view + water reflection).
    // This helps the square-rigged ships most (the brig has 13 sails + 4 flags = ~17 skinned draws ×3
    // cascades). Opt back in with localStorage.ignis_sailshadows='on'.
    const sailShadows = localStorage.getItem('ignis_sailshadows') === 'on';
    for (const mesh of meshes) {
      this.oceanService.addToRenderList(mesh);
      const isCloth = /sail|flag/i.test(mesh.name);
      if (!isCloth || sailShadows) sg?.addShadowCaster(mesh, true);
      // Do NOT set receiveShadows on the ship's PBR material: it's already at the WebGPU 16 inter-stage-variable
      // limit (esp. in the ocean-reflection pass), so adding the shadow-receive varyings overflows → the render
      // pipeline fails to compile → the scene strobes self-healing. Crew get cheap projected blob shadows instead.
      mesh.receiveShadows = false;
      const mat = mesh.material;
      if (mat && !seenMats.has(mat)) {
        seenMats.add(mat);
        mat.fogEnabled = false;
      }
    }
  }

  /** Live-reload the rigged model after /reloadassets bumped the cache version: dispose the
   *  current model + controller and re-instantiate from the (now cache-busted) GLB, keeping
   *  the vessel root, physics, input, camera, and cannon wiring intact. */
  async reloadModel(): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene || !this.root) return;
    const sg = this.sceneService.shadowGenerator;
    const oldRoot = this.controller?.root ?? null;
    if (oldRoot) {
      // Unregister from BOTH the ocean reflection list AND the shadow generator before disposing. Babylon
      // does NOT auto-prune a disposed mesh from a ShadowGenerator's manual render list, so skipping this
      // leaks dead refs every reload/refit — wasted shadow-pass work and, eventually, a descriptor-heap crash.
      for (const m of oldRoot.getChildMeshes(false)) { this.oceanService.removeFromRenderList(m); sg?.removeShadowCaster(m, true); }
    }
    this.controller?.dispose();
    this.controller = null;
    oldRoot?.dispose();   // disposes the old instanced meshes (shared materials are kept)

    await this.buildGLBMeshes(scene);   // re-instantiate fresh + build a new controller
    if (this.controller) {
      this.registerMeshesForRendering(this.controller.root.getChildMeshes(false));
      this.applyHullCut();
    }
  }

  /** Refit into a DIFFERENT vessel in place (shipwright purchase): adopt the new def's rig/physics/guns and
   *  rebuild the model at the CURRENT pose, keeping input, camera, the sim loop, and the wake particles.
   *  The cannon battery resyncs from the new layout on the next broadside (CannonService.syncGuns). */
  async swapVessel(vessel: Vessel): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene || !this.root) return;

    // Adopt the new vessel def — mirrors init()'s setup, minus pose/input/loop.
    if (vessel.physics) Object.assign(this.physics, vessel.physics);
    this.vesselSlug = vessel.slug;
    const base = rigForSlug(vessel.slug);
    this.rig = {
      glb:         vessel.glb         ?? base.glb,
      manifest:    vessel.manifest    ?? base.manifest,
      importFlipY: vessel.importFlipY ?? base.importFlipY,
      rightSign:   vessel.rightSign   ?? base.rightSign,
      controller:  base.controller,
      floatDraft:  base.floatDraft,
      hullCut:     base.hullCut,
      buoyancy:    base.buoyancy,
      hullHalfLen:  base.hullHalfLen,
      hullHalfBeam: base.hullHalfBeam,
      baseYawDeg:  base.baseYawDeg,
      sail:        base.sail,
      oceanMask:   base.oceanMask,
      oceanMaskFloorY: base.oceanMaskFloorY,
    };
    this.rightSign = this.rig.rightSign;
    this.vesselCannons = vessel.cannons ?? null;
    const fp = vessel.firstPersonCam ?? { x: 0.6, y: 2.6, z: -2.8 };
    this.fpEye = new Vector3(fp.x, fp.y, fp.z);

    // Dispose the old model + controller and rebuild from the new rig (same as reloadModel). Unregister from
    // BOTH the ocean list AND the shadow generator (Babylon won't auto-prune disposed meshes from the
    // shadow render list — leaking them every refit wastes shadow-pass work and risks a descriptor-heap crash).
    const sg = this.sceneService.shadowGenerator;
    const oldRoot = this.controller?.root ?? null;
    if (oldRoot) { for (const m of oldRoot.getChildMeshes(false)) { this.oceanService.removeFromRenderList(m); sg?.removeShadowCaster(m, true); } }
    this.controller?.dispose();
    this.controller = null;
    oldRoot?.dispose();
    await this.buildGLBMeshes(scene);
    if (this.controller) {
      this.registerMeshesForRendering(this.controller.root.getChildMeshes(false));
      this.applyHullCut();
    }
  }

  // ── GLB geometry loading ──────────────────────────────────────────────────
  // Loads the single rigged sloop GLB (skeleton clips + morph targets, Draco +
  // WEBP) from the /geometry/ static route, plus its companion manifest, and wraps
  // the instantiated model in a SloopController that drives rudder/trim/furl/flag.
  //
  // Orientation: after the loader's handedness conversion the model's bow points -Z,
  // so we apply the 180° Y flip (flipY=true) to face +Z = forward = direction of travel.
  // Parenting + renderingGroupId 2 still happen inside instantiateRigged().
  private async buildGLBMeshes(scene: Scene): Promise<void> {
    const [rigged, manifest] = await Promise.all([
      this.assetCache.instantiateRigged(this.rig.glb, scene, this.root, this.rig.importFlipY, baseYawDegFor(this.vesselSlug, this.rig)),
      this.assetCache.loadManifest(this.rig.manifest),
    ]);
    if (!rigged) { console.warn(`[Vessel] rigged ${this.vesselSlug} failed to load`); return; }

    this.controller = createVesselController(this.vesselSlug, rigged.entries, rigged.root, manifest, scene);
    this.deckCamMeshes = null;   // invalidate the deck-walk raycast cache for the new hull
    // Metal parts (cannon iron/brass) reflect the sky LUT so they read as dark metal, not a black void — the
    // scene runs no environmentTexture, so factor-only metals (brig SHIP_IRON) are otherwise unlit/black.
    applyShipMetalEnv(this.controller.getMeshes(), this.sceneService.getSkyEnvTexture());
    this.controller.applySailState(this.sailState, true);   // initial pose snaps (no furl anim)

    // Flag colour — override the baked flag texture with this captain's chosen RGB (per-vessel material).
    this.flagHandle?.dispose();
    this.flagHandle = applyFlagColor(scene, this.root, flagColor3(this.flagColor),
      { excludeFromPrePass: (m) => this.sceneService.excludeFromPrePass(m) });

    // Animated deck crew — seeded look, station/waypoint behaviour from the
    // companion crew_stations JSON. Fire-and-forget: the vessel is sailable
    // before the (larger) pirate GLB finishes loading. A stale handle from a
    // previous rebuild self-disposes when its ship root is disposed; we still
    // drop ours explicitly so cloned materials are freed promptly.
    this.crewHandle?.dispose();
    this.crewHandle = null;
    void this.crewService
      .attach(this.vesselSlug, rigged.root, scene, crewSeedFrom('local_' + this.vesselSlug))
      .then((h) => { this.crewHandle = h; h?.setAliveCount(this.combatService.crew()); });   // reflect current casualties
  }

  /** Animated deck crew handle (casualties via killOne()/reviveAll()); null until loaded. */
  get crew(): CrewHandle | null { return this.crewHandle; }

  /** Set the local ship's flag colour (#rrggbb) — recolours the flags in place (and is reapplied on the next
   *  build). Called by MultiplayerService when the server confirms it (on connect via wallet, and on change). */
  setFlagColor(hex: string): void {
    this.flagColor = hex || '#b22222';
    this.flagHandle?.setColor(flagColor3(this.flagColor));
  }

  private buildWaterShadow(scene: Scene): void {
    const tex = new DynamicTexture('hullShadowTex', { width: 128, height: 128 }, scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0.0, 'rgba(0,0,0,0.92)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.55)');
    grd.addColorStop(1.0, 'rgba(0,0,0,0.0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
    tex.update();

    this.waterShadowMat = new StandardMaterial('hullShadowMat', scene);
    this.waterShadowMat.diffuseTexture = tex;
    this.waterShadowMat.opacityTexture = tex;
    this.waterShadowMat.emissiveColor = new Color3(0, 0, 0);
    this.waterShadowMat.disableLighting = true;
    this.waterShadowMat.backFaceCulling = false;
    this.waterShadowMat.alpha = 0.90;

    this.waterShadow = MeshBuilder.CreateDisc('hullShadow', { radius: 16, tessellation: 32 }, scene);
    this.waterShadow.material = this.waterShadowMat;
    this.waterShadow.renderingGroupId = 3;
    this.waterShadow.isPickable = false;
    this.waterShadow.rotation.x = Math.PI / 2;
    this.waterShadow.alwaysSelectAsActiveMesh = true;
  }

  private createPart(part: VesselPart, scene: Scene): Mesh {
    let mesh: Mesh;

    if (part.shape === 'box') {
      mesh = MeshBuilder.CreateBox(part.id, {
        width: part.params.width, height: part.params.height, depth: part.params.depth,
      }, scene);
    } else if (part.shape === 'cylinder') {
      mesh = MeshBuilder.CreateCylinder(part.id, {
        diameter: part.params.diameter, height: part.params.height,
        tessellation: part.params.tessellation ?? 8,
      }, scene);
    } else if (part.shape === 'sphere') {
      mesh = MeshBuilder.CreateSphere(part.id, {
        diameter: part.params.diameter,
        segments: part.params.tessellation ?? 8,
      }, scene);
    } else if (part.shape === 'torus') {
      mesh = MeshBuilder.CreateTorus(part.id, {
        diameter:     part.params.diameter,
        thickness:    part.params.thickness ?? 0.1,
        tessellation: part.params.tessellation ?? 16,
      }, scene);
    } else {
      mesh = MeshBuilder.CreatePlane(part.id, {
        width: part.params.width, height: part.params.height,
        sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
    }

    mesh.parent           = this.root;
    mesh.renderingGroupId = 2;   // render after ocean (groups 0+1) so hull is always visible
    mesh.position = new Vector3(part.position.x, part.position.y, part.position.z);
    if (part.rotation) {
      mesh.rotation = new Vector3(part.rotation.x, part.rotation.y, part.rotation.z);
    }

    mesh.material = this.buildVesselMat(part, scene);

    return mesh;
  }

  // ── Sail state ────────────────────────────────────────────────────────────

  setSailState(state: SailState): void {
    this.sailState = state;
    this.controller?.applySailState(state);
  }

  // ── Refloat ───────────────────────────────────────────────────────────────
  // Teleports the vessel to an arbitrary world position.
  // Keeps the current heading, furls sails, and resets speed/grounded state.
  teleportTo(worldX: number, worldZ: number): void {
    this.x     = worldX;
    this.z     = worldZ;
    this.speed = 0;
    this.isAnchored = false;
    this.anchored.set(false);
    this.setSailState('reefed');

    if (this.root) {
      this.root.position.x = this.x;
      this.root.position.z = this.z;
    }

    this.isGrounded   = false;
    this.groundedTime = 0;
    this.grounded.set(false);
    this.resetWake();
  }

  /** Respawn the vessel at a given pose (used after sinking → a harbor). Teleports, faces the given
   *  heading, furls sails, stops/clears sinking + grounded. The server-side respawn clears our
   *  authoritative pose so this jump isn't clamped by movement validation. */
  respawnAt(worldX: number, worldZ: number, heading: number): void {
    this.teleportTo(worldX, worldZ);
    this.heading = ((heading % 360) + 360) % 360;
    if (this.root) this.root.rotation.y = this.heading * Math.PI / 180;
    this.stopSinking();
  }

  // Teleports the vessel to the nearest terrain spawn point, furls sails,
  // resets speed, and clears the grounded flag.

  refloat(): void {
    const { spawnX, spawnZ, heading } = this.terrainService.nearestSpawn(this.x, this.z);
    this.x       = spawnX;
    this.z       = spawnZ;
    this.speed   = 0;
    this.heading = heading;
    this.isAnchored = false;
    this.anchored.set(false);
    this.setSailState('reefed');

    // Snap mesh immediately so the camera doesn't pan across the world
    if (this.root) {
      this.root.position.x = this.x;
      this.root.position.z = this.z;
      this.root.rotation.y = this.heading * Math.PI / 180;
    }

    this.isGrounded   = false;
    this.groundedTime = 0;
    this.grounded.set(false);
    this.resetWake();
    this.stopSinking();
  }

  /** Begin the capsize/sink animation (the ship settles deep + rolls toward the damaged side). Control is
   *  frozen while sinking. Called when the local ship is sunk (before the delayed "you were sunk" card). */
  startSinking(): void {
    if (this.sinking) { return; }
    this.sinking    = true;
    this.sinkStartT = this.simTime;
    this.speed      = 0;
  }

  /** End the sink (on repair / refloat): the hull eases back up to normal buoyancy. */
  stopSinking(): void {
    this.sinking = false;
    this.buoyancyService.reset();
  }

  // Ship-to-ship collision is resolved SERVER-side now (movement.resolvePair) and arrives as a
  // `correction` handled by applyServerCorrection(); the old local applyCollision() resolver was retired.


  // Visual reconciliation of server corrections. The SIM (this.x/z) snaps to the authoritative pose
  // immediately (so physics + the broadcast stay correct), but we carry the snap as a decaying RENDER
  // offset so the mesh glides to the new spot instead of popping — smooth for collision bumps. Big
  // corrections (teleport rejection) are snapped outright (no glide). Purely local; never networked.
  private corrErrX = 0;
  private corrErrZ = 0;
  private readonly CORR_DECAY     = 9;    // 1/s — render-error decay rate (~0.3 s glide)
  private readonly CORR_SNAP_DIST = 25;   // m — above this, snap (don't glide a teleport)

  /** Reconcile the local boat to a server-authoritative pose (a `correction` message). Sent only when
   *  the server CLAMPED our claim (teleport/speed-hack/land) or resolved a collision — rare in honest
   *  play. The sim snaps; the visual eases (see corrErr decay in physicsStep). */
  applyServerCorrection(x: number, z: number, heading: number, speed: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const prevVisX = this.x + this.corrErrX, prevVisZ = this.z + this.corrErrZ;
    this.x = x;
    this.z = z;
    if (Number.isFinite(heading)) this.heading = ((heading % 360) + 360) % 360;
    if (Number.isFinite(speed)) this.speed = speed;
    // Carry the visual continuity: offset = where the mesh was − where the sim now is. Snap big jumps.
    const ex = prevVisX - this.x, ez = prevVisZ - this.z;
    if (Math.hypot(ex, ez) > this.CORR_SNAP_DIST) { this.corrErrX = 0; this.corrErrZ = 0; }
    else { this.corrErrX = ex; this.corrErrZ = ez; }
    if (this.root) {
      this.root.position.x = this.x + this.corrErrX;
      this.root.position.z = this.z + this.corrErrZ;
      this.root.rotation.y = this.heading * Math.PI / 180;
    }
  }

  // ── Sail efficiency curve ─────────────────────────────────────────────────
  // Redesigned to make close-hauled sailing viable (~52 % eff at minTackAngle).
  // minTackAngle = 32° (set in vessel physics), so the "in irons" zone is tighter.

  /**
   * Return the ideal sheet angle (° from centreline) for a given wind angle.
   * Close-hauled = sail in tight; running = sail fully eased.
   */
  private optimalSheetAngle(absAngleFromWind: number): number {
    if (absAngleFromWind < 38)  return 5;
    if (absAngleFromWind < 60)  return 18;
    if (absAngleFromWind < 90)  return 35;
    if (absAngleFromWind < 115) return 52;
    if (absAngleFromWind < 145) return 68;
    if (absAngleFromWind < 165) return 82;
    return 88;
  }

  /**
   * 0–1 trim quality based on how close the player-set sheet angle is to optimal.
   * Over-sheeted (sail too tight) drops off fast; under-sheeted drops more gently.
   */
  private trimFactor(absAngleFromWind: number): number {
    const optimal  = this.optimalSheetAngle(absAngleFromWind);
    const mismatch = this.sheetAngleDeg - optimal;
    if (mismatch < 0) {
      // Over-sheeted: sail stalls quickly — 30° over = fully stalled
      return Math.max(0, 1 + mismatch / 30);
    } else {
      // Under-sheeted: sail luffs more gently — 50° under = fully luffing
      return Math.max(0, 1 - mismatch / 50);
    }
  }

  /**
   * v2 trim quality (0..1) — sensitivity depends on POINT OF SAIL. Upwind/reaching the sail is an
   * AIRFOIL: tight tolerance, and bad trim STALLS (over-sheet) or LUFFS (over-ease) toward 0. Dead
   * downwind the sail is a DRAG device (a parachute): wide tolerance, a high floor, and it CANNOT stall —
   * a slightly-off sheet with the wind behind you costs almost nothing. Fixes the legacy bug where a 30°
   * over-sheet drove efficiency to 0 even on a run (the "I'm running downwind but nearly stopped" case).
   */
  private trimFactorV2(absAngle: number): number {
    const optimal  = this.optimalSheetAngle(absAngle);
    const mismatch = this.sheetAngleDeg - optimal;          // <0 = sheeted too tight, >0 = eased too far
    const dw       = this.smooth01(absAngle, 100, 160);     // 0 = airfoil (up/reach) → 1 = drag device (run)
    const forgive  = this.rig.sail?.trimForgive ?? 1;       // simple workboat rig → wider tolerance
    const floor    = 0.70 * dw;                             // min drive even badly mis-set: 0 upwind → .70 run
    const tightW   = (20 + 56 * dw) * forgive;              // too-tight (stall) tolerance °: 20 → 76
    const easeW    = (32 + 58 * dw) * forgive;              // too-eased (luff)  tolerance °: 32 → 90
    const width    = (mismatch < 0 ? tightW : easeW) || 1;
    const x        = Math.min(1, Math.abs(mismatch) / width);
    return floor + (1 - floor) * (1 - x * x);              // parabolic falloff, = floor at the tolerance edge
  }

  /** Smoothstep 0..1 as v sweeps a→b. */
  private smooth01(v: number, a: number, b: number): number {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  private sailEfficiency(angleFromWind: number): number {
    if (this.sailState === 'reefed') { this.trimQ = 1; return 0; }
    const sailMult = this.sailState === 'topsails' ? 0.5 : 1.0;
    const a = Math.abs(angleFromWind);
    let eff: number;

    if (this.physV2 && this.rig.sail) {
      // v2: per-rig polar (distinct character per boat) — see VESSEL_RIGS / sailing-physics-roadmap.
      eff = this.polarDrive(a, this.rig.sail);
    } else {
      // Legacy step curve (shared by both boats).
      if      (a < this.physics.minTackAngle) eff = -0.30;  // in irons: gentle pushback
      else if (a < 45)  eff = 0.52;  // close-hauled
      else if (a < 60)  eff = 0.72;  // close reach
      else if (a < 90)  eff = 0.86;  // beam reach
      else if (a < 115) eff = 0.95;  // broad reach approach
      else if (a < 145) eff = 1.00;  // broad reach — peak VMG
      else if (a < 165) eff = 0.88;  // running
      else              eff = 0.72;  // dead downwind (blanketed jib)
    }

    // Trim penalty: even a perfect point of sail underperforms with a mis-set sheet. v2 makes the penalty
    // POINT-OF-SAIL-AWARE (forgiving downwind, sharp upwind); legacy uses the old one-size curve.
    const trim = (a < this.physics.minTackAngle) ? 1 : (this.physV2 ? this.trimFactorV2(a) : this.trimFactor(a));
    this.trimQ = trim;   // cached for the HUD trim-quality readout (reflects the actual drive trim)
    return eff * sailMult * trim;
  }

  /**
   * v2 per-rig drive coefficient at apparent wind angle `a` (0 = bow into wind). Below the no-go angle the
   * sail luffs then backwinds (ramps to −0.30 dead into the wind); above it, linearly interpolate the rig's
   * polar breakpoints. This is what makes a sloop and a pinnace sail differently.
   */
  private polarDrive(a: number, sail: SailRig): number {
    const noGo = this.physics.minTackAngle;
    if (a < noGo) return -0.30 * (1 - a / Math.max(1, noGo));   // luff → backwind in the no-go zone
    const p = sail.polar;
    if (a <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (a <= p[i][0]) {
        const t = (a - p[i - 1][0]) / (p[i][0] - p[i - 1][0]);
        return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t;
      }
    }
    return p[p.length - 1][1];
  }

  // ── Turn rate (speed-dependent) ───────────────────────────────────────────
  // Lorentzian shape: peaks at ~25 % of max speed, drops sharply at high speed.
  // At full speed the boat turns ~11 °/s (≈ 360° in 33 s) — hard to spin.
  // At low/zero speed it's ~4 °/s — barely steerable until you have momentum.

  private turnRate(speed: number): number {
    const sf   = Math.abs(speed) / this.physics.maxSpeed;
    if (sf < 0.03) return 4;            // essentially stopped — minimal helm response
    // f(sf) = K · sf / (1 + (sf/p)²) — peaks at sf=p, then falls as 1/sf
    const p    = 0.28;                  // peak agility at 28 % of hull speed
    const rate = 155 * sf / (1 + (sf / p) * (sf / p));
    return Math.max(4, Math.min(30, rate));
  }

  // ── Sheet adjustment rate ─────────────────────────────────────────────────
  private readonly SHEET_RATE = 28;   // degrees per second while Q/E is held

  // ── Update weather from outside ───────────────────────────────────────────

  updateWeather(wind: Wind, sea: SeaConditions): void {
    this.currentWind = wind;
    this.currentSea  = sea;
  }

  /** Current wind (read-only) — used e.g. to drift cannon smoke downwind. */
  getWind(): Wind { return this.currentWind; }

  // ── Physics loop ──────────────────────────────────────────────────────────

  private startLoop(scene: Scene): void {
    let lastTime = performance.now();
    scene.registerBeforeRender(() => this.sceneService.span('vessel', () => {
      const now = performance.now();
      const dt  = Math.min((now - lastTime) / 1000, 0.05);
      lastTime  = now;
      this.simTime += dt;
      this.physicsStep(dt);
      this.updateCamera(dt);
    }));
  }

  private physicsStep(dt: number): void {
    const wind = this.currentWind;

    // ── Sheet adjustment (Q = ease out, E = haul in) ──────────────────────
    if (this.keys.sheetOut) this.sheetAngleDeg = Math.min(88, this.sheetAngleDeg + this.SHEET_RATE * dt);
    if (this.keys.sheetIn)  this.sheetAngleDeg = Math.max( 5, this.sheetAngleDeg - this.SHEET_RATE * dt);

    // ── Gust simulation ─────────────────────────────────────────────────────
    // Two incommensurate sine waves create irregular, non-repeating gusts.
    // ±15 % amplitude feels authentic without being sim-racing extreme.
    this.gustPhase += dt;
    const gustMult   = 1.0
      + 0.10 * Math.sin(this.gustPhase * 2.73)
      + 0.05 * Math.sin(this.gustPhase * 1.31 + 1.7);
    const gustSpeed  = wind.speed * gustMult;

    // Angle from wind: 0 = into wind, 180 = before wind
    let diff = this.heading - wind.fromBearingDeg;
    diff = ((diff + 360) % 360);
    const angleFromWind = diff > 180 ? 360 - diff : diff;
    const isPortTack    = diff <= 180;

    // Mast damage: a wounded mast (< 60 % HP) bleeds sail power; a fully destroyed mast gives NO drive at
    // all (she coasts to a stop as if furled — see the helm cap below). Read from our authoritative hull.
    const mastH   = mastHealth(this.combatService.zones(), zoneHpFor(this.vesselSlug));
    const mastMul = mastSpeedMult(mastH);

    // ── Apparent wind (v2): the wind the boat actually feels = true-wind vector − boat-velocity vector.
    // Reaching/upwind raises it (more drive); running lowers it (you can't outrun the wind dead downwind).
    // The legacy model read TRUE wind only; v2 drives off the apparent angle/speed. ──
    let driveAngle = angleFromWind;
    let appWind    = gustSpeed;
    if (this.physV2) {
      const hr0 = this.heading * Math.PI / 180;
      const bvx = Math.sin(hr0) * this.speed, bvz = Math.cos(hr0) * this.speed;   // boat velocity
      const wf  = wind.fromBearingDeg * Math.PI / 180;
      const wvx = -Math.sin(wf) * gustSpeed, wvz = -Math.cos(wf) * gustSpeed;     // true wind velocity (blows TO = from+180°)
      const ax  = wvx - bvx, az = wvz - bvz;                                       // apparent wind velocity
      appWind   = Math.hypot(ax, az);
      const cosA = (-ax * Math.sin(hr0) - az * Math.cos(hr0)) / (appWind || 1);    // cos(angle bow ↔ apparent FROM)
      driveAngle = Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI;     // 0 = bow into apparent wind
    }

    const eff    = this.sailEfficiency(driveAngle);
    // Crew: fewer hands work the sails (and helm) less effectively — scale top speed + turn rate by the
    // crew-efficiency factor (0.5..1). Even solo you still sail/turn, just at half pace (the 0.5 floor).
    const crewMul = this.combatService.crewFactor();
    const baseTarget = Math.max(-1.5, Math.min(this.physics.maxSpeed, gustSpeed * eff * this.physics.sailAreaFactor * mastMul)) * crewMul;
    // speedModifier applied below after buoyancy is computed (legacy path; v2 folds it into the force model).
    // While sinking OR docked (approaching/tied), control is frozen: glide to a dead stop (no sail drive).
    const docked = this.dockPhase !== 'free';
    if (this.sinking || docked) {
      this.speed += (0 - this.speed) * (this.sinking ? 1.2 : this.physics.accelerationRate) * dt;
    } else if (this.physV2) {
      // ── Force model: a = (thrust − drag)·response/mass. Thrust ∝ driveC·V_app²; drag ∝ v². The steady
      // state (drive = drag) sets the top speed; mass sets the momentum (heavy boats accelerate/coast slow). ──
      // Heel from wind SIDE-FORCE (canvas × V_app² × how abeam the wind is). Over comfort the sail spills
      // wind → forward drive falls off (reefing pays in a blow); spilling also sheds some of the heel.
      const canvas   = this.sailState === 'full' ? 1 : this.sailState === 'topsails' ? 0.5 : 0;
      const heelRaw  = this.HEEL_K * this.physics.sailAreaFactor * canvas
                     * appWind * appWind * Math.sin(driveAngle * Math.PI / 180);
      this.heelSpill = Math.max(0, Math.min(1, (heelRaw - this.COMFORT_HEEL) / this.SPILL_RANGE));
      this.heelV2    = Math.min(this.MAX_HEEL_VIS, heelRaw * (1 - 0.45 * this.heelSpill));
      const driveC = eff * mastMul * crewMul * (1 - this.SPILL_MAX * this.heelSpill);
      const forceK = this.rig.sail?.forceK ?? this.SAIL_FORCE_K;
      const thrust = forceK * this.physics.sailAreaFactor * driveC * appWind * appWind;
      // Drag = hull drag (quadratic) + turn scrub (a hard turn drags the hull broadside, bleeding way — most
      // felt mid-tack; uses last frame's yawRate, 1-frame lag is moot) + sea drag (chop resistance, worse
      // punching into a head sea than running with it).
      const rough    = Math.min(1, this.currentSea.choppiness * 0.7 + this.currentSea.waveHeight / 4);
      const intoSea  = 1 - driveAngle / 180;                                   // 1 dead upwind → 0 downwind
      const drag = this.DRAG_K * this.speed * Math.abs(this.speed)
                 + this.TURN_SCRUB * Math.abs(this.yawRate) * Math.abs(this.speed)
                 + this.SEA_DRAG_K * rough * (0.5 + intoSea) * Math.abs(this.speed);
      const massK  = Math.max(0.2, this.physics.weight / this.WEIGHT_REF);
      this.speed  += (thrust - drag) * this.FORCE_RESPONSE / massK * dt;
      this.speed  += this.prevSpeedMod * this.physics.maxSpeed * 0.3 * dt;   // following/head-sea surf nudge
      this.speed   = Math.max(-1.5, Math.min(this.physics.maxSpeed, this.speed));
    } else {
      this.speed += (baseTarget - this.speed) * this.physics.accelerationRate * dt;
    }
    if (Math.abs(this.speed) < 0.001) this.speed = 0;  // snap to zero only on true standstill

    if (this.physV2 && this.physDebugOn) {
      const driveC = eff * mastMul * crewMul * (1 - this.SPILL_MAX * this.heelSpill);
      this.physDebug.set({
        appAngle: driveAngle, appWind, trueAngle: angleFromWind,
        thrust: (this.rig.sail?.forceK ?? this.SAIL_FORCE_K) * this.physics.sailAreaFactor * driveC * appWind * appWind,
        drag: this.DRAG_K * this.speed * Math.abs(this.speed),
        speed: this.speed, vmg: this.speed * Math.cos(driveAngle * Math.PI / 180), trim: this.trimQ,
        heel: this.heelV2, reef: this.heelSpill > 0.3,
      });
    }

    // Steering. With the mast totally down she still answers the helm, but only just — capped to a slow
    // pivot (she's lost her sail-driven way; this is the "can turn very slowly but that is it" rule).
    let maxYaw = this.turnRate(this.speed);                  // speed-dependent rudder authority (water flow)
    if (mastH <= 0) maxYaw = Math.min(maxYaw, MAST_DOWN_TURN_MAX);
    maxYaw *= crewMul;                                       // short-handed → slower on the helm too
    const rudder = (!this.sinking && !docked) ? (this.keys.left ? -1 : this.keys.right ? 1 : 0) : 0;
    if (this.physV2) {
      // Angular inertia: the helm sets a TARGET yaw rate the boat eases toward (and coasts back from when
      // centred) — no instant pivots. Turn scrub (above) bleeds speed through the turn.
      const targetYaw = rudder * maxYaw;
      this.yawRate += (targetYaw - this.yawRate) * Math.min(1, this.YAW_RESPONSE * dt);
      this.heading = ((this.heading + this.yawRate * dt) + 360) % 360;
      // In irons & losing way → the wind blows the bow off the eye so you can never be permanently stuck.
      // Scales with how stalled she is (→ 0 once she has way on or has fallen off past the no-go zone).
      if (rudder === 0 && !this.sinking && !docked
          && driveAngle < this.physics.minTackAngle && Math.abs(this.speed) < 1.5) {
        const signed = diff > 180 ? diff - 360 : diff;       // heading vs wind FROM, −180..180 (0 = eye)
        const fall = (signed >= 0 ? 1 : -1) * this.IRONS_FALLOFF * (1 - Math.abs(this.speed) / 1.5);
        this.heading = ((this.heading + fall * dt) + 360) % 360;
      }
    } else if (rudder !== 0) {
      this.heading = ((this.heading + rudder * maxYaw * dt) + 360) % 360;   // legacy: instant rate while held
    }

    // ── Auto-dock: ease to the berth, then stay moored (frozen) until cast off ──
    if (docked) {
      if (this.dockPhase === 'approaching') {
        this.dockElapsed += dt;
        const u = this.dockDuration > 0 ? Math.min(1, this.dockElapsed / this.dockDuration) : 1;
        const e = u * u * (3 - 2 * u);   // smoothstep ease in/out
        this.x = this.dockStartX + (this.dockBerthX - this.dockStartX) * e;
        this.z = this.dockStartZ + (this.dockBerthZ - this.dockStartZ) * e;
        this.heading = ((this.dockStartHdg + this.angleDeltaDeg(this.dockStartHdg, this.dockBerthHdg) * e) % 360 + 360) % 360;
        if (u >= 1) { this.dockPhase = 'tied'; this.docking.set(false); this.tiedUp.set(true); }
      } else {   // 'tied' — pinned at the berth, like an anchor with zero scope
        this.x = this.dockBerthX; this.z = this.dockBerthZ; this.heading = this.dockBerthHdg;
      }
      this.speed = 0;
    }

    // ── Position update ──────────────────────────────────────────────────────
    // TRAVEL_SCALE compresses map distances while keeping knot values realistic.
    const hr = this.heading * Math.PI / 180;

    // Leeway: sailing boats slip sideways (leeward) under sail pressure.
    // Proportional to heel angle — more heel = more sideways drift.
    // On port tack the wind pushes to starboard (+cos/−sin in world space).
    // v2: heel comes from wind side-force (computed in the force model above) → more leeway when pressed,
    // and the workboat pinnace makes more leeway than the keel-stiff sloop (per-rig leewayK).
    const heelMag     = this.physV2 ? this.heelV2 : Math.abs(eff) * Math.abs(this.speed / this.physics.maxSpeed) * 12;
    const leewayK     = this.physV2 ? (this.rig.sail?.leewayK ?? 1) : 1;
    const leewayDeg   = heelMag * 0.28 * leewayK;   // legacy ~3.4° max; v2 scales with wind-pressure heel
    const leewayRad   = leewayDeg * Math.PI / 180;
    const leewaySign  = isPortTack ? 1 : -1;   // push to starboard on port tack
    const lwyX = Math.cos(hr) * leewaySign * Math.abs(this.speed) * leewayRad * dt * this.TRAVEL_SCALE;
    const lwyZ = -Math.sin(hr) * leewaySign * Math.abs(this.speed) * leewayRad * dt * this.TRAVEL_SCALE;

    let newX = this.x + Math.sin(hr) * this.speed * dt * this.TRAVEL_SCALE + lwyX;
    let newZ = this.z + Math.cos(hr) * this.speed * dt * this.TRAVEL_SCALE + lwyZ;

    // Anchor tether: clamp travel to a small radius around the drop point so the boat
    // can sail/drift only a metre or two before the rode snubs taut, then halts. The boat
    // is free to swing on the rode (heading unchanged here), it just can't drift away.
    if (this.isAnchored) {
      const dx = newX - this.anchorX, dz = newZ - this.anchorZ;
      const d  = Math.hypot(dx, dz);
      if (d > this.ANCHOR_RADIUS) {
        newX = this.anchorX + (dx / d) * this.ANCHOR_RADIUS;
        newZ = this.anchorZ + (dz / d) * this.ANCHOR_RADIUS;
        this.speed = 0;
      }
    }

    // Block when the HULL (bow when moving ahead, stern when reversing) — not just
    // the centre — would touch land, so the ship halts at the shoreline instead of
    // burying its bow inside the island. dirSign follows the direction of travel.
    // (While docked the auto-dock glide above already set the pose — skip the sailing
    // collision/grounded test so a berth tucked near the pier never reads as "aground".)
    const dirSign = this.speed >= 0 ? 1 : -1;
    if (docked) {
      this.groundedTime = 0;
      if (this.isGrounded) { this.isGrounded = false; this.grounded.set(false); }
    } else if (this.hullHitsLand(newX, newZ, hr, dirSign) ||
        this.terrainService.isOnLand(newX, newZ)) {
      // ── Movement is blocked — ship cannot enter land ─────────────────────
      this.speed = 0;
      // NOTE: aground DETECTION is intentionally disabled — we never raise the `grounded` overlay/message.
      // The hull still can't enter land (speed 0 above); a player who pins themselves uses the /stuck chat
      // command (→ refloat()) to back off. groundedTime/isGrounded are left wired but never set here.
    } else {
      this.x = newX;
      this.z = newZ;
      // Any free movement resets the contact timer and clears the aground flag.
      this.groundedTime = 0;
      if (this.isGrounded) {
        this.isGrounded = false;
        this.grounded.set(false);
      }
    }

    // Wake trail
    this.updateWake();

    // Heel angle (leeward lean from wind pressure on sails)
    // heelMag was already computed above for leeway — reuse it.
    const heelAngle = (isPortTack ? 1 : -1) * heelMag;

    // Update root transform
    this.root.position.x = this.x;
    this.root.position.z = this.z;
    this.root.rotation.y = this.heading * Math.PI / 180;

    this.updateWaterShadow();

    // ── Buoyancy: per-vessel hull sampling + wave slope physics ───────────────
    // VesselBuoyancyService samples OceanService.getVisualHeightAt() — a CPU port of the GPU vertex shader's
    // waveHeight() — so the physics height matches the rendered surface exactly. The hull footprint scales to
    // each vessel's real dimensions (hullHalfLen/hullHalfBeam).
    const t    = this.simTime;
    const buoy = this.buoyancyService.update(this.x, this.z, hr, t, dt, this.rig.buoyancy,
      this.rig.hullHalfLen, this.rig.hullHalfBeam);
    // Anti-sink floor: gentle 15% correction of any corner that lags below its wave.
    const floorLift    = Math.max(0, buoy.heaveFloor - buoy.heave);
    const heaveApplied = buoy.heave + floorLift * 0.15;

    // Wave surfing: wave slope makes the boat go faster downhill, slower uphill.
    // Blended gently so it's a subtle 0–30% nudge, not a jarring step-change.
    // v2 folds this into the force model (via prevSpeedMod, applied next frame as a surf accel) rather than
    // retargeting toward baseTarget, so the two speed integrators never fight.
    if (!this.physV2) {
      const modTarget = Math.max(-1.5, Math.min(this.physics.maxSpeed,
        baseTarget * (1 + buoy.speedModifier),
      ));
      this.speed += (modTarget - this.speed) * this.physics.accelerationRate * dt * 0.3;
    }
    this.prevSpeedMod = buoy.speedModifier;

    // Cross-wave broaching bias + slow sea-state wander: only active when the
    // player is not steering. buoy.steeringBias is the fast wave-to-wave jostle
    // (zero-mean, oscillates). On top we add a slow, low-frequency wander so the
    // confused sea gradually nudges the boat off course over ~tens of seconds,
    // requiring the occasional correction. Both scale with sea roughness, so calm
    // water barely moves the bow while rough seas need more frequent attention.
    if (!this.keys.left && !this.keys.right && !docked) {
      const roughT = Math.min(1, this.currentSea.choppiness * 0.7 + this.currentSea.waveHeight / 4.0);
      const wander = Math.sin(t * 0.08 + 1.3) + 0.5 * Math.sin(t * 0.19 + 4.1);
      const waveYaw = wander * roughT * 0.6;   // °/s slow drift
      this.heading = ((this.heading + (buoy.steeringBias + waveYaw) * dt) + 360) % 360;
    }

    // FLOAT_DRAFT: vertical offset so the hull sits correctly in the water. The rigged sloop's origin is
    // authored AT the waterline so 0 sits it right; per-vessel `floatDraft` raises a shallow open boat
    // (the pinnace) so the sea surface doesn't wash through its low hull.
    const FLOAT_DRAFT = floatDraftFor(this.vesselSlug, this.rig);

    // Cannon recoil: damped lateral roll response driven only by fire impulses.
    const recoilAcc = -this.RECOIL_SPRING * this.recoilRoll - this.RECOIL_DAMPING * this.recoilRollVel;
    this.recoilRollVel += recoilAcc * dt;
    this.recoilRoll += this.recoilRollVel * dt;
    if (this.recoilRoll > this.RECOIL_MAX_ROLL) this.recoilRoll = this.RECOIL_MAX_ROLL;
    if (this.recoilRoll < -this.RECOIL_MAX_ROLL) this.recoilRoll = -this.RECOIL_MAX_ROLL;
    if (Math.abs(this.recoilRoll) < 0.0002 && Math.abs(this.recoilRollVel) < 0.0002) {
      this.recoilRoll = 0;
      this.recoilRollVel = 0;
    }

    // Cannon recoil sway: a damped sideways lurch away from the firing side, layered
    // on top of the sim position so the hull visibly shudders sideways as it fires.
    const swayAcc = -this.RECOIL_SWAY_SPRING * this.recoilSway - this.RECOIL_SWAY_DAMPING * this.recoilSwayVel;
    this.recoilSwayVel += swayAcc * dt;
    this.recoilSway += this.recoilSwayVel * dt;
    if (this.recoilSway >  this.RECOIL_SWAY_MAX) this.recoilSway =  this.RECOIL_SWAY_MAX;
    if (this.recoilSway < -this.RECOIL_SWAY_MAX) this.recoilSway = -this.RECOIL_SWAY_MAX;
    if (Math.abs(this.recoilSway) < 0.0005 && Math.abs(this.recoilSwayVel) < 0.0005) {
      this.recoilSway = 0;
      this.recoilSwayVel = 0;
    }

    // Hit shudder (taking a cannonball): a separate, heavier spring-damper on its own
    // caps, added on top of the firing recoil.
    const hitRollAcc = -this.HIT_SPRING * this.hitRoll - this.HIT_DAMPING * this.hitRollVel;
    this.hitRollVel += hitRollAcc * dt;
    this.hitRoll += this.hitRollVel * dt;
    if (this.hitRoll >  this.HIT_MAX_ROLL) this.hitRoll =  this.HIT_MAX_ROLL;
    if (this.hitRoll < -this.HIT_MAX_ROLL) this.hitRoll = -this.HIT_MAX_ROLL;
    if (Math.abs(this.hitRoll) < 0.0002 && Math.abs(this.hitRollVel) < 0.0002) {
      this.hitRoll = 0; this.hitRollVel = 0;
    }
    const hitSwayAcc = -this.HIT_SPRING * this.hitSway - this.HIT_DAMPING * this.hitSwayVel;
    this.hitSwayVel += hitSwayAcc * dt;
    this.hitSway += this.hitSwayVel * dt;
    if (this.hitSway >  this.HIT_MAX_SWAY) this.hitSway =  this.HIT_MAX_SWAY;
    if (this.hitSway < -this.HIT_MAX_SWAY) this.hitSway = -this.HIT_MAX_SWAY;
    if (Math.abs(this.hitSway) < 0.0005 && Math.abs(this.hitSwayVel) < 0.0005) {
      this.hitSway = 0; this.hitSwayVel = 0;
    }

    // Apply the combined sway (firing recoil + hit shudder) along the hull's beam
    // (starboard) axis, overriding the plain sim position set earlier this frame.
    const totalSway = this.recoilSway + this.hitSway;
    if (totalSway !== 0) {
      const swayHRad = this.heading * Math.PI / 180;
      this.root.position.x = this.x + totalSway * Math.cos(swayHRad);
      this.root.position.z = this.z - totalSway * Math.sin(swayHRad);
    }

    // Server-correction reconciliation: glide out any residual render offset so a clamp/collision snap
    // reads as a quick slide rather than a pop. Decays frame-rate-independently; added on top of
    // whatever position was set above (sim or sway). Zero in the common (no-correction) case.
    if (this.corrErrX !== 0 || this.corrErrZ !== 0) {
      const decay = Math.exp(-this.CORR_DECAY * dt);
      this.corrErrX = Math.abs(this.corrErrX) < 0.01 ? 0 : this.corrErrX * decay;
      this.corrErrZ = Math.abs(this.corrErrZ) < 0.01 ? 0 : this.corrErrZ * decay;
      this.root.position.x += this.corrErrX;
      this.root.position.z += this.corrErrZ;
    }

    // Sink progress: eased 0→1 over SINK_DUR while sinking (curve handles the accelerating plunge), then
    // eased back to 0 on repair. Drives a deep draft drop + a dramatic capsize layered on below.
    if (this.sinking) {
      this.sinkEnv = sinkProgress(this.simTime - this.sinkStartT);
    } else if (this.sinkEnv > 0.0001) {
      this.sinkEnv += (0 - this.sinkEnv) * Math.min(1, dt * 1.8);
    } else {
      this.sinkEnv = 0;
    }

    // Settle the whole hull into the water as she sinks (overrides the anti-sink floor).
    this.root.position.y = FLOAT_DRAFT + heaveApplied - SINK_DEPTH * this.sinkEnv;

    // Feed the ocean's height-aware interior cut the current floor level so the cut rides the bob:
    // sea inside the hull above this is removed (dry), below it is kept (no see-through on a trough).
    if (this.rig.hullCut) {
      this.oceanService.setHullCutWaterY(this.root.position.y + this.rig.hullCut.floorY);
      // Discard path: the boat's ROOT world-Y is the height reference (silhouette heights are root-local, ~0 at
      // the waterline), so the per-pixel wave height ON the hull = ocean surface Y − this, riding the bob.
      this.oceanService.setHullCutRootY(this.root.position.y);
      // …plus the boat's full pitch/roll so the discard reads the heeled hull's waterline correctly (no slivers).
      // NOTE: rotation is set later in this method — read NEXT frame's value here, a 1-frame lag that's invisible.
      this.oceanService.setHullCutTilt(this.root.rotation.x, this.root.rotation.z);
    }

    // Combine sailing heel (wind-induced lean) with wave-induced roll.
    // Damage listing: ease toward the tilt implied by our hull state, then layer it on
    // top of wave roll + heel + recoil/hit. roll +stbd-down, pitch +bow-up (buoy convention).
    const hullMax = zoneHpFor(this.vesselSlug);
    const list = listingFor(this.combatService.zones(), hullMax);
    this.listRoll  += (list.roll  - this.listRoll)  * 0.04;
    this.listPitch += (list.pitch - this.listPitch) * 0.04;

    // Capsize: a dramatic heel/plunge toward the damaged side, scaled by sink progress, ADDED here so it
    // is free to exceed the buoyancy MAX_TILT clamp. Continues smoothly from the in-combat list.
    const cap = capsizeFor(this.combatService.zones(), hullMax);

    this.root.rotation.z = buoy.rollRad + (heelAngle * Math.PI / 180) + this.recoilRoll + this.hitRoll + this.listRoll + cap.roll * this.sinkEnv;
    this.root.rotation.x = buoy.pitchRad + this.listPitch + cap.pitch * this.sinkEnv + (this.rig.trimPitch ?? 0);

    // ── Rigged vessel drive (per-vessel controller via the VesselController interface) ─────────
    if (this.controller) {
      // Trim: the controller maps the eased sheet angle + tack onto its own rig (sloop braces yards +
      // swings the boom/gaff; pinnace scrubs its symmetric lug-trim clip).
      this.controller.setSailTrim(this.sheetAngleDeg, isPortTack);

      // Rudder/wheel: from the helm keys; when not steering, mirror the actual yaw
      // (wave wander + momentum) so the rudder isn't frozen amidships.
      let rudder = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
      if (rudder === 0) rudder = Math.max(-1, Math.min(1, this.turnRateSmoothed / 20));
      this.controller.setRudder(rudder);

      // Flag + pennant stream downwind, relative to the hull heading (the controller yaws
      // the bones about world-up so it's heel-independent).
      const windLocalRad = (((this.currentWind.fromBearingDeg + 180) % 360) - this.heading) * Math.PI / 180;
      this.controller.idleWind(windLocalRad, Math.min(1.2, this.currentWind.speed / 8), this.simTime);

      // Anchor: lower/raise the dropped side; keep the other stowed.
      this.anchorDeploy += ((this.isAnchored ? 1 : 0) - this.anchorDeploy) * Math.min(1, dt * 2.5);
      this.controller.dropAnchor('S', this.anchorSide === 'S' ? this.anchorDeploy : 0);
      this.controller.dropAnchor('P', this.anchorSide === 'P' ? this.anchorDeploy : 0);

      // Mast collapse/repair visual — driven off the same masts-zone health as the speed/helm penalty.
      // The instant the mast crosses to destroyed, play the drawn-out demasting crack (full volume — it's
      // your own ship). prevMastH starts at -1 so a ship that spawns already-dismasted doesn't crack.
      if (this.prevMastH > 0.001 && mastH <= 0.001) { this.mastCrackService.crack(1.0); }
      this.prevMastH = mastH;
      this.controller.setMastDamage(mastH);

      // Ease trim / boom-swing / furl toward their targets (no teleporting on tack/auto-trim).
      this.controller.tickRig(dt);
    }

    // Actual heading angular velocity (deg/s, shortest arc) — covers steering, wave
    // wander, and buoyancy yaw uniformly. Broadcast so remote clients can curve their
    // dead-reckoning through our turns instead of projecting straight.
    let hDelta = ((this.heading - this.prevHeading + 540) % 360) - 180;
    const turnRate = dt > 0 ? hDelta / dt : 0;
    // Light smoothing so a noisy per-frame value doesn't make remote turns jitter.
    this.turnRateSmoothed += (turnRate - this.turnRateSmoothed) * Math.min(1, dt * 8);
    this.prevHeading = this.heading;

    // Publish state
    this.zone.run(() => {
      this.state.set({
        x: this.x, z: this.z, heading: this.heading, speed: this.speed,
        turnRate: this.turnRateSmoothed,
        sailState: this.sailState, windAngle: angleFromWind, isPortTack, heelAngle,
        sheetAngle:  Math.round(this.sheetAngleDeg),
        trimQuality: this.trimQ,   // actual drive trim (apparent-angle + point-of-sail-aware under v2)
        anchored: this.isAnchored, anchorSide: this.anchorSide,
      });
    });
  }

  private updateWaterShadow(): void {
    if (!this.waterShadow) return;

    const sun = this.sceneService.scene.lights.find(l => l instanceof DirectionalLight && l.name === 'sun') as DirectionalLight | undefined;
    if (!sun || sun.direction.y >= -0.01) {
      this.waterShadow.setEnabled(false);
      return;
    }

    const sunDir = sun.direction.negate().normalize();
    const shadowDirX = -sunDir.x;
    const shadowDirZ = -sunDir.z;
    const stretch = 1.8 + Math.min(3.5, (1 - Math.max(0, sunDir.y)) * 4.5);
    const offset = 1.5 + Math.min(10, (1 - Math.max(0, sunDir.y)) * 9.0);

    this.waterShadow.setEnabled(true);
    this.waterShadow.position.x = this.x + shadowDirX * offset;
    this.waterShadow.position.z = this.z + shadowDirZ * offset;
    this.waterShadow.position.y = this.oceanService.getWaveHeightAt(this.x, this.z, this.simTime) + 0.06;
    this.waterShadow.scaling.x = stretch * 1.65;
    this.waterShadow.scaling.y = 1.0;
    this.waterShadow.scaling.z = stretch * 1.10;
    this.waterShadow.rotation.y = Math.atan2(shadowDirX, shadowDirZ);
    this.waterShadow.visibility = 0.34 + (1 - Math.max(0, sunDir.y)) * 0.48;
  }

  private updateCamera(dt: number): void {
    const cam = this.sceneService.camera;
    if (!cam) return;

    // Strip last frame's camera-shake offset first so neither path (orbit follow-ease OR FP placement)
    // feeds the transient jitter back into the base position.
    cam.position.subtractInPlace(this.camShakeOffset);

    // ── Camera shake ──────────────────────────────────────────────────────────
    // A damped oscillation: a ~2 Hz sine (slow enough to read as a clear back-and-forth) with a LINEAR
    // amplitude envelope from the decaying trauma, so the camera swings a few times, each a little
    // smaller, then settles. Phase resets on a fresh shake (addShakeTrauma). Computed here; ADDED to the
    // final camera position at the end of whichever branch runs below.
    this.camTrauma = Math.max(0, this.camTrauma - dt * this.CAM_TRAUMA_DECAY);
    let shX = 0, shY = 0, shZ = 0;   // raw positional jitter (first-person magnitude)
    if (this.camTrauma > 1e-3) {
      this.shakeTime += dt;
      const st = this.shakeTime, amp = this.CAM_SHAKE_MAX * this.camTrauma;
      shX = Math.sin(st * this.CAM_SHAKE_FREQ)              * amp;          // primary lateral swing (~2 Hz)
      shY = Math.sin(st * this.CAM_SHAKE_FREQ * 1.11 + 1.2) * amp * 0.55;   // vertical, smaller, slightly detuned
      shZ = Math.sin(st * this.CAM_SHAKE_FREQ * 0.87 + 2.4) * amp * 0.50;   // fore-aft
    }
    // First-person uses the raw offset (it sits ON the eye → already strong); the 3rd-person branch overwrites
    // camShakeOffset with a distance-scaled version below. Always store the FINAL applied offset so next frame's
    // strip removes exactly what was added.
    this.camShakeOffset.set(shX, shY, shZ);

    // ── First-person ("on deck"): sit at the deck eye point looking forward; drag = free-look. ──
    if (this.firstPerson() && this.fpEye && this.root) {
      // Eye = the vessel-local point through the hull's CURRENT world matrix, so it rides with
      // heave/heel/pitch like a real helmsman. (physicsStep set the pose earlier this frame.)
      this.root.computeWorldMatrix(true);

      // Deck-walk: step the local eye in the look direction (in vessel-local space, so it moves with the ship),
      // then clamp its height to the deck below. Movement only when a walk key is held (the keyHandler sets these
      // only while ON DECK with the left button down). The deck raycast blocks stepping off the edge or up a wall.
      const moveLocal = new Vector3(0, 0, 0);
      if (this.walk.fwd || this.walk.back || this.walk.left || this.walk.right) {
        const yawR = this.fpYaw * Math.PI / 180;   // look yaw relative to the bow → forward in vessel-local XZ
        const fwd = new Vector3(Math.sin(yawR), 0, Math.cos(yawR));
        const rgt = new Vector3(Math.cos(yawR), 0, -Math.sin(yawR));
        if (this.walk.fwd)   moveLocal.addInPlace(fwd);
        if (this.walk.back)  moveLocal.subtractInPlace(fwd);
        if (this.walk.right) moveLocal.addInPlace(rgt);
        if (this.walk.left)  moveLocal.subtractInPlace(rgt);
      }
      const curDeck = this.fpEye.y - this.WALK_EYE;   // current deck (foot) level — the band reference for the raycast
      if (moveLocal.lengthSquared() > 1e-6) {
        moveLocal.normalize().scaleInPlace(this.WALK_SPEED * dt);
        const tx = this.fpEye.x + moveLocal.x, tz = this.fpEye.z + moveLocal.z;
        // Step only onto deck within a gentle band of the current level (deckLocalHeight enforces it) — this blocks
        // walking off the rail (big drop) and climbing the rigging/mast (overhead spars are outside the band).
        if (this.deckLocalHeight(tx, tz, curDeck) !== null) { this.fpEye.x = tx; this.fpEye.z = tz; }
      }
      const deckY = this.deckLocalHeight(this.fpEye.x, this.fpEye.z, curDeck);
      if (deckY !== null) this.fpEye.y = deckY + this.WALK_EYE;   // glue the eye to standing height above the deck

      const eye = Vector3.TransformCoordinates(this.fpEye, this.root.getWorldMatrix());
      eye.addInPlace(this.camShakeOffset);
      cam.position.copyFrom(eye);
      const yaw   = (this.heading + this.fpYaw) * Math.PI / 180;
      const pitch = this.fpPitch * Math.PI / 180;
      const cp    = Math.cos(pitch);
      cam.setTarget(new Vector3(
        eye.x + Math.sin(yaw) * cp * 20,
        eye.y + Math.sin(pitch)    * 20,
        eye.z + Math.cos(yaw) * cp * 20,
      ));
      return;
    }

    // ── Orbit follow (default 3rd-person) ───────────────────────────────────────────────────────
    // Azimuth is relative to vessel heading so the camera stays behind the boat as it turns, but the
    // user can swing it around. Frame-rate-independent follow ease (1 - e^(-k·dt)); k=5 ≈ the old 0.08
    // at 60 fps — keeps the distant cloud reprojection from jittering as dt varies.
    const azRad   = (this.heading + this.camAzimuth) * Math.PI / 180;
    const elevRad = this.camElevation * Math.PI / 180;
    const targetX = this.x;
    const targetY = 2.5;   // aim at lower-mast level
    const targetZ = this.z;
    const desiredX = targetX - Math.cos(elevRad) * Math.sin(azRad) * this.camDist;
    const desiredZ = targetZ - Math.cos(elevRad) * Math.cos(azRad) * this.camDist;
    const desiredY = targetY + Math.sin(elevRad) * this.camDist;

    const lerp = this.isDragging ? 1.0 : 1 - Math.exp(-5 * dt);
    cam.position.x += (desiredX - cam.position.x) * lerp;
    cam.position.y += (desiredY - cam.position.y) * lerp;
    cam.position.z += (desiredZ - cam.position.z) * lerp;

    // Terrain collision: never let the camera dip below the landscape (rides up & along a hill/cliff).
    const groundY = this.sceneService.getTerrainHeight(cam.position.x, cam.position.z);
    if (groundY !== null) {
      const minY = groundY + 3.0;
      if (cam.position.y < minY) { cam.position.y = minY; }
    }

    // Distance-compensate the positional shake so it reads at any zoom (a 1 m offset is invisible 60 m out).
    const distScale = Math.min(this.SHAKE_DIST_MAX, Math.max(1, this.camDist / this.SHAKE_DIST_REF));
    this.camShakeOffset.scaleInPlace(distScale);
    cam.position.addInPlace(this.camShakeOffset);

    // Rotational VIEW JOLT — the jarring kick: snap the aim point by a small ANGLE (so the whole frame whips,
    // not just slides). Offset ∝ camDist keeps the angle constant at any zoom; higher frequency than the
    // positional swing reads as a violent rattle. Decays with trauma; no jolt once it's spent.
    let tjx = 0, tjy = 0;
    if (this.camTrauma > 1e-3) {
      const ra = this.CAM_SHAKE_ROT * this.camTrauma * this.camDist, rt = this.shakeTime;
      tjx = Math.sin(rt * this.CAM_SHAKE_FREQ * 1.8)       * ra;          // horizontal whip (fast)
      tjy = Math.sin(rt * this.CAM_SHAKE_FREQ * 2.1 + 1.7) * ra * 0.7;    // vertical, detuned
    }
    cam.setTarget(new Vector3(targetX + tjx, targetY + tjy, targetZ));
  }

  /** Ship structural meshes (hull/deck/furniture) to raycast the deck-walk eye onto. Merged ship meshes get
   *  unpredictable names, so filter by EXCLUSION (water/sails/flags/crew), like the crew deck raycast. Cached per
   *  vessel; the picking octree is render-selection OFF (else it frustum-culls deck submeshes on the big ships). */
  private deckCandsCam(): AbstractMesh[] {
    if (this.deckCamMeshes) return this.deckCamMeshes;
    const skip = /water|ocean|impostor|sail|flag/i;
    const out: AbstractMesh[] = [];
    for (const me of this.root.getChildMeshes(false)) {
      if (!me.getTotalVertices() || skip.test(me.name) || me.name.startsWith('crew_') || me.name.startsWith('ik_')) continue;
      if (me.getTotalVertices() > 1500) {
        try {
          const om = me as unknown as { createOrUpdateSubmeshesOctree?(c: number, d: number): void; useOctreeForRenderingSelection?: boolean };
          om.createOrUpdateSubmeshesOctree?.(64, 2);
          om.useOctreeForRenderingSelection = false;
        } catch { /* */ }
      }
      out.push(me);
    }
    this.deckCamMeshes = out;
    return out;
  }

  /** Ship-local Y of the deck below a vessel-local XZ, found by a short down-ray in the ship vertical. Accepts only
   *  a hit within a gentle band of the current foot level `footY` (`[footY-3, footY+0.9]`): this lets the quarterdeck
   *  stairs through and follows the deck down, but IGNORES overhead spars/booms/yards/mast-tops (so you can't climb
   *  the rigging) and refuses a big drop off the rail. Returns the highest in-band hit, or null = off the deck. */
  private deckLocalHeight(lx: number, lz: number, footY: number): number | null {
    const wm = this.root.getWorldMatrix();
    const origin = Vector3.TransformCoordinates(new Vector3(lx, footY + 2.2, lz), wm);
    const down = Vector3.TransformNormal(new Vector3(0, -1, 0), wm).normalize();
    const ray = new Ray(origin, down, 6);
    const inv = wm.clone(); inv.invert();
    let best: number | null = null;
    for (const me of this.deckCandsCam()) {
      const pick = ray.intersectsMesh(me as never, false);
      if (pick.hit && pick.pickedPoint) {
        const ly = Vector3.TransformCoordinates(pick.pickedPoint, inv).y;
        if (ly >= footY - 3 && ly <= footY + 0.9 && (best === null || ly > best)) best = ly;
      }
    }
    return best;
  }

  private setupCameraInput(): void {
    const scene  = this.sceneService.scene;
    const canvas = this.sceneService.engine.getRenderingCanvas();

    // Use BabylonJS pointer observable — guaranteed to fire even when the scene
    // registers its own internal pointer listeners on the canvas.
    this.pointerObserver = scene.onPointerObservable.add((info) => {
      const ev = info.event as PointerEvent;
      switch (info.type) {
        case PointerEventTypes.POINTERDOWN:
          if (ev.button === 0) {
            this.isDragging = true;
            this.lastMouseX = ev.clientX;
            this.lastMouseY = ev.clientY;
            this.invertCamY = localStorage.getItem('ignis_invert_camera') === '1';   // refresh per-drag
            if (canvas) canvas.style.cursor = 'grabbing';
          }
          break;
        case PointerEventTypes.POINTERMOVE:
          if (this.isDragging) {
            const dx = ev.clientX - this.lastMouseX;
            const dy = ev.clientY - this.lastMouseY;
            this.lastMouseX = ev.clientX;
            this.lastMouseY = ev.clientY;
            const invY = this.invertCamY ? -1 : 1;   // flips the vertical-look axis when enabled
            if (this.firstPerson()) {
              // Free-look from the deck: drag yaws/pitches the view (yaw is free 360°; pitch clamped).
              this.fpYaw   += dx * 0.30;
              this.fpPitch  = Math.max(-70, Math.min(70, this.fpPitch - dy * 0.25 * invY));
            } else {
              this.camAzimuth   += dx * 0.45;
              this.camElevation  = Math.max(-5, Math.min(85, this.camElevation - dy * 0.3 * invY));
            }
          }
          break;
        case PointerEventTypes.POINTERUP:
          this.isDragging = false;
          this.clearWalk();   // releasing the button stops deck-walking even if keys are still held
          if (canvas) canvas.style.cursor = 'default';
          break;
      }
    });

    // Wheel zoom stays as a DOM event — no BabylonJS interference here.
    if (canvas) {
      this.wheelHandler = (e: WheelEvent) => {
        this.camDist = Math.max(8, Math.min(80, this.camDist + e.deltaY * 0.04));
        e.preventDefault();
      };
      canvas.addEventListener('wheel', this.wheelHandler, { passive: false });
    }
  }

  // ── Input handling ────────────────────────────────────────────────────────

  private stepSail(dir: 1 | -1): void {
    const order: SailState[] = ['reefed', 'topsails', 'full'];
    const next = order[Math.max(0, Math.min(2, order.indexOf(this.sailState) + dir))];
    if (next !== this.sailState) this.setSailState(next);
  }

  private setupInput(): void {
    const typing = () => document.activeElement instanceof HTMLInputElement ||
                         document.activeElement instanceof HTMLTextAreaElement;
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.repeat || typing()) return;   // ignore OS key-repeat: held keys are tracked via keyup below
      // Deck-walk: while ON DECK (first-person) with the LEFT BUTTON HELD, WASD/arrows walk the camera across the
      // deck instead of steering/trimming. Set the per-frame boolean and consume the event (no Angular CD needed).
      if (this.firstPerson() && this.isDragging) {
        switch (e.code) {
          case 'KeyW': case 'ArrowUp':    this.walk.fwd = true;   return;
          case 'KeyS': case 'ArrowDown':  this.walk.back = true;  return;
          case 'KeyA': case 'ArrowLeft':  this.walk.left = true;  return;
          case 'KeyD': case 'ArrowRight': this.walk.right = true; return;
        }
      }
      // Re-enter the Angular zone so a discrete press refreshes the HUD (sail/anchor/view indicators).
      // The listener itself is registered OUTSIDE the zone (below), so held keys add no per-event CD.
      this.zone.run(() => {
        switch (e.code) {
          case 'ArrowLeft':  case 'KeyA': this.keys.left     = true; break;
          case 'ArrowRight': case 'KeyD': this.keys.right    = true; break;
          case 'KeyQ': this.keys.sheetOut = true;  break;   // ease sheet (sail swings out)
          case 'KeyE': this.keys.sheetIn  = true;  break;   // haul in sheet (sail comes in)
          case 'KeyW': this.stepSail(1);  break;   // step sail up
          case 'KeyS': this.stepSail(-1); break;   // step sail down
          case 'KeyT': {                            // auto-trim: jump to optimal sheet angle
            const curState = this.state();
            const optimal  = this.optimalSheetAngle(Math.abs(curState.windAngle));
            this.sheetAngleDeg = optimal;
            break;
          }
          case 'Digit1': this.setSailState('reefed');   break;
          case 'Digit2': this.setSailState('topsails'); break;
          case 'Digit3': this.setSailState('full');     break;
          case 'KeyP':   this.toggleAnchor();           break;
          case 'KeyV':   this.toggleFirstPerson();      break;   // switch first-person / orbit view
        }
      });
    };
    this.keyUpHandler = (e: KeyboardEvent) => {
      if (typing()) return;
      switch (e.code) {   // steering booleans only — read by the render loop, no HUD change → no CD needed
        case 'ArrowLeft':  case 'KeyA': this.keys.left  = false; this.walk.left  = false; break;
        case 'ArrowRight': case 'KeyD': this.keys.right = false; this.walk.right = false; break;
        case 'KeyQ': this.keys.sheetOut = false; break;
        case 'KeyE': this.keys.sheetIn  = false; break;
        case 'KeyW': case 'ArrowUp':   this.walk.fwd  = false; break;
        case 'KeyS': case 'ArrowDown': this.walk.back = false; break;
      }
    };
    // Holding a key fires keydown ~60×/s (OS repeat). Each one reaching an in-zone @HostListener (HUD,
    // game-component, minimap…) triggers a full Angular change-detection pass; 60 CD/s of the HUD signal
    // tree saturates the main thread and starves the Tone.js MIDI scheduler's note callbacks (they run on
    // the main thread) → the music stutters/locks while a key is held. Swallow REPEAT events in the
    // CAPTURE phase, before they reach those bubble-phase listeners. Gameplay is unaffected (held keys are
    // tracked by the first non-repeat press + keyup). Skip while typing so text-field repeat still works.
    this.repeatSwallow = (e: KeyboardEvent) => {
      if (e.repeat && !typing()) { e.stopPropagation(); }
    };
    // Register OUTSIDE the Angular zone so these high-frequency events add no change detection of their own.
    this.zone.runOutsideAngular(() => {
      window.addEventListener('keydown', this.repeatSwallow, true);   // capture: runs before bubble HostListeners
      window.addEventListener('keydown', this.keyHandler);
      window.addEventListener('keyup',   this.keyUpHandler);
    });
  }

  // ── Wake / hull-wash particle systems ────────────────────────────────────

  private buildWake(scene: Scene): void {
    // Shared foam texture: soft radial gradient, slightly wider than tall
    this.wakeTex = new DynamicTexture('wakeFoamTex', { width: 128, height: 128 }, scene, false);
    const ctx    = this.wakeTex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 128, 128);
    const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0.00, 'rgba(255,255,255,1.00)');
    grd.addColorStop(0.30, 'rgba(235,248,255,0.82)');
    grd.addColorStop(0.65, 'rgba(210,235,255,0.28)');
    grd.addColorStop(1.00, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
    this.wakeTex.update();
    this.wakeTex.hasAlpha = true;

    // ── Bow spray ──────────────────────────────────────────────────────────
    // Emits from the bow, particles pushed sideways to form the bow wave.
    this.bowSpray = new ParticleSystem('bowSpray', 400, scene);
    this.bowSpray.particleTexture = this.wakeTex;
    this.bowSpray.emitter    = this.bowEmit;
    this.bowSpray.minEmitBox = new Vector3(-0.4, 0, -0.4);
    this.bowSpray.maxEmitBox = new Vector3( 0.4, 0,  0.4);
    this.bowSpray.color1     = new Color4(1.00, 1.00, 1.00, 0.72);
    this.bowSpray.color2     = new Color4(0.88, 0.95, 1.00, 0.50);
    this.bowSpray.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.bowSpray.minSize     = 0.5;  this.bowSpray.maxSize     = 2.0;
    this.bowSpray.minLifeTime = 0.5;  this.bowSpray.maxLifeTime = 2.0;
    this.bowSpray.minEmitPower = 3;   this.bowSpray.maxEmitPower = 9;
    this.bowSpray.updateSpeed  = 0.016;
    // direction1/direction2 are heading-dependent — set in updateWake each tick
    this.bowSpray.direction1 = new Vector3(-1, 0.6, 0);
    this.bowSpray.direction2 = new Vector3( 1, 0.6, 0);
    this.bowSpray.gravity    = new Vector3(0, -2.0, 0);
    this.bowSpray.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.bowSpray.emitRate   = 0;
    this.bowSpray.start();

    // ── Stern foam (long-life wake V-trail) ────────────────────────────────
    // Low velocity so particles stay roughly where spawned; the moving boat
    // leaves them behind, naturally building a long V-shaped foam trail.
    this.sternFoam = new ParticleSystem('sternFoam', 900, scene);
    this.sternFoam.particleTexture = this.wakeTex;
    this.sternFoam.emitter    = this.sternEmit;
    this.sternFoam.minEmitBox = new Vector3(-1.0, 0, -0.5);
    this.sternFoam.maxEmitBox = new Vector3( 1.0, 0,  0.5);
    this.sternFoam.color1     = new Color4(1.00, 1.00, 1.00, 0.60);
    this.sternFoam.color2     = new Color4(0.85, 0.94, 1.00, 0.38);
    this.sternFoam.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.sternFoam.minSize     = 1.0;  this.sternFoam.maxSize     = 3.5;
    this.sternFoam.minLifeTime = 5.0;  this.sternFoam.maxLifeTime = 14.0;
    this.sternFoam.minEmitPower = 1.0; this.sternFoam.maxEmitPower = 4.0;
    this.sternFoam.updateSpeed  = 0.016;
    this.sternFoam.direction1 = new Vector3(-1, 0, -1);
    this.sternFoam.direction2 = new Vector3( 1, 0,  1);
    this.sternFoam.gravity    = Vector3.Zero();
    this.sternFoam.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.sternFoam.emitRate   = 0;
    this.sternFoam.start();

    // ── Port hull froth ────────────────────────────────────────────────────
    this.portFroth = new ParticleSystem('portFroth', 300, scene);
    this.portFroth.particleTexture = this.wakeTex;
    this.portFroth.emitter    = this.portEmit;
    this.portFroth.minEmitBox = new Vector3(-0.3, 0, -1.5);
    this.portFroth.maxEmitBox = new Vector3( 0.3, 0,  1.5);
    this.portFroth.color1     = new Color4(1.00, 1.00, 1.00, 0.55);
    this.portFroth.color2     = new Color4(0.90, 0.96, 1.00, 0.30);
    this.portFroth.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.portFroth.minSize     = 0.3;  this.portFroth.maxSize     = 1.2;
    this.portFroth.minLifeTime = 0.5;  this.portFroth.maxLifeTime = 2.5;
    this.portFroth.minEmitPower = 2;   this.portFroth.maxEmitPower = 6;
    this.portFroth.updateSpeed  = 0.016;
    this.portFroth.direction1 = new Vector3(-1, 0.1, 0);
    this.portFroth.direction2 = new Vector3(-3, 0.2, 0);
    this.portFroth.gravity    = new Vector3(0, -0.3, 0);
    this.portFroth.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.portFroth.emitRate   = 0;
    this.portFroth.start();

    // ── Stbd hull froth ────────────────────────────────────────────────────
    this.stbdFroth = new ParticleSystem('stbdFroth', 300, scene);
    this.stbdFroth.particleTexture = this.wakeTex;
    this.stbdFroth.emitter    = this.stbdEmit;
    this.stbdFroth.minEmitBox = new Vector3(-0.3, 0, -1.5);
    this.stbdFroth.maxEmitBox = new Vector3( 0.3, 0,  1.5);
    this.stbdFroth.color1     = new Color4(1.00, 1.00, 1.00, 0.55);
    this.stbdFroth.color2     = new Color4(0.90, 0.96, 1.00, 0.30);
    this.stbdFroth.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.stbdFroth.minSize     = 0.3;  this.stbdFroth.maxSize     = 1.2;
    this.stbdFroth.minLifeTime = 0.5;  this.stbdFroth.maxLifeTime = 2.5;
    this.stbdFroth.minEmitPower = 2;   this.stbdFroth.maxEmitPower = 6;
    this.stbdFroth.updateSpeed  = 0.016;
    this.stbdFroth.direction1 = new Vector3(1, 0.1, 0);
    this.stbdFroth.direction2 = new Vector3(3, 0.2, 0);
    this.stbdFroth.gravity    = new Vector3(0, -0.3, 0);
    this.stbdFroth.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.stbdFroth.emitRate   = 0;
    this.stbdFroth.start();
  }

  private resetWake(): void {
    // Snap emitters to current position so old particles don't linger in the wrong place
    this.updateWake();
  }

  private updateWake(): void {
    const absSpeed = Math.abs(this.speed);
    const hdgR     = this.heading * Math.PI / 180;

    // Forward unit vector (direction the bow points)
    const fwdX =  Math.sin(hdgR);
    const fwdZ =  Math.cos(hdgR);
    // Right unit vector (starboard side)
    const rgtX =  Math.cos(hdgR);
    const rgtZ = -Math.sin(hdgR);

    // Approximate hull geometry (world units) — per-vessel so the foam spawns at the real bow/stern/rails.
    const halfLen = this.rig.hullHalfLen;   // bow/stern offset from vessel centre
    const halfBm  = this.rig.hullHalfBeam;  // half-beam (port/stbd offset)
    const Y       = this.WAKE_Y;

    // ── Reposition emitters ──────────────────────────────────────────────
    this.bowEmit.set(
      this.x + fwdX * halfLen,
      Y,
      this.z + fwdZ * halfLen,
    );
    this.sternEmit.set(
      this.x - fwdX * halfLen,
      Y,
      this.z - fwdZ * halfLen,
    );
    this.portEmit.set(
      this.x - rgtX * halfBm,
      Y,
      this.z - rgtZ * halfBm,
    );
    this.stbdEmit.set(
      this.x + rgtX * halfBm,
      Y,
      this.z + rgtZ * halfBm,
    );

    // ── Speed fraction — drives emit rates, sizes, and vertical spray height ─
    const moving = absSpeed > 0.3;
    const sf     = moving ? Math.min(1, absSpeed / this.physics.maxSpeed) : 0;

    // ── Heading-dependent direction vectors ───────────────────────────────
    // Bow: spray sideways + upward — Y scales with speed for dramatic high-speed plumes
    const bowY = 0.5 + sf * 0.9;
    this.bowSpray.direction1.set(-rgtX * 4 - fwdX, bowY, -rgtZ * 4 - fwdZ);
    this.bowSpray.direction2.set( rgtX * 4 - fwdX, bowY,  rgtZ * 4 - fwdZ);

    // Stern: spread sideways and slightly aft; long-lifetime particles form the V
    this.sternFoam.direction1.set(-fwdX * 2 - rgtX * 4, 0, -fwdZ * 2 - rgtZ * 4);
    this.sternFoam.direction2.set(-fwdX * 2 + rgtX * 4, 0, -fwdZ * 2 + rgtZ * 4);

    // Port: pushed outward to port side
    this.portFroth.direction1.set(-rgtX * 2 - fwdX * 0.5, 0.15, -rgtZ * 2 - fwdZ * 0.5);
    this.portFroth.direction2.set(-rgtX * 4 - fwdX * 0.5, 0.25, -rgtZ * 4 - fwdZ * 0.5);

    // Stbd: pushed outward to starboard side
    this.stbdFroth.direction1.set( rgtX * 2 - fwdX * 0.5, 0.15,  rgtZ * 2 - fwdZ * 0.5);
    this.stbdFroth.direction2.set( rgtX * 4 - fwdX * 0.5, 0.25,  rgtZ * 4 - fwdZ * 0.5);

    // ── Emit rates — scale with speed, cut off below threshold ───────────

    const wf = this.WAKE_PARTICLES_ENABLED ? sf : 0;
    this.bowSpray.emitRate  = Math.round(wf * 100);
    this.sternFoam.emitRate = Math.round(wf * 70);
    this.portFroth.emitRate = Math.round(wf * 55);
    this.stbdFroth.emitRate = Math.round(wf * 55);

    // ── Size scales modestly with speed ───────────────────────────────────
    const sizeBoost = sf * 0.6;
    this.bowSpray.maxSize  = 2.0 + sizeBoost;
    this.sternFoam.maxSize = 3.5 + sizeBoost;

    // ── Inform ocean service so wake plane shader knows boat position ──────
    this.oceanService.setBoatTransform(this.x, this.z, hdgR, this.speed);
  }

  // ── PBR material & texture helpers ────────────────────────────────────────

  private getTex(
    scene: Scene,
    key: string,
    factory: () => DynamicTexture,
  ): DynamicTexture {
    if (!this.texPool.has(key)) this.texPool.set(key, factory());
    return this.texPool.get(key)!;
  }

  /** Minimal seeded LCG — deterministic per texture name so grain is stable across reloads. */
  private makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  /**
   * Procedural wood-grain albedo texture (256 × 256).
   * Uses bezier curves for bold plank lines plus a fine-grain overlay.
   */
  private makeWoodAlbedo(
    scene: Scene,
    name: string,
    baseRgb: [number, number, number],
    darkRgb: [number, number, number],
    grainCount: number,
  ): DynamicTexture {
    const SZ  = 256;
    const tex = new DynamicTexture(name, { width: SZ, height: SZ }, scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const [br, bg, bb] = baseRgb;
    const [dr, dg, db] = darkRgb;

    ctx.fillStyle = `rgb(${br},${bg},${bb})`;
    ctx.fillRect(0, 0, SZ, SZ);

    const rng = this.makeRng(name.charCodeAt(0) * 37 + grainCount);

    // Bold grain lines — bezier curves spanning the full texture height
    for (let g = 0; g < grainCount; g++) {
      const x0   = rng() * SZ;
      const x1   = x0 + (rng() - 0.5) * 40;
      const cp1x = x0 + (rng() - 0.5) * 30;
      const cp2x = x1 + (rng() - 0.5) * 30;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.bezierCurveTo(cp1x, SZ * 0.33, cp2x, SZ * 0.67, x1, SZ);
      ctx.strokeStyle = `rgba(${dr},${dg},${db},${(0.4 + rng() * 0.4).toFixed(2)})`;
      ctx.lineWidth   = 0.5 + rng() * 1.5;
      ctx.stroke();
    }

    // Fine-grain overlay — many thin, subtle lines for close-up richness
    for (let g = 0; g < grainCount * 3; g++) {
      const x0 = rng() * SZ;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0 + (rng() - 0.5) * 20, SZ);
      ctx.strokeStyle = `rgba(${dr},${dg},${db},${(0.08 + rng() * 0.12).toFixed(2)})`;
      ctx.lineWidth   = 0.3 + rng() * 0.5;
      ctx.stroke();
    }

    tex.update();
    return tex;
  }

  /**
   * Procedural wood-grain normal map (256 × 256).
   * Encodes groove cross-section profiles as tangent-space normals:
   *   R=128 (X=0), G varies across groove slope, B reduced at groove center.
   */
  private makeWoodNormal(
    scene: Scene,
    name: string,
    grainCount: number,
  ): DynamicTexture {
    const SZ  = 256;
    const tex = new DynamicTexture(name + '_nrm', { width: SZ, height: SZ }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const img = ctx.createImageData(SZ, SZ);
    const px  = img.data;

    // Seed with flat tangent-space normal: R=128(X=0), G=128(Y=0), B=255(Z=+1)
    for (let i = 0; i < SZ * SZ; i++) {
      px[i * 4 + 0] = 128;
      px[i * 4 + 1] = 128;
      px[i * 4 + 2] = 255;
      px[i * 4 + 3] = 255;
    }

    const rng = this.makeRng(name.charCodeAt(0) * 53 + grainCount + 7);
    for (let g = 0; g < grainCount; g++) {
      const cx   = (rng() * SZ) | 0;
      const half = 1 + Math.round(rng() * 2);   // groove half-width: 1–3 px
      for (let y = 0; y < SZ; y++) {
        const drift = Math.round((rng() - 0.5) * 3);   // slight meander per row
        for (let w = -half; w <= half; w++) {
          const x   = ((cx + drift + w) + SZ) % SZ;
          const t   = w / half;                             // -1 to +1 across groove
          // G encodes cross-groove slope (left wall tilts one way, right the other)
          const gV  = Math.round(128 + 26 * t) & 0xff;
          // B slightly reduced at the groove center (concave shadow)
          const bV  = Math.round(230 + 25 * (t * t)) & 0xff;
          const idx = (y * SZ + x) * 4;
          px[idx + 1] = gV;
          px[idx + 2] = bV;
        }
      }
    }

    ctx.putImageData(img, 0, 0);
    tex.update();
    return tex;
  }

  /**
   * Build (or retrieve from cache) the PBR material for a vessel part.
   * Dispatches on `part.materialType`; falls back to a flat-colour PBR for
   * any part that has no materialType annotation.
   */
  private buildVesselMat(part: VesselPart, scene: Scene): PBRMaterial {
    const key = part.materialType ?? ('_hex_' + part.material.color);
    if (this.matPool.has(key)) return this.matPool.get(key)!;

    const m = new PBRMaterial(key + '_mat', scene);
    m.metallic  = 0;
    m.roughness = 0.6;

    switch (part.materialType) {

      case 'wood_hull': {
        const alb = this.getTex(scene, 'wood_hull_alb', () =>
          this.makeWoodAlbedo(scene, 'wood_hull_alb', [59, 34, 18], [26, 10, 5], 14));
        const nrm = this.getTex(scene, 'wood_hull_nrm', () =>
          this.makeWoodNormal(scene, 'wood_hull', 14));
        alb.uScale = 3; alb.vScale = 3;
        nrm.uScale = 3; nrm.vScale = 3;
        nrm.level  = 0.55;   // subtle plank grooves — not deep carving
        m.albedoTexture = alb;
        m.bumpTexture   = nrm;
        m.roughness     = 0.88;
        break;
      }

      case 'wood_teak': {
        const alb = this.getTex(scene, 'wood_teak_alb', () =>
          this.makeWoodAlbedo(scene, 'wood_teak_alb', [155, 120, 32], [94, 62, 10], 10));
        const nrm = this.getTex(scene, 'wood_teak_nrm', () =>
          this.makeWoodNormal(scene, 'wood_teak', 10));
        alb.uScale = 4; alb.vScale = 4;
        nrm.uScale = 4; nrm.vScale = 4;
        nrm.level  = 0.50;
        m.albedoTexture = alb;
        m.bumpTexture   = nrm;
        m.roughness     = 0.78;
        break;
      }

      case 'wood_spar': {
        const alb = this.getTex(scene, 'wood_spar_alb', () =>
          this.makeWoodAlbedo(scene, 'wood_spar_alb', [216, 213, 200], [174, 171, 158], 20));
        const nrm = this.getTex(scene, 'wood_spar_nrm', () =>
          this.makeWoodNormal(scene, 'wood_spar', 20));
        alb.uScale = 2; alb.vScale = 6;
        nrm.uScale = 2; nrm.vScale = 6;
        nrm.level  = 0.45;   // fine grain — varnished spar, not rough plank
        m.albedoTexture = alb;
        m.bumpTexture   = nrm;
        m.roughness     = 0.55;
        break;
      }

      case 'brass':
        m.albedoColor = new Color3(0.78, 0.59, 0.16);
        m.metallic    = 0.80;
        m.roughness   = 0.38;
        break;

      case 'steel':
        m.albedoColor = new Color3(0.78, 0.80, 0.82);
        m.metallic    = 1.0;
        m.roughness   = 0.22;
        break;

      case 'black_metal':
        m.albedoColor = new Color3(0.08, 0.08, 0.08);
        m.metallic    = 0.65;
        m.roughness   = 0.52;
        break;

      case 'paint_white':
        m.albedoColor = new Color3(0.91, 0.91, 0.88);
        m.roughness   = 0.50;
        break;

      case 'paint_cream':
        m.albedoColor = new Color3(0.94, 0.93, 0.85);
        m.roughness   = 0.52;
        break;

      case 'paint_navy':
        m.albedoColor = new Color3(0.10, 0.17, 0.24);
        m.roughness   = 0.45;
        break;

      case 'rubber':
        m.albedoColor = new Color3(0.16, 0.16, 0.16);
        m.roughness   = 0.95;
        break;

      case 'glass':
        m.albedoColor      = new Color3(0.12, 0.14, 0.18);
        m.metallic         = 0.05;
        m.roughness        = 0.04;
        m.alpha            = 0.55;
        m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
        break;

      case 'rope':
        m.albedoColor = new Color3(0.78, 0.66, 0.42);
        m.roughness   = 0.92;
        break;

      case 'nav_red':
        m.albedoColor       = new Color3(0.85, 0.08, 0.05);
        m.emissiveColor     = new Color3(0.80, 0.04, 0.02);
        m.emissiveIntensity = 2.0;
        m.roughness         = 0.30;
        break;

      case 'nav_green':
        m.albedoColor       = new Color3(0.05, 0.75, 0.25);
        m.emissiveColor     = new Color3(0.02, 0.50, 0.10);
        m.emissiveIntensity = 2.0;
        m.roughness         = 0.30;
        break;

      case 'nav_white':
        m.albedoColor       = new Color3(1.0, 1.0, 0.94);
        m.emissiveColor     = new Color3(1.0, 1.0, 0.90);
        m.emissiveIntensity = 1.5;
        m.roughness         = 0.30;
        break;

      default:
        // Fallback: read flat colour from part.material (legacy / un-annotated parts)
        m.albedoColor = Color3.FromHexString(part.material.color);
        if (part.material.alpha !== undefined) {
          m.alpha            = part.material.alpha;
          m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
        }
        if (part.material.emissive !== undefined) {
          m.emissiveColor     = Color3.FromHexString(part.material.emissive);
          m.emissiveIntensity = 1.5;
        }
        break;
    }

    this.matPool.set(key, m);
    return m;
  }

  getPosition(): { x: number; z: number } {
    return { x: this.x, z: this.z };
  }

  /** Current hull's longest half-extent (m). Used by the dock-range check: docking distance is measured
   *  from the ship CENTRE, so a long hull (brig 12 m vs pinnace 4 m) must be allowed to dock from farther
   *  out — its bow/stern can be alongside the pier while the centre is still well off it. */
  getHullReach(): number {
    return Math.max(this.rig.hullHalfLen, this.rig.hullHalfBeam);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('keyup',   this.keyUpHandler);
    if (this.repeatSwallow) { window.removeEventListener('keydown', this.repeatSwallow, true); }
    if (this.pointerObserver) {
      this.sceneService.scene?.onPointerObservable.remove(this.pointerObserver);
    }
    const canvas = this.sceneService.engine?.getRenderingCanvas();
    if (canvas && this.wheelHandler) {
      canvas.removeEventListener('wheel', this.wheelHandler as EventListener);
    }
    this.controller?.dispose();
    this.controller = null;
    for (const ps of [this.bowSpray, this.sternFoam, this.portFroth, this.stbdFroth]) {
      ps?.stop(); ps?.dispose();
    }
    this.wakeTex?.dispose();

    // Drain PBR pools before disposing the root so meshes don't try to
    // auto-dispose shared materials a second time via root.dispose(false, false).
    this.matPool.forEach(mat => mat.dispose());
    this.matPool.clear();
    this.texPool.forEach(tex => tex.dispose());
    this.texPool.clear();

    // Dispose all child meshes/lights; skip material auto-dispose (done above).
    this.root?.dispose(false, false);
  }
}
