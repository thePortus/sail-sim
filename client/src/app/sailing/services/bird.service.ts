import { Injectable, inject } from '@angular/core';
import {
  Color3, Material, Matrix, Mesh, Observer, Quaternion, Scene, StandardMaterial, Texture, Vector3,
} from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { SceneService } from './scene.service';
import { TerrainService } from './terrain.service';
import { VesselService } from './vessel.service';
import { MultiplayerService } from './multiplayer.service';
import { SfxService } from './sfx.service';
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
}

interface Flock {
  state: FlockState;
  stateTimer: number;                            // seconds spent in the current state
  dwell: number;                                 // how long to hold RESTING / FLYING before transitioning
  lift: number;                                  // 0 on the water … 1 at cruise altitude
  cx: number; cz: number; cy: number;            // flock centre (world)
  heading: number;                               // travel / orbit-tangent heading (rad)
  anchorX: number; anchorZ: number;              // the takeoff/resting spot the orbit swings around
  cruiseAlt: number;                             // target flying altitude (m)
  orbitR: number; orbitAng: number; orbitW: number;  // orbit radius, angle, angular speed (rad/s)
  driftX: number; driftZ: number;                // RESTING: slow surface drift (m/s)
  nearShipDist: number;                          // nearest-ship distance last frame (−1 = re-initialise)
  members: Member[];
}

