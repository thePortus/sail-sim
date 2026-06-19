import { Injectable, inject } from '@angular/core';
import {
  Color3, Material, Matrix, Mesh, Observer, Quaternion, Scene, StandardMaterial, Texture, Vector3,
} from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { TerrainService } from './terrain.service';
import { VesselService } from './vessel.service';
import { MultiplayerService } from './multiplayer.service';
import { SfxService } from './sfx.service';
import { WeatherService } from './weather.service';
import { BirdFlapPlugin } from './scatter/props/bird-flap.plugin';
import { loadScatterGeometry, scatterTextureUrl } from './scatter/asset-loader';

/**
 * Coastal gulls — authored low-poly GLB variants (flying / gliding / perched), thin-instanced and
 * driven by a vertex-shader wing-flap (`BirdFlapPlugin`). Unlike the camera-following STATIC scatter
 * (rocks/palms), birds MOVE, so they live in their own service with a per-frame update that rewrites the
 * thin-instance matrices. Everything is organised into **flocks** — a moving centre with a handful of
 * member birds around it. A flock is either:
 *   - **RESTING** — a raft of perched gulls (bird_c) floating on the water, drifting slowly, or
 *   - **FLYING** — a loose group (bird_a/b) circling overhead.
 * Flocks only exist near land (gated by a coastal-proximity test) and recycle as the player sails: a
 * flock that drifts too far from the camera is despawned and a fresh one spawns in an unseen coastal
 * spot, so birds always populate the shoreline you're near without an unbounded world of them.
 *
 * This is Phase A (option 1): rafts + always-circling flocks, no take-off/landing transitions yet
 * (Phase B) and no ship/cannon startle (Phase C) — but the FlockState enum + spawn machinery are shaped
 * so those slot in without restructuring.
 */

/**
 * A flock cycles: RESTING (perched on the water) → TAKEOFF (climbing) → FLYING (circling) → LANDING
 * (descending) → RESTING again. The whole transition is driven by a single `lift` parameter (0 = on the
 * water, 1 = at cruising altitude): it blends the altitude, the formation (loose raft → travel-aligned
 * flock), the per-bird wing state (perched bird_c → flying bird_a/b), and how far the centre swings out
 * along its orbit. TAKEOFF/LANDING just ramp `lift` between 0 and 1; RESTING/FLYING hold it and dwell.
 */
type FlockState = 'RESTING' | 'TAKEOFF' | 'FLYING' | 'LANDING';

/** One bird within a flock: its raft offset, the variant it uses AIRBORNE (0 flyer / 1 glider — it shows
 *  the perched variant 2 whenever the flock is on the water), its look, its resting yaw, plus a little
 *  per-bird resting behaviour: it occasionally spreads its wings (showing the flying variant, which then
 *  flaps/glides via the shader) for a few seconds before folding them back. */
interface Member {
  ox: number; oz: number; oy: number; flyVariant: number; scale: number; tint: Color3; yaw: number;
  restWingsOut: boolean; restTimer: number;
  // B1 per-bird flight kinematics (used while airborne) — each gull integrates its OWN momentum-limited path
  // toward the flock goal instead of being a rigid offset from an analytic orbit centre.
  airborne: boolean;
  px: number; py: number; pz: number;            // world position
  hdg: number;                                   // travel heading (rad): velocity = (sin hdg, cos hdg)
  spd: number; vy: number;                       // airspeed (m/s) + vertical speed (m/s)
  bank: number;                                  // roll angle (rad), eased toward the turn
  radBias: number; altBias: number;              // personal wheel-radius / altitude bias for variety
  // B4 effort-driven wings: flapE 0..1 = how hard it's beating (from vertical speed), written to the instance
  // colour alpha; gliding = committed soar pose (dihedral mesh, wings near-still) with hysteresis vs flicker.
  flapE: number; gliding: boolean; glideTimer: number;
  // B5 landing: onFinal = within flare altitude on a landing approach (gear-down mesh); flare 0..1 = nose-up flare.
  onFinal: boolean; flare: number;
  // B7 surface dip: 0 none · 1 descend to the water · 2 skim · 3 climb back out. dipTimer/Cooldown pace it.
  dipState: number; dipTimer: number; dipCooldown: number;
}

interface Flock {
  state: FlockState;
  stateTimer: number;                            // seconds spent in the current state
  dwell: number;                                 // how long to hold RESTING / FLYING before transitioning
  cx: number; cz: number; cy: number;            // flock centroid proxy (despawn / startle / audio distance)
  anchorX: number; anchorZ: number;              // the takeoff/resting spot the wheel drifts around
  cruiseAlt: number;                             // target flying altitude (m)
  wanderR: number;                               // how far the goal roams from the anchor (m)
  gx: number; gy: number; gz: number;            // the GOAL point every bird steers toward (the wheel centre)
  goalAlt: number;                               // ramps SEA_Y↔cruiseAlt over takeoff/landing
  wTx: number; wTz: number; wanderTimer: number; // slow random-walk target the goal eases toward
  driftX: number; driftZ: number;                // RESTING: slow surface drift (m/s)
  nearShipDist: number;                          // nearest-ship distance last frame (−1 = re-initialise)
  // B6 ship-following: while `following`, the wheel anchor tracks a point behind a moving ship's stern.
  following: boolean; followTimer: number; followCooldown: number;
  members: Member[];
}

@Injectable({ providedIn: 'root' })
export class BirdService {
  private sceneService   = inject(SceneService);
  private oceanService   = inject(OceanService);
  private terrainService = inject(TerrainService);
  private vesselService  = inject(VesselService);
  private multiplayer    = inject(MultiplayerService);
  private sfx            = inject(SfxService);
  private weather        = inject(WeatherService);

  /** Birds tolerate fair weather + light drizzle; rain/storm drives them off (and silences their cries). */
  private birdsWelcome = true;

  // Procedural gull-cry audio (Web Audio, routed through the shared SFX master → respects the SFX slider).
  private audioCtx: AudioContext | null = null;
  private audioMaster: GainNode | null = null;
  private _ambientTimer = 1.5;          // countdown to the next relaxed ambient call
  private readonly AUDIBLE = 320;       // metres a cry carries (distance attenuation range)

  private enabled = false;
  private loaded = false;                 // base meshes successfully loaded
  private observer: Observer<Scene> | null = null;

  /** One hidden base mesh per variant (bird_a/b/c); thin-instanced across every flock of that variant. */
  private meshes: (Mesh | null)[] = [];
  private materials: Material[] = [];
  /** Per-variant thin-instance buffers (allocated once at MAX capacity; refilled each frame). */
  private matBufs: Float32Array[] = [];
  private colBufs: Float32Array[] = [];

  private flocks: Flock[] = [];
  private _flapTime = 0;

  // Reusable temporaries (no per-bird allocation in the update loop).
  private readonly _scaleV = new Vector3();
  private readonly _posV = new Vector3();
  private readonly _up = Vector3.UpReadOnly;
  private readonly _quat = new Quaternion();   // scratch — avoids a per-bird per-frame allocation
  private readonly _mat = new Matrix();

