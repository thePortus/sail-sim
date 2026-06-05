import { Injectable, inject } from '@angular/core';
import {
  Color3, Material, Matrix, Mesh, Observer, PBRMaterial, Quaternion, Scene, Texture, Vector3,
} from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { SceneService } from './scene.service';
import { TerrainService } from './terrain.service';
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

    // One shared atlas texture; one PBR material per variant (so each can carry its own flap ampScale).
    const atlas = new Texture(scatterTextureUrl('bird_atlas.png'), scene);
    for (let v = 0; v < BirdService.VARIANTS.length; v++) {
      const cfg = BirdService.VARIANTS[v];
      const mat = new PBRMaterial(`scatter_bird_${v}_mat`, scene);
      mat.albedoTexture = atlas;
      mat.metallic = 0.0;
      mat.roughness = 0.62;
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

    // Advance each flock, then write its members into the per-variant thin-instance buffers.
    const counts = [0, 0, 0];
    for (const f of this.flocks) {
      this.advanceFlock(f, dt);
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
          // Settle: resume drifting from wherever the spiral set down, and rest a while.
          f.state = 'RESTING'; f.stateTimer = 0; f.dwell = 9 + Math.random() * 14;
          f.cx = f.anchorX; f.cz = f.anchorZ;
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
    // Babylon's RotationY sends local +X (the gull's nose) to (cos, −sin) in world space, so the facing
    // yaw is the NEGATED travel heading (the formation-offset rotation above already matches this). A
    // small symmetric per-bird jitter keeps the flock from facing in perfect lockstep.
    const flyYaw = -f.heading + Math.sin(m.yaw) * 0.12;
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
  }
}