/** Linear blend. */
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
/** Smooth 0→1 ease (Hermite) for the climb/descent. */
function ease01(t: number): number { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); }
/** Shortest-arc angle blend (so a bird turning to its flight heading never spins the long way round). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) { d -= Math.PI * 2; } else if (d < -Math.PI) { d += Math.PI * 2; }
  return a + d * t;
}

@Injectable({ providedIn: 'root' })
export class BirdService {
  private sceneService   = inject(SceneService);
  private terrainService = inject(TerrainService);
  private vesselService  = inject(VesselService);
  private multiplayer    = inject(MultiplayerService);
  private sfx            = inject(SfxService);

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

  // ── Asset config ─────────────────────────────────────────────────────────────
  private static readonly VARIANTS = [
    { file: 'bird_a.glb', ampScale: 1.0 },   // 0 flying, full flap
    { file: 'bird_b.glb', ampScale: 0.4 },   // 1 gliding, gentle flap
    { file: 'bird_c.glb', ampScale: 1.0 },   // 2 perched (geometry folds the wings → barely flaps)
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
      if (!mesh) { console.warn(`[birds] variant ${v} (${cfg.file}) failed — birds disabled`); return; }
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
      this.meshes[v] = mesh;
    }

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

    // Recycle flocks that have drifted out of range.
    for (let i = this.flocks.length - 1; i >= 0; i--) {
      const f = this.flocks[i];
      if (Math.hypot(f.cx - camX, f.cz - camZ) > this.DESPAWN) { this.flocks.splice(i, 1); }
    }
    // Top up toward maxFlocks at the wildlife tier's spawn RATE: at most one new flock per spawnInterval
    // seconds, so flocks fade into the coastline gradually instead of all popping in at once.
    this._spawnTimer += dt;
    if (this.flocks.length < this.maxFlocks && this._spawnTimer >= this.spawnInterval) {
      this._spawnTimer = 0;
      const spot = this.findCoastalSpot(camX, camZ);
      if (spot) { this.flocks.push(this.makeFlock(spot.x, spot.z)); }
    }

    // Collect every ship position once (local + remote) for the startle checks.
    const ships = this.gatherShips();

    // Advance each flock, then write its members into the per-variant thin-instance buffers.
    const counts = [0, 0, 0];
    for (const f of this.flocks) {
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
    switch (f.state) {
      case 'RESTING':
        // Drift slowly across the surface (anchor follows the raft so it lifts off from where it sits).
        f.cx += f.driftX * dt; f.cz += f.driftZ * dt;
        f.anchorX = f.cx; f.anchorZ = f.cz; f.cy = this.SEA_Y; f.lift = 0;
        if (f.stateTimer >= f.dwell) { this.beginTakeoff(f); }
        break;
      case 'TAKEOFF':
        f.lift = Math.min(1, f.lift + dt / this.TAKEOFF_TIME);
        this.orbit(f, dt);
        if (f.lift >= 1) { f.state = 'FLYING'; f.stateTimer = 0; f.dwell = 14 + Math.random() * 18; }
        break;
      case 'FLYING':
        this.orbit(f, dt);
        if (f.stateTimer >= f.dwell) { f.state = 'LANDING'; f.stateTimer = 0; }
        break;
      case 'LANDING':
        f.lift = Math.max(0, f.lift - dt / this.LAND_TIME);
        this.orbit(f, dt);
        if (f.lift <= 0) {
          // Settle: resume drifting from wherever the spiral set down, and rest a while. Re-initialise the
          // approach detector (−1) so a ship that's merely parked nearby doesn't read as "closing" and
          // immediately flush a raft that deliberately landed beside it.
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
      this.cryBurst(f);
    }
  }

  /** Public startle: flush every resting raft within `radius` of (x,z) — e.g. a cannon going off. */
  startleAt(x: number, z: number, radius = this.CANNON_RADIUS): void {
    if (!this.enabled) { return; }
    const r2 = radius * radius;
    for (const f of this.flocks) {
      if (f.state !== 'RESTING') { continue; }
      const dx = f.cx - x, dz = f.cz - z;
      if (dx * dx + dz * dz <= r2) { this.beginTakeoff(f); this.cryBurst(f); }
    }
  }

  // ── Gull-cry audio ───────────────────────────────────────────────────────────

  /** Lazily create the audio context + SFX-master routing (on first cry, after the user gesture). */
  private ensureAudio(): boolean {
    if (this.audioCtx) { return true; }
    try {
      this.audioCtx = new AudioContext();
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
    if (!cam || this.flocks.length === 0) { return; }
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
    f.orbitAng = Math.random() * Math.PI * 2;
  }

  /** Circle the anchor, swung out by `lift` (0 = sat on the anchor → 1 = full orbit radius), with a gentle
   *  altitude wander; heading tracks the orbit tangent so the formation faces its travel direction. */
  private orbit(f: Flock, dt: number): void {
    f.orbitAng += f.orbitW * dt;
    const r = f.orbitR * f.lift;
    f.cx = f.anchorX + Math.cos(f.orbitAng) * r;
    f.cz = f.anchorZ + Math.sin(f.orbitAng) * r;
    const e = ease01(f.lift);
    f.cy = lerp(this.SEA_Y, f.cruiseAlt + Math.sin(f.orbitAng * 0.7) * 2.5, e);
    f.heading = f.orbitAng + (f.orbitW >= 0 ? Math.PI / 2 : -Math.PI / 2);
  }

  /** Compose one bird's world matrix + tint into its variant's buffer (respecting the per-variant cap).
   *  Position, yaw and wing-state all blend by the flock's `lift`: a loose raft on the water (perched,
   *  bird_c) eases into a travel-aligned flock in the air (wings out, bird_a/b). */
  private writeBird(f: Flock, m: Member, counts: number[]): void {
    const lift = f.lift;
    // Airborne (incl. TAKEOFF/LANDING) → flying variant. On the water → perched (folded) unless this gull
    // is mid-stretch, in which case it shows its flying variant so its wings are out and flapping.
    const v = lift > 0.08 ? m.flyVariant : (m.restWingsOut ? m.flyVariant : 2);
    const n = counts[v];
    if (n >= BirdService.MAX_PER_VARIANT) { return; }

    // Raft offset (unrotated) ↔ flock offset (rotated to the heading), blended by lift.
    const c = Math.cos(f.heading), s = Math.sin(f.heading);
    const restX = f.cx + m.ox,                 restZ = f.cz + m.oz;
    const flyX  = f.cx + m.ox * c - m.oz * s,   flyZ  = f.cz + m.ox * s + m.oz * c;
    const wx = lerp(restX, flyX, lift);
    const wz = lerp(restZ, flyZ, lift);
    let wy = f.cy + m.oy * lift;
    // Don't clip terrain: once airborne, keep clear of the land beneath. Skip over water (ground ≈ 0 →
    // resting rafts and offshore birds are untouched); only headlands/hills under the orbit push birds up.
    if (lift > 0.05) {
      const ground = this.terrainService.getElevation(wx, wz);
      if (ground > 0.5) { wy = Math.max(wy, ground + this.GROUND_CLEARANCE); }
    }
    // Facing: Babylon's RotationY sends local +X to (cos, −sin), so the travel heading negates (fixes the
    // handedness). The baked gull model actually noses along −X (wings are ±Z), so add π to point the beak
    // — not the tail — along the path. A small symmetric per-bird jitter avoids perfect lockstep.
    const flyYaw = -f.heading + Math.PI + Math.sin(m.yaw) * 0.12;
    const yaw = lerpAngle(m.yaw, flyYaw, lift);

    this._scaleV.set(m.scale, m.scale, m.scale);
    this._posV.set(wx, wy, wz);
    Matrix.Compose(this._scaleV, Quaternion.RotationAxis(this._up, yaw), this._posV)
      .copyToArray(this.matBufs[v], n * 16);
    const ci = n * 4;
    const t = m.tint;
    this.colBufs[v][ci] = t.r; this.colBufs[v][ci + 1] = t.g; this.colBufs[v][ci + 2] = t.b; this.colBufs[v][ci + 3] = 1;
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
        oy: (Math.random() - 0.5) * 8,                        // vertical spread once airborne (× lift)
        flyVariant: Math.random() < 0.35 ? 1 : 0,             // mostly full-flap, some gliders
        scale: 0.85 + Math.random() * 0.45,
        tint: BirdService.TINTS[Math.floor(Math.random() * BirdService.TINTS.length)],
        yaw: Math.random() * Math.PI * 2,
        restWingsOut: false,
        restTimer: 3 + Math.random() * 16,                    // staggered first stretch
      });
    }
    const drift = 0.12 + Math.random() * 0.22, dang = Math.random() * Math.PI * 2;
    const airborne = Math.random() < 0.35;
    return {
      state: airborne ? 'FLYING' : 'RESTING',
      stateTimer: 0,
      // Stagger the first transition so rafts don't all take off together.
      dwell: airborne ? 14 + Math.random() * 18 : 4 + Math.random() * 16,
      lift: airborne ? 1 : 0,
      cx: x, cz: z, cy: this.SEA_Y,
      heading: 0,
      anchorX: x, anchorZ: z,
      cruiseAlt: 22 + Math.random() * 22,                     // 22–44 m
      orbitR: 16 + Math.random() * 26,                        // 16–42 m
      orbitAng: Math.random() * Math.PI * 2,
      orbitW: (Math.random() < 0.5 ? 1 : -1) * (0.12 + Math.random() * 0.10),  // rad/s
      driftX: Math.cos(dang) * drift, driftZ: Math.sin(dang) * drift,
      nearShipDist: -1,
      members,
    };
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
    if (this.audioMaster) { this.sfx.releaseMaster(this.audioMaster); this.audioMaster = null; }
    if (this.audioCtx) { void this.audioCtx.close(); this.audioCtx = null; }
  }
}