  // ── Asset config ─────────────────────────────────────────────────────────────
  private static readonly VARIANTS = [
    { file: 'bird_a.glb', ampScale: 1.0 },   // 0 flying, full flap
    { file: 'bird_b.glb', ampScale: 0.4 },   // 1 gliding/soaring (dihedral, gentle flap)
    { file: 'bird_c.glb', ampScale: 1.0 },   // 2 perched (geometry folds the wings → barely flaps)
    { file: 'bird_d.glb', ampScale: 0.5 },   // 3 landing-flare (gear down, tail fanned, braking flap)
  ];
  private static readonly TINTS: readonly Color3[] = [
    new Color3(1.00, 1.00, 1.00),   // white — herring/common gull
    new Color3(0.88, 0.90, 0.94),   // weathered grey
    new Color3(0.82, 0.74, 0.62),   // brown first-year
    new Color3(0.66, 0.70, 0.76),   // dark-backed
  ];
  private static readonly MAX_PER_VARIANT = 220;   // thin-instance buffer cap per variant mesh

  // ── Wildlife quality (driven by the graphics presets / settings "Wildlife" slider) ──
  // Each tier sets how many flocks live around the player and how fast fresh ones spawn in. Level 0 is
  // OFF (no birds). Ultra reaches the full 6 flocks. Mirrors ScatterService's quality system.
  private static readonly QUALITY = [
    { maxFlocks: 0, spawnInterval: 0   },   // 0 Off
    { maxFlocks: 2, spawnInterval: 2.5 },   // 1 Low
    { maxFlocks: 3, spawnInterval: 1.8 },   // 2 Medium
    { maxFlocks: 4, spawnInterval: 1.2 },   // 3 High
    { maxFlocks: 6, spawnInterval: 0.6 },   // 4 Ultra
  ] as const;
  private _quality = (() => {
    const q = parseInt(localStorage.getItem('ignis_wildlife_quality') ?? '3', 10);
    return Number.isFinite(q) ? Math.max(0, Math.min(4, q)) : 3;
  })();
  private maxFlocks = 4;                 // set from quality
  private spawnInterval = 1.2;           // seconds between spawn attempts (set from quality)
  private _spawnTimer = 0;

  // ── Tuning ───────────────────────────────────────────────────────────────────
  private readonly SPAWN_MIN = 60;      // new flocks appear at least this far from camera (offscreen-ish)
  private readonly SPAWN_MAX = 160;     // …and at most this far — kept close so flocks read clearly
  private readonly DESPAWN = 240;       // recycle a flock past this (distant flocks are barely visible →
                                        //   not worth simulating/drawing); must exceed SPAWN_MAX + orbitR
  private readonly LAND_PROXIMITY = 250;  // birds allowed only where land is within this (m) — "near land"
  private readonly SEA_Y = 0.25;        // resting gulls float just above the waterline
  private readonly GROUND_CLEARANCE = 9; // min metres an airborne bird stays above the land beneath it
  private readonly TAKEOFF_TIME = 2.6;  // seconds to climb from water to cruise
  private readonly LAND_TIME = 3.4;     // seconds to descend back to the water (gentler than takeoff)
  // Startle: a resting raft flushes when a ship APPROACHES within STARTLE_RADIUS (closing distance — a
  // ship merely parked nearby is tolerated, so gulls happily settle beside an idle boat), OR when any
  // ship comes within IMMINENT_RADIUS (driving right onto them), OR a cannon fires within CANNON_RADIUS.
  private readonly STARTLE_RADIUS = 65;
  private readonly IMMINENT_RADIUS = 26;
  private readonly CANNON_RADIUS = 130;
  private readonly _shipXZ: number[] = [];   // scratch: flattened [x,z,x,z,…] ship positions this frame

  // ── B1 flight dynamics (per-bird momentum-limited steering) ──────────────────
  private readonly CRUISE_SPD = 8.5;    // m/s typical gull cruise
  private readonly MIN_SPD    = 5.5;    // stall floor while airborne
  private readonly ACCEL      = 5.0;    // m/s² airspeed change (momentum)
  private readonly TURN_RATE  = 0.85;   // rad/s max yaw rate → min turn radius ≈ spd/TURN ≈ 10 m (a real wheel)
  private readonly MAX_BANK   = 0.62;   // rad (~36°) roll into a hard turn
  private readonly BANK_EASE  = 3.0;    // how fast the roll catches up to the turn
  private readonly CLIMB_RATE = 2.8;    // m/s max vertical speed
  private readonly VACCEL     = 3.5;    // m/s² vertical-speed change
  private readonly PITCH_GAIN = 1.0;    // nose pitch from climb angle
  // B2 boids: each bird blends goal-seek with separation / alignment / cohesion over its airborne flockmates.
  private readonly NEIGH_R = 12;        // m — alignment + cohesion neighbourhood
  private readonly SEP_R   = 4.5;       // m — personal space (separation kicks in inside this)
  private readonly W_GOAL  = 0.85;      // pull toward the wheel centre (keeps the flock together near the anchor)
  private readonly W_ALI   = 0.5;       // match neighbours' heading (coherent wheeling)
  private readonly W_COH   = 0.35;      // toward the local cluster centroid
  private readonly W_SEP   = 1.7;       // push off close neighbours (no clipping/stacking)
  private readonly VSEP    = 1.3;       // vertical separation gain (spread out altitude when stacked)
  // B5 landing approach
  private readonly FLARE_ALT   = 7;     // m — below this on a landing, the gull goes gear-down + flares
  private readonly LAND_SPD    = 4.5;   // m/s — bleeds airspeed off on final approach
  private readonly FLARE_PITCH = 0.55;  // rad nose-up at full flare (braking, feet forward to the water)
  // B6 ship-following (gulls trail a moving boat for scraps, then peel off when it stops)
  private readonly FOLLOW_TRIGGER = 75;  // m — a flying flock this close to a MOVING ship adopts it
  private readonly FOLLOW_DROP    = 150; // m — peel off if the ship pulls this far away
  private readonly FOLLOW_TRAIL   = 22;  // m — wheel centre sits this far behind the stern
  private readonly FOLLOW_ALT     = 14;  // m — lower wheel, just above the rig, riding the wake
  private readonly FOLLOW_WANDER  = 14;  // m — tighter wheel while trailing
  private readonly FOLLOW_MIN_SPD = 1.0; // units/s — below this (or anchored) the ship counts as stopped
  // B7 surface-dip feeding (an individual gull swoops to the surface to snatch, then climbs back out)
  private readonly DIP_SKIM_H      = 0.8;   // m above the water it levels off to skim
  private readonly DIP_RATE        = 0.015; // per-second chance a cruising gull starts a dip
  private readonly DIP_RATE_FOLLOW = 0.07;  // …much higher while trailing a ship's wake (scraps)
  private readonly DIP_DIVE_RATE   = 6.5;   // m/s — a dip dives faster than the normal climb limit (a real swoop)
  // scratch (no per-bird allocation): orientation = yaw(Y) ∘ pitch(Z) ∘ roll(X) for the model (nose −X, span ±Z)
  private readonly _qP = new Quaternion();
  private readonly _qR = new Quaternion();
  private readonly _axX = new Vector3(1, 0, 0);
  private readonly _axZ = new Vector3(0, 0, 1);

  /** Current wildlife level (0 Off … 4 Ultra) — for the settings slider. */
  getWildlifeQuality(): number { return this._quality; }

  /** Set the wildlife level (0 Off … 4 Ultra): adjusts flock count + spawn rate live. Persisted. */
  setWildlifeQuality(level: number): void {
    const q = Math.max(0, Math.min(4, Math.round(level)));
    this._quality = q;
    localStorage.setItem('ignis_wildlife_quality', String(q));
    this.applyWildlifeParams(q);
    if (!this.enabled) { this.clearFlocks(); }   // turned off → clear the sky immediately
  }

  /** Apply a wildlife tier's flock cap + spawn cadence (birds only run once the meshes have loaded). */
  private applyWildlifeParams(q: number): void {
    const t = BirdService.QUALITY[Math.max(0, Math.min(4, q))];
    this.maxFlocks = t.maxFlocks;
    this.spawnInterval = t.spawnInterval;
    this.enabled = this.loaded && t.maxFlocks > 0;
  }

  /** Drop every live flock and clear the thin-instance buffers (e.g. wildlife turned off). */
  private clearFlocks(): void {
    this.flocks = [];
    for (const mesh of this.meshes) { if (mesh) { mesh.thinInstanceCount = 0; } }
  }

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    const cam = this.sceneService.camera;
    if (!scene || !cam) { return; }

    // One shared atlas texture; one matte StandardMaterial per variant (so each can carry its own flap
    // ampScale). StandardMaterial — NOT PBR — because with the Atmosphere addon active every PBR fragment
    // does physical-sky + sun lighting; far too costly for hundreds of small, double-sided bird cards.
    const atlas = new Texture(scatterTextureUrl('bird_atlas.png'), scene);
    for (let v = 0; v < BirdService.VARIANTS.length; v++) {
      const cfg = BirdService.VARIANTS[v];
      const mat = new StandardMaterial(`scatter_bird_${v}_mat`, scene);
      mat.diffuseTexture = atlas;
      mat.specularColor = new Color3(0, 0, 0);          // matte feathers (no shiny highlight)
      mat.emissiveColor = new Color3(0.16, 0.17, 0.19); // lift the shaded undersides off pure black
      mat.backFaceCulling = false;     // thin wing cards
      mat.twoSidedLighting = true;     // shade wing undersides (no black backs)
      new BirdFlapPlugin(mat, { ampScale: cfg.ampScale });
      this.sceneService.excludeFromPrePass(mat);
      this.materials[v] = mat;

      // useVertexColors=false: COLOR_0 is flap data, not albedo.
      const mesh = await loadScatterGeometry(scene, cfg.file, `scatter_bird_${v}`, mat, false);
      // A missing variant is non-fatal: leave meshes[v] null and carry on (writeBird falls back to the flyer).
      // So an undeployed bird_d (landing) only loses the gear-down pose — it can't disable the whole flock.
      if (!mesh) { console.warn(`[birds] variant ${v} (${cfg.file}) failed to load — falling back`); continue; }
      this.sceneService.excludeFromGlow(mesh);
      // loadScatterGeometry hides the base mesh (it's built for the patch system, which clones a visible
      // copy per patch). We thin-instance the base mesh directly, so it MUST be visible to render.
      mesh.isVisible = true;
      mesh.alwaysSelectAsActiveMesh = true;   // birds roam far from origin — don't let origin-box culling drop them
      // The world layers depth by rendering group (depth is cleared between groups). The boat, near ocean
      // and remote ships are group 2; birds must share that group or the boat paints over gulls flying
      // between it and the camera. Group 2 shares one depth buffer, so they sort against each other.
      mesh.renderingGroupId = 2;
      this.matBufs[v] = new Float32Array(BirdService.MAX_PER_VARIANT * 16);
      this.colBufs[v] = new Float32Array(BirdService.MAX_PER_VARIANT * 4);
      mesh.thinInstanceSetBuffer('matrix', this.matBufs[v], 16, false);
      mesh.thinInstanceSetBuffer('color', this.colBufs[v], 4, false);
      mesh.thinInstanceCount = 0;
      // Reflect the gulls on the water (MirrorTexture renders the base mesh + all its thin instances).
      // Birds are excluded from the seabed refraction RTT by the scatter_ name prefix, so this only
      // adds them to the surface reflection.
      this.oceanService.addToRenderList(mesh);
      this.meshes[v] = mesh;
    }
    if (!this.meshes[0]) { console.warn('[birds] flyer mesh (bird_a) failed — birds disabled'); return; }

    this.loaded = true;
    this.applyWildlifeParams(this._quality);   // enables only if the level is > 0

    this.observer = scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);   // clamp huge hitches
      this._flapTime += dt;
      BirdFlapPlugin.FLAP.time = this._flapTime;
      this.update(dt);
    });
  }

  // ── Per-frame simulation ───────────────────────────────────────────────────────

  private update(dt: number): void {
    if (!this.enabled) { return; }
    const cam = this.sceneService.camera;
    if (!cam) { return; }
    const camX = cam.position.x, camZ = cam.position.z;

    // Weather gate: gulls flee rain & storms (the heavier it blows, the faster they go). While they're
    // unwelcome we stop spawning AND drive the existing flocks off, so the sky empties out before/during
    // the squall and refills once it clears.
    const storm = this.storminess();
    this.birdsWelcome = storm < 0.35;

    // Recycle flocks that have drifted out of range.
    for (let i = this.flocks.length - 1; i >= 0; i--) {
      const f = this.flocks[i];
      if (Math.hypot(f.cx - camX, f.cz - camZ) > this.DESPAWN) { this.flocks.splice(i, 1); }
    }

    if (this.birdsWelcome) {
      // Top up toward maxFlocks at the wildlife tier's spawn RATE: at most one new flock per spawnInterval
      // seconds, so flocks fade into the coastline gradually instead of all popping in at once.
      this._spawnTimer += dt;
      if (this.flocks.length < this.maxFlocks && this._spawnTimer >= this.spawnInterval) {
        this._spawnTimer = 0;
        const spot = this.findCoastalSpot(camX, camZ);
        if (spot) { this.flocks.push(this.makeFlock(spot.x, spot.z)); }
      }
    } else {
      // Bad weather: send every flock away. They take off (silently) and their orbit anchor drifts off
      // from the camera, so they recede out of DESPAWN range and vanish — and aren't replaced.
      const departSpeed = 4 + storm * 8;   // m/s; faster in heavier weather
      for (const f of this.flocks) { this.departFlock(f, dt, departSpeed, camX, camZ); }
    }

    // Collect every ship position once (local + remote) for the startle checks.
    const ships = this.gatherShips();
    // The player's boat as a follow target (gulls trail it for scraps) — only while the weather's fair.
    const follow = this.birdsWelcome ? this.playerFollowTarget() : null;

    // Advance each flock, then write its members into the per-variant thin-instance buffers.
    const counts = new Array(this.meshes.length).fill(0);
    for (const f of this.flocks) {
      this.updateFollow(f, dt, follow);
      this.advanceFlock(f, dt);
      if (f.state === 'RESTING') { this.checkShipStartle(f, ships); }
      if (f.state === 'RESTING') { this.updateRestPoses(f, dt); }
      for (const m of f.members) { this.writeBird(f, m, counts); }
    }
    for (let v = 0; v < this.meshes.length; v++) {
      const mesh = this.meshes[v];
      if (!mesh) { continue; }
      mesh.thinInstanceCount = counts[v];
      if (counts[v] > 0) {
        mesh.thinInstanceBufferUpdated('matrix');
        mesh.thinInstanceBufferUpdated('color');
      }
    }

    this.updateAmbientCalls(dt);
  }

  /** Advance the flock's state machine + centre. RESTING drifts on the water; TAKEOFF/LANDING ramp the
   *  `lift`; FLYING/TAKEOFF/LANDING all orbit the anchor (swung out by `lift`, so they spiral up off the
   *  takeoff spot and back down onto it). */
  private advanceFlock(f: Flock, dt: number): void {
    f.stateTimer += dt;
    const climb = (f.cruiseAlt - this.SEA_Y);
    switch (f.state) {
      case 'RESTING':
        // Drift slowly across the surface (anchor follows the raft so it lifts off from where it sits).
        f.cx += f.driftX * dt; f.cz += f.driftZ * dt;
        f.anchorX = f.cx; f.anchorZ = f.cz; f.cy = this.SEA_Y; f.goalAlt = this.SEA_Y;
        if (f.stateTimer >= f.dwell) { this.beginTakeoff(f); }
        break;
      case 'TAKEOFF':
        f.goalAlt = Math.min(f.cruiseAlt, f.goalAlt + climb / this.TAKEOFF_TIME * dt);
        this.updateGoal(f, dt); this.flyMembers(f, dt, false);
        if (f.goalAlt >= f.cruiseAlt - 0.5) { f.state = 'FLYING'; f.stateTimer = 0; f.dwell = 14 + Math.random() * 18; }
        break;
      case 'FLYING':
        f.goalAlt = f.cruiseAlt;
        this.updateGoal(f, dt); this.flyMembers(f, dt, false);
        if (f.stateTimer >= f.dwell && !f.following) { f.state = 'LANDING'; f.stateTimer = 0; f.wanderTimer = 1e9; }
        break;
      case 'LANDING':
        // Goal converges on the anchor and sinks to the water; birds spiral down + settle individually (no snap).
        f.wTx = f.anchorX; f.wTz = f.anchorZ;
        f.goalAlt = Math.max(this.SEA_Y, f.goalAlt - climb / this.LAND_TIME * dt);
        this.updateGoal(f, dt); this.flyMembers(f, dt, true);
        if (!f.members.some((m) => m.airborne)) {
          // All down: resume drifting from where they settled. Re-init the approach detector (−1) so a ship
          // merely parked nearby doesn't immediately re-flush a raft that deliberately landed beside it.
          f.state = 'RESTING'; f.stateTimer = 0; f.dwell = 9 + Math.random() * 14;
          f.cx = f.anchorX; f.cz = f.anchorZ; f.nearShipDist = -1;
        }
        break;
    }
  }

  /** Idle behaviour for a resting raft: each gull occasionally spreads its wings (flying variant → it
   *  flaps/glides via the shader) for a few seconds, then folds them back and sits a while. Staggered
   *  per bird, so a raft is mostly folded with the odd one stretching or flapping — never all identical. */
  private updateRestPoses(f: Flock, dt: number): void {
    for (const m of f.members) {
      m.restTimer -= dt;
      if (m.restTimer > 0) { continue; }
      if (m.restWingsOut) {
        m.restWingsOut = false;                 // fold back and settle for a good while
        m.restTimer = 6 + Math.random() * 16;
      } else if (Math.random() < 0.5) {
        m.restWingsOut = true;                  // spread/flap for a few seconds
        m.restTimer = 1.5 + Math.random() * 4;
      } else {
        m.restTimer = 4 + Math.random() * 10;   // keep sitting folded
      }
    }
  }

  // ── Weather departure ───────────────────────────────────────────────────────────

  /** 0 (fair / light drizzle) → 1 (heavy storm). Rain & storms drive the gulls off; gales add to it. */
  private storminess(): number {
    const w = this.weather.weather();
    if (!w) { return 0; }
    const p = w.precipitation;
    const wet = p === 'storm' ? 1 : p === 'rain' ? 0.7 : p === 'drizzle' ? 0.2 : 0;
    const gale = Math.max(0, ((w.wind?.speed ?? 0) - 20) / 8);
    return Math.min(1, Math.max(wet, gale));
  }

  /** Send a flock away: resting rafts take off (silently), then the orbit anchor drifts off from the
   *  camera so the whole flock recedes out of range and is recycled — and not replaced while it's stormy. */
  private departFlock(f: Flock, dt: number, speed: number, camX: number, camZ: number): void {
    if (f.state === 'RESTING') { this.beginTakeoff(f); }
    let ax = f.anchorX - camX, az = f.anchorZ - camZ;
    const d = Math.hypot(ax, az) || 1;
    f.anchorX += (ax / d) * speed * dt;
    f.anchorZ += (az / d) * speed * dt;
    f.cruiseAlt = Math.min(70, f.cruiseAlt + dt * 4);   // climb a little as they head off
  }

  // ── Startle (ship approach + cannon fire) ───────────────────────────────────────

  /** Flatten every ship position (local player + remote vessels) into the scratch [x,z,…] array. */
  private gatherShips(): number[] {
    const out = this._shipXZ;
    out.length = 0;
    const me = this.vesselService.state();
    if (me) { out.push(me.x, me.z); }
    for (const r of this.multiplayer.getVesselWakeSources()) { out.push(r.x, r.z); }
    return out;
  }

  // ── Ship-following (B6) ──────────────────────────────────────────────────────────

  /** The player's boat as a follow target while it's UNDERWAY (gulls trail a moving ship, not a parked one). */
  private playerFollowTarget(): { x: number; z: number; hr: number } | null {
    const s = this.vesselService.state();
    if (!s || s.anchored || Math.abs(s.speed) < this.FOLLOW_MIN_SPD) { return null; }
    return { x: s.x, z: s.z, hr: s.heading * Math.PI / 180 };   // heading 0=N=+Z, 90=E=+X → forward (sin,cos)
  }

  /** Make a flying flock TRAIL a moving ship: its wheel anchor rides a point behind the stern, so the gulls
   *  wheel over the wake and chase the boat. They peel off (back to coastal wandering → land) when it stops,
   *  outruns them, or after a while — then sit out a cooldown so they don't instantly re-glom on. */
  private updateFollow(f: Flock, dt: number, ship: { x: number; z: number; hr: number } | null): void {
    if (f.following) {
      f.followTimer -= dt;
      const dShip = ship ? Math.hypot(ship.x - f.cx, ship.z - f.cz) : Infinity;
      if (!ship || dShip > this.FOLLOW_DROP || f.followTimer <= 0) {
        f.following = false;
        f.followCooldown = 8 + Math.random() * 10;
        f.anchorX = f.gx; f.anchorZ = f.gz;                  // resume wheeling where they are
        f.wanderR = 16 + Math.random() * 26;
        if (f.state === 'FLYING') { f.dwell = Math.min(f.dwell, f.stateTimer + 6 + Math.random() * 6); }  // then drift down and land
        return;
      }
      // Track a point behind the stern + ride lower over the wake.
      f.anchorX = ship.x - Math.sin(ship.hr) * this.FOLLOW_TRAIL;
      f.anchorZ = ship.z - Math.cos(ship.hr) * this.FOLLOW_TRAIL;
      f.cruiseAlt = this.FOLLOW_ALT; f.wanderR = this.FOLLOW_WANDER;
    } else {
      if (f.followCooldown > 0) { f.followCooldown -= dt; }
      // A flying flock close to the moving ship adopts it.
      if (f.state === 'FLYING' && f.followCooldown <= 0 && ship
          && Math.hypot(ship.x - f.cx, ship.z - f.cz) < this.FOLLOW_TRIGGER) {
        f.following = true;
        f.followTimer = 18 + Math.random() * 22;
        f.cruiseAlt = this.FOLLOW_ALT; f.wanderR = this.FOLLOW_WANDER;
      }
    }
  }

  /** Flush a resting raft when a ship APPROACHES (distance closing) within STARTLE_RADIUS, or any ship is
   *  within IMMINENT_RADIUS. A ship merely sitting nearby doesn't qualify (no closing), so gulls tolerate
   *  an idle boat — but one bearing down on them takes off. */
  private checkShipStartle(f: Flock, ships: number[]): void {
    let minD = Infinity;
    for (let i = 0; i < ships.length; i += 2) {
      const d = Math.hypot(ships[i] - f.cx, ships[i + 1] - f.cz);
      if (d < minD) { minD = d; }
    }
    if (f.nearShipDist < 0) { f.nearShipDist = minD; return; }   // freshly settled/spawned: just sample
    const closing = minD < f.nearShipDist - 0.3;                 // distance shrinking (ship coming at them)
    f.nearShipDist = minD;
    if (minD < this.IMMINENT_RADIUS || (closing && minD < this.STARTLE_RADIUS)) {
      this.beginTakeoff(f);
      if (this.birdsWelcome) { this.cryBurst(f); }   // no alarm calls once they're fleeing the weather
    }
  }

  /** Public startle: flush every resting raft within `radius` of (x,z) — e.g. a cannon going off. */
  startleAt(x: number, z: number, radius = this.CANNON_RADIUS): void {
    if (!this.enabled) { return; }
    const r2 = radius * radius;
    for (const f of this.flocks) {
      if (f.state !== 'RESTING') { continue; }
      const dx = f.cx - x, dz = f.cz - z;
      if (dx * dx + dz * dz <= r2) { this.beginTakeoff(f); if (this.birdsWelcome) { this.cryBurst(f); } }
    }
  }

  // ── Gull-cry audio ───────────────────────────────────────────────────────────

  /** Lazily create the audio context + SFX-master routing (on first cry, after the user gesture). */
  private ensureAudio(): boolean {
    if (this.audioCtx) { return true; }
    try {
      this.audioCtx = this.sfx.getSharedAudioContext();   // shared SFX context (own master below)
      this.audioMaster = this.sfx.createMaster(this.audioCtx);
      if (this.audioCtx.state === 'suspended') { void this.audioCtx.resume(); }
      return true;
    } catch { this.audioCtx = null; return false; }
  }

  /** Distance falloff for a cry heard from the camera (0 beyond AUDIBLE, → 1 up close). */
  private gainForDistance(d: number): number {
    if (d >= this.AUDIBLE) { return 0; }
    const t = 1 - d / this.AUDIBLE;
    return t * t;
  }

  /** Play one synthesized gull cry at a world position: a reedy band-passed sawtooth with a rising→falling
   *  pitch contour and a fast tremolo "laugh", attenuated + panned by the camera. */
  private playCry(wx: number, wy: number, wz: number, level: number, pitch: number, delay = 0): void {
    if (!this.ensureAudio()) { return; }
    const cam = this.sceneService.camera;
    if (!cam) { return; }
    const ctx = this.audioCtx!, master = this.audioMaster!;
    const d = Math.hypot(cam.position.x - wx, cam.position.y - wy, cam.position.z - wz);
    const gain = this.gainForDistance(d) * level;
    if (gain < 0.012) { return; }                       // inaudible → don't build nodes

    // Pan by the source's left/right position in camera (view) space.
    const view = cam.getViewMatrix();
    const vx = wx * view.m[0] + wy * view.m[4] + wz * view.m[8]  + view.m[12];
    const vz = wx * view.m[2] + wy * view.m[6] + wz * view.m[10] + view.m[14];
    const pan = Math.max(-1, Math.min(1, vx / Math.max(8, Math.abs(vz))));

    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(pitch * 0.95, t0);
    osc.frequency.linearRampToValueAtTime(pitch * 1.22, t0 + 0.07);
    osc.frequency.linearRampToValueAtTime(pitch * 0.80, t0 + 0.34);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = pitch * 1.8; bp.Q.value = 3.5;

    const trem = ctx.createGain(); trem.gain.value = 0.7;
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 12 + Math.random() * 7;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.3;
    lfo.connect(lfoDepth).connect(trem.gain);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.02);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0008, gain * 0.5), t0 + 0.18);
    env.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.42);

    const panner = ctx.createStereoPanner(); panner.pan.value = pan;
    osc.connect(bp).connect(trem).connect(env).connect(panner).connect(master);
    osc.start(t0); lfo.start(t0);
    osc.stop(t0 + 0.48); lfo.stop(t0 + 0.48);
  }

  /** A flurry of cries from a startled raft — numerous gulls at varied pitches + small time offsets. */
  private cryBurst(f: Flock): void {
    const n = 5 + Math.floor(Math.random() * 8);        // 5–12 cries
    for (let i = 0; i < n; i++) {
      const jx = f.cx + (Math.random() - 0.5) * 22;
      const jz = f.cz + (Math.random() - 0.5) * 22;
      const pitch = 760 + Math.random() * 620;          // varied pitches
      this.playCry(jx, 1.5, jz, 0.5 + Math.random() * 0.4, pitch, Math.random() * 1.3);
    }
  }

  /** Occasional relaxed call from the flock nearest the CAMERA (covers the zoomed-out, ship-far case). */
  private updateAmbientCalls(dt: number): void {
    const cam = this.sceneService.camera;
    if (!cam || this.flocks.length === 0 || !this.birdsWelcome) { return; }   // silent once they're leaving
    this._ambientTimer -= dt;
    if (this._ambientTimer > 0) { return; }
    this._ambientTimer = 2.5 + Math.random() * 5;       // next relaxed call in a few seconds

    // Nearest flock to the camera.
    let best: Flock | null = null, bestD = Infinity;
    for (const f of this.flocks) {
      const d = Math.hypot(cam.position.x - f.cx, cam.position.z - f.cz);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!best || bestD > this.AUDIBLE * 0.85) { return; }
    const calls = Math.random() < 0.3 ? 2 : 1;          // usually a lone call, sometimes a pair
    for (let i = 0; i < calls; i++) {
      const jx = best.cx + (Math.random() - 0.5) * 18;
      const jz = best.cz + (Math.random() - 0.5) * 18;
      this.playCry(jx, best.cy + 1, jz, 0.28 + Math.random() * 0.22, 780 + Math.random() * 560, i * 0.35);
    }
  }

  /** Kick a resting raft into the air (also the Phase-C startle entry point). */
  private beginTakeoff(f: Flock): void {
    f.state = 'TAKEOFF';
    f.stateTimer = 0;
    f.anchorX = f.cx; f.anchorZ = f.cz;
    f.gx = f.cx; f.gz = f.cz; f.goalAlt = this.SEA_Y;
    f.wTx = f.cx; f.wTz = f.cz; f.wanderTimer = 0;
    // Seed each gull's kinematic state at its raft position, fanning outward off the water with a hard first beat.
    for (const m of f.members) {
      m.airborne = true;
      m.px = f.cx + m.ox; m.py = this.SEA_Y; m.pz = f.cz + m.oz;
      m.hdg = Math.atan2(m.px - f.cx, m.pz - f.cz) + (Math.random() - 0.5) * 0.6;
      m.spd = this.MIN_SPD; m.vy = this.CLIMB_RATE * 0.7; m.bank = 0;
    }
  }

  /** Seed a flock that SPAWNS already airborne (no takeoff): scatter the gulls around the goal at cruise. */
  private seedAirborne(f: Flock): void {
    for (const m of f.members) {
      m.airborne = true;
      m.px = f.gx + m.ox; m.py = f.cruiseAlt + m.altBias * 0.5; m.pz = f.gz + m.oz;
      m.hdg = Math.random() * Math.PI * 2; m.spd = this.CRUISE_SPD; m.vy = 0; m.bank = 0;
    }
  }

  /** Slowly roam the flock GOAL (the wheel centre) around the anchor — a smoothed random walk. The birds steer
   *  toward it with momentum + turn limits, so a flock no longer snaps around a perfect circle. */
  private updateGoal(f: Flock, dt: number): void {
    if ((f.wanderTimer -= dt) <= 0) {
      const ang = Math.random() * Math.PI * 2, r = f.wanderR * (0.3 + Math.random() * 0.7);
      f.wTx = f.anchorX + Math.cos(ang) * r; f.wTz = f.anchorZ + Math.sin(ang) * r;
      f.wanderTimer = 4 + Math.random() * 5;
    }
    const k = Math.min(1, dt * 0.3);
    f.gx += (f.wTx - f.gx) * k; f.gz += (f.wTz - f.gz) * k; f.gy = f.goalAlt;
    f.cx = f.gx; f.cz = f.gz; f.cy = f.goalAlt;   // centroid proxy for despawn / startle / audio distance
  }

  /** Integrate every airborne member's momentum-limited flight one tick. On a landing, birds on FINAL approach
   *  (below the flare altitude) drop their gear, bleed airspeed, flare nose-up, and settle individually as each
   *  touches the water — a staggered approach, never a synchronized snap. */
  private flyMembers(f: Flock, dt: number, landing: boolean): void {
    for (const m of f.members) {
      if (!m.airborne) { continue; }
      if (landing) { m.dipState = 0; } else { this.updateDip(f, m, dt); }   // no feeding dips on a landing approach
      this.steerBird(f, m, dt);
      const onFinal = landing && m.py < this.FLARE_ALT;
      m.onFinal = onFinal;
      if (onFinal) {
        // Bleed airspeed toward landing speed (decelerate only — momentum, never an instant stop).
        if (m.spd > this.LAND_SPD) { m.spd = Math.max(this.LAND_SPD, m.spd - this.ACCEL * 2 * dt); }
        // Flare: ease the nose-up bias in as it nears the water.
        const f01 = Math.max(0, Math.min(1, 1 - (m.py - this.SEA_Y) / (this.FLARE_ALT - this.SEA_Y)));
        m.flare += (f01 - m.flare) * Math.min(1, dt * 4);
        if (m.py <= this.SEA_Y + 0.8 && m.vy <= 0.3) { this.settleMember(f, m); }
      } else if (m.flare > 0.001) {
        m.flare += (0 - m.flare) * Math.min(1, dt * 3);   // ease the flare back out if it climbs away
      }
    }
  }

  /** One bird's momentum-limited steering toward the flock goal: turn-rate-limited heading, eased airspeed,
   *  limited climb, and a roll banked into the turn. This is the heart of the lifelike motion (B1). */
  private steerBird(f: Flock, m: Member, dt: number): void {
    // ── B2 boids: blend goal-seek with separation / alignment / cohesion over airborne flockmates ──
    const NEIGH2 = this.NEIGH_R * this.NEIGH_R, SEP2 = this.SEP_R * this.SEP_R;
    let sepX = 0, sepZ = 0, sepY = 0, aliX = 0, aliZ = 0, cohX = 0, cohZ = 0, cohN = 0;
    for (const o of f.members) {
      if (o === m || !o.airborne) { continue; }
      const ddx = m.px - o.px, ddz = m.pz - o.pz;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 > NEIGH2) { continue; }
      aliX += Math.sin(o.hdg); aliZ += Math.cos(o.hdg);        // alignment: neighbours' heading
      cohX += o.px; cohZ += o.pz; cohN++;                       // cohesion: local centroid
      if (d2 < SEP2) {                                          // separation: push off close neighbours
        const d = Math.sqrt(d2) || 1e-3, w = 1 - d / this.SEP_R;
        sepX += (ddx / d) * w; sepZ += (ddz / d) * w;
        const ddy = m.py - o.py;
        if (Math.abs(ddy) < 2.5) { sepY += (ddy >= 0 ? 1 : -1) * (1 - Math.abs(ddy) / 2.5) * w; }
      }
    }
    // Goal-seek toward the wheel centre (normalised), then add the three boids urges.
    let dirX = f.gx - m.px, dirZ = f.gz - m.pz;
    const gl = Math.hypot(dirX, dirZ) || 1;
    dirX = (dirX / gl) * this.W_GOAL; dirZ = (dirZ / gl) * this.W_GOAL;
    if (cohN > 0) {
      const al = Math.hypot(aliX, aliZ) || 1;
      dirX += (aliX / al) * this.W_ALI; dirZ += (aliZ / al) * this.W_ALI;
      let cx = cohX / cohN - m.px, cz = cohZ / cohN - m.pz; const cl = Math.hypot(cx, cz) || 1;
      dirX += (cx / cl) * this.W_COH; dirZ += (cz / cl) * this.W_COH;
    }
    dirX += sepX * this.W_SEP; dirZ += sepZ * this.W_SEP;       // separation already proximity-weighted
    // Surface dip (B7): while descending/skimming, aim just above the water; climbing-out (3) or none → flock alt.
    const ty = (m.dipState === 1 || m.dipState === 2) ? this.SEA_Y + this.DIP_SKIM_H : f.gy + m.altBias * 0.5;
    const desired = Math.atan2(dirX, dirZ);                     // hdg convention: velocity = (sin hdg, cos hdg)
    let dh = (desired - m.hdg) % (Math.PI * 2);
    if (dh > Math.PI) { dh -= Math.PI * 2; } else if (dh < -Math.PI) { dh += Math.PI * 2; }
    const maxTurn = this.TURN_RATE * dt;
    const turn = Math.max(-maxTurn, Math.min(maxTurn, dh));
    m.hdg += turn;
    const yawRate = dt > 1e-4 ? turn / dt : 0;
    // Airspeed eases toward cruise (a touch slower when climbing hard) — momentum, never an instant start/stop.
    const targetSpd = (ty - m.py) > 1.5 ? this.CRUISE_SPD * 0.85 : this.CRUISE_SPD;
    m.spd += Math.max(-this.ACCEL * dt, Math.min(this.ACCEL * dt, targetSpd - m.spd));
    if (m.spd < this.MIN_SPD) { m.spd = this.MIN_SPD; }
    m.px += Math.sin(m.hdg) * m.spd * dt;
    m.pz += Math.cos(m.hdg) * m.spd * dt;
    // Limited climb/descent toward the target altitude, plus vertical separation so birds don't stack.
    // A surface dip (descend, state 1) is allowed to plunge faster than the normal climb limit — a real swoop.
    const diveMax = m.dipState === 1 ? this.DIP_DIVE_RATE : this.CLIMB_RATE;
    const targetVy = Math.max(-diveMax, Math.min(this.CLIMB_RATE, (ty - m.py) * 0.8 + sepY * this.VSEP));
    m.vy += Math.max(-this.VACCEL * dt, Math.min(this.VACCEL * dt, targetVy - m.vy));
    m.py += m.vy * dt;
    // Stay clear of land beneath (headlands/hills under the wheel push the bird up; water ≈ 0 → untouched).
    const ground = this.terrainService.getElevation(m.px, m.pz);
    if (ground > 0.5) { const floor = ground + this.GROUND_CLEARANCE; if (m.py < floor) { m.py = floor; if (m.vy < 0) { m.vy = 0; } } }
    // Bank into the turn (roll ∝ how hard it's yawing), eased so it rolls in/out smoothly.
    const targetBank = Math.max(-this.MAX_BANK, Math.min(this.MAX_BANK, (yawRate / this.TURN_RATE) * this.MAX_BANK));
    m.bank += (targetBank - m.bank) * Math.min(1, dt * this.BANK_EASE);

    // ── B4 effort → wings: flap energy from vertical speed (climb → hard beat, level → moderate, descent → glide).
    const eTarget = Math.max(0.08, Math.min(1, 0.5 + m.vy * 0.18));
    m.flapE += (eTarget - m.flapE) * Math.min(1, dt * 2.5);   // smooth so it doesn't strobe with the wave-driven vy
    // Committed soar pose (dihedral mesh, wings near-still): switch only after the descent/climb holds, so a bird
    // hovering around the threshold doesn't flicker meshes.
    const wantGlide = m.vy < -0.8;
    if (wantGlide !== m.gliding) {
      if ((m.glideTimer -= dt) <= 0) { m.gliding = wantGlide; m.glideTimer = 1.5 + Math.random() * 1.5; }
    } else { m.glideTimer = 1.5 + Math.random() * 1.5; }
  }

  /** A bird touches down: stop flying, anchor its raft offset where it landed, face its travel heading. */
  private settleMember(f: Flock, m: Member): void {
    m.airborne = false;
    m.py = this.SEA_Y;
    m.ox = m.px - f.anchorX; m.oz = m.pz - f.anchorZ;
    m.yaw = Math.atan2(Math.cos(m.hdg), -Math.sin(m.hdg));   // keep facing the way it came in
    m.bank = 0; m.vy = 0; m.onFinal = false; m.flare = 0; m.dipState = 0;
    m.restWingsOut = false; m.restTimer = 2 + Math.random() * 6;
  }

  /** Surface-dip feeding (B7): a cruising gull occasionally swoops to the water — plunge (wings set, gliding via
   *  B4), skim/snatch, then climb back out (flapping HARD, again via B4). Far more frequent while trailing a
   *  ship's wake. The dip just overrides the bird's target altitude in steerBird; the rest is the normal flight. */
  private updateDip(f: Flock, m: Member, dt: number): void {
    if (m.dipState === 0) {
      if (m.dipCooldown > 0) { m.dipCooldown -= dt; return; }
      const rate = f.following ? this.DIP_RATE_FOLLOW : this.DIP_RATE;
      if (m.py > this.FLARE_ALT + 3 && Math.random() < rate * dt) { m.dipState = 1; m.dipTimer = 6; }
      return;
    }
    m.dipTimer -= dt;
    if (m.dipState === 1) {                                                  // DIVE to the surface
      if (m.py <= this.SEA_Y + this.DIP_SKIM_H + 0.5 || m.dipTimer <= 0) { m.dipState = 2; m.dipTimer = 0.3 + Math.random() * 0.5; }
    } else if (m.dipState === 2) {                                          // SKIM / snatch
      if (m.dipTimer <= 0) { m.dipState = 3; m.dipTimer = 6; }
    } else if (m.py >= f.goalAlt - 4 || m.dipTimer <= 0) {                  // 3 = CLIMB back out, then cool down
      m.dipState = 0; m.dipCooldown = 6 + Math.random() * 12;
    }
  }

  /** Compose one bird's world matrix + tint into its variant's buffer (respecting the per-variant cap).
   *  Position, yaw and wing-state all blend by the flock's `lift`: a loose raft on the water (perched,
   *  bird_c) eases into a travel-aligned flock in the air (wings out, bird_a/b). */
  private writeBird(f: Flock, m: Member, counts: number[]): void {
    let v: number, wx: number, wy: number, wz: number;
    let energy = 1;   // per-bird flap energy → instance colour alpha (B4)
    if (m.airborne) {
      // Airborne: kinematic position + an orientation banked into the turn and pitched to the climb. Babylon's
      // RotationY sends local +X → world (cos,−sin); the baked gull noses along −X, so yaw = atan2(vz,−vx) points
      // the beak along the velocity. Pitch (about the span axis Z) noses up climbing; roll (about the nose axis
      // X) is the bank. Compose yaw ∘ pitch ∘ roll (roll innermost = the bird's own local frame).
      // Variant by EFFORT/STATE: on final approach → the gear-down landing-flare mesh (3); a committed glider →
      // the dihedral soar mesh (1) with wings near-still; everyone else → the flat flapping mesh (0) beating at
      // its own effort. (Replaces the random a/b split.)
      v = m.onFinal ? 3 : (m.gliding ? 1 : 0);
      energy = m.onFinal ? 0.5 : (m.gliding ? 0.12 : m.flapE);   // braking flap on final
      wx = m.px; wy = m.py; wz = m.pz;
      const vx = Math.sin(m.hdg), vz = Math.cos(m.hdg);
      const yaw = Math.atan2(vz, -vx);
      // Pitch from climb angle, plus a nose-up FLARE bias as it settles onto the water (feet forward, braking).
      const pitch = Math.max(-0.5, Math.min(0.7,
        Math.atan2(m.vy, Math.max(m.spd, 1)) * this.PITCH_GAIN + m.flare * this.FLARE_PITCH));
      Quaternion.RotationAxisToRef(this._up, yaw, this._quat);
      Quaternion.RotationAxisToRef(this._axZ, pitch, this._qP);
      Quaternion.RotationAxisToRef(this._axX, m.bank, this._qR);
      this._quat.multiplyInPlace(this._qP).multiplyInPlace(this._qR);
    } else {
      // Resting on the water: drift with the raft; folded (perched) variant unless this gull is mid-stretch.
      v = m.restWingsOut ? m.flyVariant : 2;
      wx = f.cx + m.ox; wy = this.SEA_Y; wz = f.cz + m.oz;
      Quaternion.RotationAxisToRef(this._up, m.yaw, this._quat);
    }
    if (!this.meshes[v]) { v = 0; }   // chosen variant didn't load (e.g. undeployed bird_d) → fall back to the flyer
    const n = counts[v];
    if (n >= BirdService.MAX_PER_VARIANT) { return; }

    this._scaleV.set(m.scale, m.scale, m.scale);
    this._posV.set(wx, wy, wz);
    Matrix.ComposeToRef(this._scaleV, this._quat, this._posV, this._mat);
    this._mat.copyToArray(this.matBufs[v], n * 16);
    const ci = n * 4;
    const t = m.tint;
    this.colBufs[v][ci] = t.r; this.colBufs[v][ci + 1] = t.g; this.colBufs[v][ci + 2] = t.b; this.colBufs[v][ci + 3] = energy;
    counts[v] = n + 1;
  }

  // ── Spawning ───────────────────────────────────────────────────────────────────

  /** Build a coastal raft of gulls at the given water spot. Every flock can cycle RESTING→fly→RESTING;
   *  ~35% spawn already airborne (lift=1) so you immediately see flocks both on the water and circling. */
  private makeFlock(x: number, z: number): Flock {
    const count = 7 + Math.floor(Math.random() * 11);        // 7–17 gulls
    const spread = 8 + Math.random() * 12;
    const members: Member[] = [];
    for (let i = 0; i < count; i++) {
      members.push({
        ox: (Math.random() - 0.5) * 2 * spread,
        oz: (Math.random() - 0.5) * 2 * spread,
        oy: (Math.random() - 0.5) * 8,
        flyVariant: Math.random() < 0.35 ? 1 : 0,             // mostly full-flap, some gliders (B4 makes this dynamic)
        scale: 0.85 + Math.random() * 0.45,
        tint: BirdService.TINTS[Math.floor(Math.random() * BirdService.TINTS.length)],
        yaw: Math.random() * Math.PI * 2,
        restWingsOut: false,
        restTimer: 3 + Math.random() * 16,                    // staggered first stretch
        airborne: false,
        px: x, py: this.SEA_Y, pz: z, hdg: Math.random() * Math.PI * 2, spd: 0, vy: 0, bank: 0,
        radBias: 0.6 + Math.random() * 0.8,                   // personal wheel-radius / altitude variety
        altBias: (Math.random() - 0.5) * 12,
        flapE: 0.6, gliding: false, glideTimer: 0,
        onFinal: false, flare: 0,
        dipState: 0, dipTimer: 0, dipCooldown: Math.random() * 10,
      });
    }
    const drift = 0.12 + Math.random() * 0.22, dang = Math.random() * Math.PI * 2;
    const airborne = Math.random() < 0.35;
    const cruiseAlt = 22 + Math.random() * 22;                // 22–44 m
    const f: Flock = {
      state: airborne ? 'FLYING' : 'RESTING',
      stateTimer: 0,
      dwell: airborne ? 14 + Math.random() * 18 : 4 + Math.random() * 16,
      cx: x, cz: z, cy: this.SEA_Y,
      anchorX: x, anchorZ: z,
      cruiseAlt,
      wanderR: 16 + Math.random() * 26,                       // 16–42 m wheel roam
      gx: x, gy: airborne ? cruiseAlt : this.SEA_Y, gz: z,
      goalAlt: airborne ? cruiseAlt : this.SEA_Y,
      wTx: x, wTz: z, wanderTimer: 0,
      driftX: Math.cos(dang) * drift, driftZ: Math.sin(dang) * drift,
      nearShipDist: -1,
      following: false, followTimer: 0, followCooldown: 0,
      members,
    };
    if (airborne) { this.seedAirborne(f); }
    return f;
  }

  /** Find a water spot within the spawn ring of the camera that has land within LAND_PROXIMITY. */
  private findCoastalSpot(camX: number, camZ: number): { x: number; z: number } | null {
    for (let t = 0; t < 8; t++) {
      const ang = Math.random() * Math.PI * 2;
      const r = this.SPAWN_MIN + Math.random() * (this.SPAWN_MAX - this.SPAWN_MIN);
      const x = camX + Math.cos(ang) * r;
      const z = camZ + Math.sin(ang) * r;
      if (this.terrainService.isOnLand(x, z)) { continue; }   // rafts/flyers sit over water
      if (this.nearLand(x, z)) { return { x, z }; }
    }
    return null;
  }

  /** True if any land lies within LAND_PROXIMITY of (x,z) — sampled on a few rings (cheap, spawn-only). */
  private nearLand(x: number, z: number): boolean {
    const radii = [this.LAND_PROXIMITY * 0.35, this.LAND_PROXIMITY * 0.7, this.LAND_PROXIMITY];
    for (const r of radii) {
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        if (this.terrainService.isOnLand(x + Math.cos(a) * r, z + Math.sin(a) * r)) { return true; }
      }
    }
    return false;
  }

  dispose(): void {
    const scene = this.sceneService.scene;
    if (this.observer && scene) { scene.onBeforeRenderObservable.remove(this.observer); }
    this.observer = null;
    for (const m of this.meshes) { if (m) { m.dispose(); } }
    for (const mat of this.materials) { mat.dispose(); }
    this.meshes = []; this.materials = []; this.matBufs = []; this.colBufs = [];
    this.flocks = [];
    this.enabled = false;
    // Shared context: disconnect + release our own master (severs any in-flight cries) but do NOT close
    // the context — other SFX producers share it.
    if (this.audioMaster) { this.audioMaster.disconnect(); this.sfx.releaseMaster(this.audioMaster); this.audioMaster = null; }
    this.audioCtx = null;
  }
}
