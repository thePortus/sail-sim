import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  Scene, Mesh, MeshBuilder, Vector3, Color3, Color4,
  StandardMaterial, DynamicTexture, ParticleSystem, PointLight, Light,
  NoiseProceduralTexture, Ray, AbstractMesh, TransformNode,
} from '@babylonjs/core';
import type { CombatHitMsg } from './combat.constants';
import { SceneService }       from './scene.service';
import { OceanService }       from './ocean.service';
import { VesselService }      from './vessel.service';
import { TerrainService }     from './terrain.service';
import { MultiplayerService } from './multiplayer.service';
import { SfxService }         from './sfx.service';
import { BirdService }        from './bird.service';
import { DolphinService }     from './dolphin.service';
import { FishSchoolService }  from './fish-school.service';
import { MuzzleExplosions }   from './muzzle-explosion';
import { MuzzleSmoke }        from './muzzle-smoke';

// ── Constants ─────────────────────────────────────────────────────────────────

const G          = 9.81;
const BALL_POOL  = 24;           // max simultaneous cannonballs (broadsides = 3/side)

// Fixed broadside ballistics (no aiming/charging — guns fire straight out the beam).
const ELEV_RAD   = 8 * Math.PI / 180;   // fixed launch elevation
const MUZZLE_V_ROUND = 55;               // solid round shot muzzle velocity (m/s)
const MUZZLE_V_BAR   = 37;               // bar shot: ~45% range (range ∝ v²) — must match server SHOT_TYPES.bar.v
const MUZZLE_V_GRAPE = 26;               // grapeshot: ~22% range (shortest) — must match server SHOT_TYPES.grape.v
// Grapeshot fans a SPREAD of pellets out of each gun (a true canister burst). Each pellet is its own
// server-adjudicated shot; the server attrites crew per pellet that connects.
const GRAPE_PELLETS    = 5;               // pellets thrown per gun
const GRAPE_SPREAD_RAD = 7 * Math.PI / 180;   // azimuth cone half-angle (fan width)
const GRAPE_ELEV_RAD   = 4 * Math.PI / 180;   // elevation jitter half-angle (vertical scatter)
// Gap between guns of a broadside — randomized per shot so the volley reads as a human gun crew firing in
// sequence, not a single mechanical burst. A press fires every LOADED gun on the side in this rippled order.
const STAGGER_MIN = 0.18;
const STAGGER_MAX = 0.42;
// Per-cannon reload realism: each gun reloads INDEPENDENTLY, with its own cadence. `factor` is a fixed per-gun
// multiplier (one gun crew is a touch quicker than the next); `jitter` adds small shot-to-shot variation. So a
// broadside's guns come back online at slightly different times → you can loose partial broadsides as they're
// ready instead of waiting for the whole battery.
const RELOAD_VAR    = 0.16;              // ± fixed per-gun reload spread (assigned once per gun)
const RELOAD_JITTER = 0.07;              // ± extra random spread each reload
const FLASH_DUR  = 0.60;                 // muzzle-flash point-light envelope (s) — a touch longer

// Aiming-aid trajectory tube. Fixed sample count so the tube can be updated in place
// (CreateTube `instance`) every frame as the ship turns / elevation changes.
const AIM_SAMPLES = 40;
const AIM_WATER_Y = 0.5;                 // stop the predicted arc at the sea surface
const AIM_RADIUS  = 0.16;                // per-gun tube thickness (m) — thin so the sheaf of arcs reads

// Persistent battle damage: charred scorch decals projected onto the struck hull/mast.
// They live on the victim's mesh hierarchy until the ship is repaired (combat_reset).
const DECAL_MAX_PER_SHIP = 16;           // oldest scorch fades out once this many accrue

// Default battery — the sloop's three muzzle tips per side in vessel root-local space, derived from
// the 3 gunports. x = lateral (port = −x, starboard = +x); y = barrel height; z = fore/aft (bow = +Z).
// Used when the vessel def carries no `cannons` layout. Per-vessel batteries (e.g. the pinnace's
// single gun a side, opposite handedness) override this via syncGuns() reading VesselService.
type Muz = { x: number; y: number; z: number };
const DEFAULT_MUZZLES: Record<'port' | 'stbd', Muz[]> = {
  port: [
    { x: -1.98, y: 1.50, z: 1.36 },
    { x: -1.87, y: 1.65, z: 2.40 },
    { x: -1.72, y: 1.90, z: 3.44 },
  ],
  stbd: [
    { x: 1.98, y: 1.50, z: 1.36 },
    { x: 1.87, y: 1.65, z: 2.40 },
    { x: 1.72, y: 1.90, z: 3.44 },
  ],
};

// ── Types ─────────────────────────────────────────────────────────────────────

/** Ammunition / projectile kind. round = solid shot, bar = dismantling bar, grape = anti-crew canister. */
type ShotKind = 'round' | 'bar' | 'grape';

interface Ball {
  mesh:    Mesh;                            // round/grape sphere (the parent; drives position for both)
  barMesh: Mesh;                            // bar-shot assembly (two halves + iron bar), child of mesh
  kind:    ShotKind;                        // this flight's ammo → drives visual (dumbbell / small pellet) + spin
  ox:    number; oy: number; oz: number;  // world-space origin
  vx:    number; vy: number; vz: number;  // world-space velocity (m/s)
  t:     number;                           // elapsed seconds since launch
  alive: boolean;
  key:   string;                           // `${shooterId}:${seq}` — matches server combat_hit
  pendingHit?: CombatHitMsg | null;        // server-confirmed hit, played when this ball arrives
  hitAt?: number;                          // flight-time (s) at which to play pendingHit (server tof)
}

/** HUD-facing gunnery state (published per side). 'ready' = engaged with ≥1 gun loaded, 'reloading' = engaged
 *  but every gun is still reloading. 'firing' is unused now (the ripple is driven per-gun). */
type GunState = 'stowed' | 'arming' | 'ready' | 'firing' | 'reloading';

/** Internal per-side run-out state. The battery is run out ONCE (arm), then fires at will (every press looses the
 *  guns currently loaded) until stand-down — no per-broadside re-arm. */
type SideState = 'stowed' | 'arming' | 'engaged';

interface SideGun {
  state:     SideState;
  // Per-gun reload bookkeeping (length = gunsPerSide). A gun is LOADED when `elapsed >= loadAt[i]`.
  loadAt:    number[];   // elapsed time at which gun i finishes reloading (0 = loaded since arm)
  loadStart: number[];   // elapsed time gun i's current reload began (for the HUD readiness bar)
  fireAt:    number[];   // elapsed time a queued shot for gun i fires (Infinity = nothing queued)
  factor:    number[];   // fixed per-gun reload-time multiplier (each gun its own cadence)
}

/** One self-contained remote muzzle rig: a flash light + flame/smoke/linger plumes, pooled and
 *  assigned per remote shooter so concurrent broadsides don't share (and overwrite) one rig. */
interface RemoteMuzzleRig {
  light:        PointLight | null;   // null = particle-only rig (lights decoupled to stay under the GPU light budget)
  lightEndT:    number;
  flamePS:      ParticleSystem;  flameEmit:   Vector3;  flameCutoffT:  number;
  smokePS:      ParticleSystem;  smokeEmit:   Vector3;  smokeCutoffT:  number;
  lingerPS:     ParticleSystem;  lingerEmit:  Vector3;  lingerCutoffT: number;
  shooterId:    string | null;   // which remote player currently owns this rig (null = free)
  lastUsed:     number;          // remoteRigClock stamp at last assignment (LRU)
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class CannonService {
  private sceneService       = inject(SceneService);
  private oceanService       = inject(OceanService);
  private vesselService      = inject(VesselService);
  private terrainService     = inject(TerrainService);
  private multiplayerService = inject(MultiplayerService);
  private sfx                = inject(SfxService);
  private birds              = inject(BirdService);
  private dolphins           = inject(DolphinService);
  private fishSchool         = inject(FishSchoolService);
  private zone               = inject(NgZone);

  // ── Public signals (consumed by HUD) — per-side gun state + reload progress ──
  readonly portGunState  = signal<GunState>('stowed');
  readonly stbdGunState  = signal<GunState>('stowed');
  readonly portReloadFrac = signal(0);   // 0..1 reload progress
  readonly stbdReloadFrac = signal(0);
  // How many guns are LOADED on each side, and the side's total — drives a small "ready cannons" pip readout.
  readonly portLoaded = signal(0);
  readonly stbdLoaded = signal(0);
  readonly gunCount   = signal(DEFAULT_MUZZLES.port.length);

  // ── Gun elevation / targeting ───────────────────────────────────────────────
  // Elevation is the launch angle (deg). Flat (low) keeps the ball in the hull band
  // → hull hits; high lobs it up → mast hits. Shift raises, Control lowers; the
  // Hull/Mast buttons jump to presets. The shot velocity carries the angle, so the
  // server adjudicates any elevation correctly (no broadcast needed).
  private readonly ELEV_MIN  = 0;
  private readonly ELEV_MAX  = 18;
  private readonly ELEV_HULL = 3;
  private readonly ELEV_MAST = 12;
  readonly gunElevDeg = signal(this.ELEV_HULL);
  readonly targetMode = signal<'hull' | 'mast'>('hull');

  // ── Soft gunnery lock (aim assist) ──────────────────────────────────────────
  // A broadside soft-locks the nearest enemy roughly abeam (within LOCK_ARC of the beam) and solves the
  // LEADING, range-correct shot to it — but the horizontal correction is clamped to AIM_CONE, so you must
  // still bring the broadside generally to bear (an assist, not auto-aim). gunElevDeg picks the aim HEIGHT on
  // the target (waterline ↔ masthead), so Shift/Ctrl still choose hull vs rigging. Round/bar only (grape stays
  // a fixed canister spread). lockTarget drives the HUD reticle. The server adjudicates the solved shot like
  // any other (it keeps muzzle speed, so it passes validateShot).
  private readonly LOCK_ARC_DEG   = 42;    // target must be within this of the beam to lock on
  private readonly AIM_CONE_DEG   = 52;    // max horizontal correction off the raw beam (keeps positioning relevant)
  private readonly LOCK_MAX_RANGE = 320;   // only lock within effective round-shot reach
  private readonly AIM_LOW_Y      = 0.6;   // gunElevDeg = ELEV_HULL → aim at the waterline
  private readonly AIM_HIGH_Y     = 14;    // gunElevDeg = ELEV_MAST → aim at the masthead
  private readonly TRAVEL_SCALE   = 3;     // world velocity = speed × this (mirror combat-constants)
  /** The enemy a broadside is currently solving onto (for the HUD reticle); null when no side has a lock. */
  readonly lockTarget = signal<{ id: string; x: number; z: number } | null>(null);

  // ── Ammunition ──────────────────────────────────────────────────────────────
  // 'round' = solid shot (full range, anti-hull). 'bar' = bar shot (~45% range, anti-mast / anti-rigging).
  // 'grape' = canister (~22% range, anti-CREW — a fanned pellet spread, no hull damage).
  // The velocity carries the (shorter) range, and the type rides the cannon_shot message for server damage.
  readonly shotType = signal<ShotKind>('round');
  /** Current muzzle velocity for the selected ammo (lower = shorter range). */
  private muzzleV(): number {
    const t = this.shotType();
    return t === 'bar' ? MUZZLE_V_BAR : t === 'grape' ? MUZZLE_V_GRAPE : MUZZLE_V_ROUND;
  }
  /** Set the ammo type (HUD buttons). */
  setShotType(t: ShotKind): void { this.zone.run(() => this.shotType.set(t)); }
  /** Cycle round → bar → grape → round (G key). */
  toggleShotType(): void {
    const next: ShotKind = this.shotType() === 'round' ? 'bar' : this.shotType() === 'bar' ? 'grape' : 'round';
    this.setShotType(next);
  }

  // Continuous elevation: hold Shift to raise / Control to lower; tick() swings the angle smoothly at
  // ELEV_RATE_DPS (so the granularity is sub-degree, not whole-degree key-repeat steps).
  private readonly ELEV_RATE_DPS = 7;
  private elevRaiseHeld = false;
  private elevLowerHeld = false;

  /** Nudge the elevation (deg); Shift = +, Control = −. */
  elevate(deltaDeg: number): void {
    const v = Math.max(this.ELEV_MIN, Math.min(this.ELEV_MAX, this.gunElevDeg() + deltaDeg));
    this.zone.run(() => {
      this.gunElevDeg.set(v);
      this.targetMode.set(v >= (this.ELEV_HULL + this.ELEV_MAST) / 2 ? 'mast' : 'hull');
    });
  }

  /** Jump to a targeting preset (Hull = flat, Mast = high lob). */
  setTargetMode(mode: 'hull' | 'mast'): void {
    this.zone.run(() => {
      this.targetMode.set(mode);
      this.gunElevDeg.set(mode === 'mast' ? this.ELEV_MAST : this.ELEV_HULL);
    });
  }

  // ── Private state ─────────────────────────────────────────────────────────
  private scene!:   Scene;
  private canvas!:  HTMLCanvasElement;
  private elapsed = 0;

  // Persistent scorch decals, keyed by the victim player's id (own id for local ship).
  private scorchMat: StandardMaterial | null = null;
  private readonly decals = new Map<string, Mesh[]>();

  // Aiming aid: a translucent trajectory tube PER CANNON per side (a converging sheaf of arcs, one from
  // each muzzle), shown only while that side's guns are run out and ready (not stowed/arming/firing/reloading).
  private aimMat: StandardMaterial | null = null;       // free-aim arc (red)
  private aimMatLock: StandardMaterial | null = null;   // locked solution arc (green)
  private readonly aimTubes: Record<'port' | 'stbd', Mesh[]> = { port: [], stbd: [] };
  // Lock reticle: a camera-facing corner-bracket billboard parked on the soft-locked enemy (built lazily).
  private reticle: Mesh | null = null;
  private readonly RETICLE_Y = 3.5;   // sit it on the hull/low rig of the locked ship

  // Per-side gunnery state machines.
  private readonly gun: Record<'port' | 'stbd', SideGun> = {
    port: { state: 'stowed', loadAt: [], loadStart: [], fireAt: [], factor: [] },
    stbd: { state: 'stowed', loadAt: [], loadStart: [], fireAt: [], factor: [] },
  };
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;

  // Active gun layout for the LOCAL ship — refreshed from the vessel def at each broadside (syncGuns).
  private muzzles: Record<'port' | 'stbd', Muz[]> = DEFAULT_MUZZLES;
  private gunsPerSide = DEFAULT_MUZZLES.port.length;

  // Cannonball pool
  private balls: Ball[] = [];
  private shotSeq = 0;   // per-client shot counter; echoed by the server in combat_hit

  // Muzzle-flash point lights (one per cannon, reused across shots)
  private flashPort!:    PointLight;
  private flashStbd!:    PointLight;
  private flashPortEndT = -1;
  private flashStbdEndT = -1;

  // Muzzle blast particle systems — direction baked at fire() time from heading
  private flamePortPS!:  ParticleSystem;
  private flameStbdPS!:  ParticleSystem;
  private flamePortEmit  = new Vector3(0, 0, 0);
  private flameStbdEmit  = new Vector3(0, 0, 0);
  private flameCutoffT   = -1;
  // Volumetric muzzle fireball (raymarched billboard) — replaces the orange flame particles by default.
  // Opt out with localStorage.ignis_muzzle='particles' to fall back to the old additive flame PS.
  private explosions: MuzzleExplosions | null = null;
  private readonly useVolExplosion =
    (typeof localStorage === 'undefined') || localStorage.getItem('ignis_muzzle') !== 'particles';
  // Shader smoke (rising/drifting billboard puffs) replaces the dense fountain belch (lingering pall kept).
  // Opt out with localStorage.ignis_smoke='particles' to fall back to the old smoke ParticleSystem.
  private smoke: MuzzleSmoke | null = null;
  private readonly useShaderSmoke =
    (typeof localStorage === 'undefined') || localStorage.getItem('ignis_smoke') !== 'particles';

  // Smoke "fountain" particle systems — the directional belch right at the muzzle
  private smokePortPS!:  ParticleSystem;
  private smokeStbdPS!:  ParticleSystem;
  private smokePortEmit  = new Vector3(0, 0, 0);
  private smokeStbdEmit  = new Vector3(0, 0, 0);
  private smokeCutoffT   = -1;

  // Lingering smoke-cloud systems — slow, billowing, persists ~5s then fades over ~10s
  private lingerPortPS!:  ParticleSystem;
  private lingerStbdPS!:  ParticleSystem;
  private lingerPortEmit  = new Vector3(0, 0, 0);
  private lingerStbdEmit  = new Vector3(0, 0, 0);
  private lingerCutoffT   = -1;

  // Shared turbulence noise for all smoke systems (one texture, assigned to many PS)
  private smokeNoise!: NoiseProceduralTexture;

  // Remote shot effects — a POOL of independent muzzle rigs (light + flame/smoke/linger), one
  // assigned per remote shooter (sticky, LRU-evicted), so several ships firing at once each get
  // their OWN flash, smoke & light instead of fighting over one shared rig.
  // NOTE: each rig owns a real PointLight, and the scene's TOTAL enabled-light count is baked into every
  // material's prePass G-buffer variant (which ignores maxSimultaneousLights). On GPUs at WebGPU's 12-
  // uniform-buffer/stage minimum (Metal), 3 base + pierLight + 3 player flashes + N remote rigs must stay
  // ≤ 9 lights (→ 3+9 = 12 UBOs). N=2 keeps us at the limit; raising it crashes the prePass once another
  // opaque PBR mesh (harbor towns) forces that variant to compile. To scale past this, decouple the rig
  // light from its particles (a small shared light pool + many particle-only rigs).
  private readonly REMOTE_RIG_COUNT = 2;
  private remoteRigs: RemoteMuzzleRig[] = [];
  private remoteRigByShooter = new Map<string, number>();
  private remoteRigClock = 0;   // ticks up on each assignment — drives LRU eviction

  // Impact particle systems.
  // Water spouts use a small POOL so a 3-ball broadside produces 3 independent
  // spouts (each delayed to its own rebound) instead of one shared system whose
  // emitter/timer gets overwritten by the next impact.
  private readonly SPLASH_FX_POOL = 4;
  private splashFx: { ps: ParticleSystem; emit: Vector3; startT: number; cutoffT: number }[] = [];
  private dirtPS!:       ParticleSystem;
  private dirtEmit       = new Vector3(0, 0, 0);
  private dirtCutoffT    = -1;

  // Lingering land dust/smoke cloud (the slow pall after a land hit)
  private landSmokePS!:    ParticleSystem;
  private landSmokeEmit    = new Vector3(0, 0, 0);
  private landSmokeCutoffT = -1;

  // Ship-hit impact: wood splinters + a quick fire gust + flash (reuses dirt/landSmoke
  // for the dust pall).
  private shipDebrisPS!:   ParticleSystem;
  private shipDebrisEmit   = new Vector3(0, 0, 0);
  private shipDebrisCutoffT = -1;
  private shipFirePS!:     ParticleSystem;
  private shipFireEmit     = new Vector3(0, 0, 0);
  private shipFireCutoffT  = -1;
  private shipFlash!:      PointLight;
  private shipFlashEndT    = -1;
  // Black sooty smoke that hangs over the impact for a while (separate from the dust).
  private shipSmokePS!:    ParticleSystem;
  private shipSmokeEmit    = new Vector3(0, 0, 0);
  private shipSmokeCutoffT = -1;

  // Web Audio context for sound effects, routed through a shared SFX master gain.
  private sfxCtx: AudioContext | null = null;
  private sfxMaster: GainNode | null = null;

  // Cannon audio bus: all shot layers feed `cannonBus` → (dry) limiter and
  // (wet) reverb → limiter → sfxMaster. The limiter keeps a 3-gun broadside from
  // spiking into ear-pain; the convolver gives the boom its rolling reverberation.
  private cannonBus: GainNode | null = null;

  // Shared soft-blob texture for all particle systems
  private blobTex!: DynamicTexture;

  // ── Init / dispose ────────────────────────────────────────────────────────

  init(): void {
    this.scene  = this.sceneService.scene;
    this.canvas = this.scene.getEngine().getRenderingCanvas() as HTMLCanvasElement;
    this.sfxCtx = this.sfx.getSharedAudioContext();   // shared SFX context (own master + reverb bus below)
    this.sfxMaster = this.sfx.createMaster(this.sfxCtx);
    this.buildCannonAudio();

    this.buildParticleTex();
    this.buildSmokeNoise();
    this.buildBallPool();
    this.buildFlashLights();
    this.buildFlameParticles();
    if (this.useVolExplosion) {
      this.explosions = new MuzzleExplosions(this.scene, (m) => this.sceneService.excludeFromPrePass(m),
        16, (mesh) => this.sceneService.includeShaderInGlow(mesh));
    }
    if (this.useShaderSmoke) {
      this.smoke = new MuzzleSmoke(this.scene, {
        excludeFromPrePass: (m) => this.sceneService.excludeFromPrePass(m),
        setDepthActive:     (on) => this.sceneService.setSmokeDepthActive(on),
        getDepthTexture:    () => this.sceneService.smokeDepthMap,
        vFlip:              this.sceneService.isWebGPU ? 1 : 0,
      });
    }
    this.buildSmokeParticles();
    this.buildLingerParticles();
    this.buildImpactParticles();
    this.setupInput();

    // Wire remote-shot + combat callbacks (avoids circular injection with MultiplayerService)
    this.multiplayerService.onRemoteShot = (ox, oy, oz, vx, vy, vz, shooterId, seq, kind) => {
      this.launchBall(ox, oy, oz, vx, vy, vz, shooterId, seq, kind);
      this.fireRemoteEffect(shooterId, ox, oy, oz, vx, vz);
      this.birds.startleAt(ox, oz);   // a remote ship's broadside startles gulls near its muzzle too
      this.fishSchool.scatterFrom(ox, oz);   // …and scatters nearby bait-fish schools
      this.dolphins.scatterFrom(ox, oz);   // …and scatters any nearby dolphins
      this.oceanService.startleFish(ox, oz);   // …and the shallow-water fish
    };
    this.multiplayerService.onCombatHit = (msg) => this.onCombatHit(msg);
    // A repaired ship (server `combat_reset`) clears its accumulated scorch decals.
    this.multiplayerService.onCombatRepair = (playerId) => this.clearShipDecals(playerId);

    this.scene.registerBeforeRender(() => {
      const dt = Math.min(this.scene.getEngine().getDeltaTime() * 0.001, 0.05);
      this.tick(dt);
    });
  }

  dispose(): void {
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    if (this.keyUpHandler) {
      window.removeEventListener('keyup', this.keyUpHandler);
      this.keyUpHandler = null;
    }
    this.multiplayerService.onRemoteShot = null;
    this.multiplayerService.onCombatHit = null;
    this.multiplayerService.onCombatRepair = null;

    this.explosions?.dispose();
    this.explosions = null;
    this.smoke?.dispose();
    this.smoke = null;

    for (const list of this.decals.values()) for (const d of list) d.dispose();
    this.decals.clear();
    this.scorchMat?.dispose();

    for (const t of this.aimTubes.port) t.dispose();
    for (const t of this.aimTubes.stbd) t.dispose();
    this.aimTubes.port.length = 0;
    this.aimTubes.stbd.length = 0;
    this.aimMat?.dispose();
    this.aimMatLock?.dispose();
    this.reticle?.dispose(false, true);   // also frees its DynamicTexture + material
    this.reticle = null;

    for (const b of this.balls) b.mesh.dispose();
    this.flashPort?.dispose();
    this.flashStbd?.dispose();
    this.shipFlash?.dispose();
    for (const rig of this.remoteRigs) {
      rig.light?.dispose();
      for (const ps of [rig.flamePS, rig.smokePS, rig.lingerPS]) { ps?.stop(); ps?.dispose(); }
    }
    this.remoteRigs = [];
    this.remoteRigByShooter.clear();
    for (const ps of [
      this.flamePortPS, this.flameStbdPS,
      this.smokePortPS, this.smokeStbdPS,
      this.lingerPortPS, this.lingerStbdPS,
      ...this.splashFx.map(f => f.ps),
      this.dirtPS, this.landSmokePS, this.shipDebrisPS, this.shipFirePS, this.shipSmokePS,
    ]) { ps?.stop(); ps?.dispose(); }
    this.smokeNoise?.dispose();
    // Shared context: disconnect our master (severs the reverb bus / limiter / one-shots) and release it,
    // but do NOT close the context — other SFX producers share it. One-shots auto-stop; the idle reverb
    // bus is orphaned by the disconnect and GC'd.
    this.cannonBus = null;
    this.sfxMaster?.disconnect();
    this.sfx.releaseMaster(this.sfxMaster);
    this.sfxMaster = null;
    this.sfxCtx = null;
  }

  // ── Shared soft-blob texture ──────────────────────────────────────────────

  private buildParticleTex(): void {
    this.blobTex = new DynamicTexture('cannonBlob', { width: 64, height: 64 }, this.scene, false);
    const ctx    = this.blobTex.getContext() as CanvasRenderingContext2D;
    const grd    = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0.00, 'rgba(255,255,255,1.0)');
    grd.addColorStop(0.40, 'rgba(255,255,255,0.7)');
    grd.addColorStop(1.00, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    this.blobTex.update();
    this.blobTex.hasAlpha = true;
  }

  // ── Cannonball pool ───────────────────────────────────────────────────────

  private buildBallPool(): void {
    const mat = new StandardMaterial('ballMat', this.scene);
    mat.diffuseColor  = new Color3(0.07, 0.07, 0.07);
    mat.specularColor = new Color3(0.20, 0.18, 0.15);
    mat.specularPower = 32;

    for (let i = 0; i < BALL_POOL; i++) {
      const m = MeshBuilder.CreateSphere(`cball_${i}`, { diameter: 0.20, segments: 7 }, this.scene);
      m.material         = mat;
      m.renderingGroupId = 2;
      m.isPickable       = false;
      m.setEnabled(false);
      this.sceneService.shadowGenerator?.addShadowCaster(m);
      this.oceanService.addToRenderList(m);

      // Bar-shot assembly (two ball-halves joined by an iron bar = a dumbbell), tumbled fast in flight to
      // scythe rigging. Bar lies along local X so a Z spin whirls the heads end-over-end. Built per ball
      // (own geometry) and parented to the sphere, so the sphere's flight + enabled-state drive it.
      const bm = this.buildBarShotMesh(`cbar_${i}`, mat);
      bm.renderingGroupId = 2;
      bm.isPickable       = false;
      bm.parent           = m;
      bm.position.set(0, 0, 0);
      bm.isVisible        = false;        // shown only for bar shot (see launchBall)
      this.sceneService.shadowGenerator?.addShadowCaster(bm);
      this.oceanService.addToRenderList(bm);

      this.balls.push({ mesh: m, barMesh: bm, kind: 'round', ox:0, oy:0, oz:0, vx:0, vy:0, vz:0, t:0, alive: false, key: '' });
    }
  }

  /** Build one bar-shot projectile mesh: two hemispherical heads on a short iron bar, merged into one. */
  private buildBarShotMesh(name: string, mat: StandardMaterial): Mesh {
    const head1 = MeshBuilder.CreateSphere('bs_h1', { diameter: 0.15, segments: 6 }, this.scene);
    head1.position.x =  0.20;
    const head2 = MeshBuilder.CreateSphere('bs_h2', { diameter: 0.15, segments: 6 }, this.scene);
    head2.position.x = -0.20;
    const bar = MeshBuilder.CreateCylinder('bs_bar', { height: 0.40, diameter: 0.045, tessellation: 6 }, this.scene);
    bar.rotation.z = Math.PI / 2;        // default cylinder runs along Y → lay it along X
    for (const p of [head1, head2, bar]) p.material = mat;
    const merged = Mesh.MergeMeshes([head1, bar, head2], true, true)!;
    merged.name = name;
    merged.material = mat;
    return merged;
  }

  // ── Flash lights ──────────────────────────────────────────────────────────

  private buildFlashLights(): void {
    const make = (name: string) => {
      const l = new PointLight(name, Vector3.Zero(), this.scene);
      l.diffuse   = new Color3(1.0, 0.72, 0.22);
      l.specular  = new Color3(1.0, 0.50, 0.08);
      l.intensity = 0;
      // Reach far enough to wash distant cliffs and enemy ships (~1 km), but with a STANDARD
      // (quadratic-to-zero) falloff so it's bright at the firing ship and fades to a faint hint
      // at the edge — rather than the default inverse-square, which dies within ~50 m. (NEARBY LAND
      // is lit separately via a faked glow in the terrain shader — see uCannonFlash there — because a
      // dynamic point light doesn't reach that custom PBR material, same as the emissive sea.)
      l.range        = 1150;
      l.falloffType  = Light.FALLOFF_STANDARD;
      // Sort BELOW the scene's base lights (sun/moon/ambient, priority 0): the forward renderer
      // caps lights per mesh, so this guarantees a flash never displaces the sun (which would
      // momentarily darken a ship/terrain when guns fire).
      l.renderPriority = -1;
      return l;
    };
    this.flashPort   = make('cannonFlashPort');
    this.flashStbd   = make('cannonFlashStbd');
    this.shipFlash   = make('cannonShipHitFlash');

    // Pool of independent remote rigs — each gets its own flash light here; its flame/smoke/linger
    // plumes are filled in by the particle builders below (which run after this).
    for (let i = 0; i < this.REMOTE_RIG_COUNT; i++) {
      this.remoteRigs.push({
        light: null, lightEndT: -1,   // decoupled: remote shots use particles + terrain/water glow, no point light
        flamePS:  null as unknown as ParticleSystem, flameEmit:  new Vector3(0, 0, 0), flameCutoffT:  -1,
        smokePS:  null as unknown as ParticleSystem, smokeEmit:  new Vector3(0, 0, 0), smokeCutoffT:  -1,
        lingerPS: null as unknown as ParticleSystem, lingerEmit: new Vector3(0, 0, 0), lingerCutoffT: -1,
        shooterId: null, lastUsed: 0,
      });
    }

    // The flash lights terrain, distant cliffs and other ships within ~1 km (STANDARD falloff
    // fades it with distance). The water is lit separately via an emissive glow in the ocean
    // shader (a point light can't light the emissive sea).
  }

  // ── Shared turbulence noise for smoke ─────────────────────────────────────

  private buildSmokeNoise(): void {
    const n = new NoiseProceduralTexture('cannonSmokeNoise', 128, this.scene);
    n.animationSpeedFactor = 4;
    n.persistence          = 0.8;
    n.brightness           = 0.55;
    n.octaves              = 4;
    this.smokeNoise = n;
  }

  // ── Muzzle blast (flame core) particle systems ────────────────────────────
  //
  // The bright, fast, additive jet of fire right at the barrel mouth. Many small
  // particles, brief, growing slightly as they leave the muzzle.

  private buildFlameParticles(): void {
    const makeFlame = (name: string, emitVec: Vector3) => {
      const ps = new ParticleSystem(name, 520, this.scene);
      ps.particleTexture = this.blobTex;
      ps.emitter    = emitVec;
      ps.minEmitBox = new Vector3(-0.12, -0.10, -0.12);
      ps.maxEmitBox = new Vector3( 0.12,  0.10,  0.12);
      ps.color1     = new Color4(1.00, 0.95, 0.72, 1.00);
      ps.color2     = new Color4(1.00, 0.52, 0.10, 0.95);
      ps.colorDead  = new Color4(0.50, 0.14, 0.01, 0.00);
      ps.minLifeTime  = 0.22;  ps.maxLifeTime  = 0.72;
      ps.minEmitPower = 11;    ps.maxEmitPower = 30;
      ps.updateSpeed  = 0.014;
      ps.addSizeGradient(0.0, 0.50, 1.10);   // bigger at the muzzle…
      ps.addSizeGradient(1.0, 3.00, 4.50);   // …blooming much larger as it shoots out
      ps.direction1   = new Vector3(-1, 0.04, 0);
      ps.direction2   = new Vector3(-1, 0.30, 0);
      ps.gravity      = new Vector3(0, -0.5, 0);
      ps.blendMode    = ParticleSystem.BLENDMODE_ADD;
      ps.renderingGroupId = 3;   // above ALL ocean LODs (far=0, lod1=1, lod0/near=2)
      ps.emitRate     = 0;
      ps.start();
      return ps;
    };
    this.flamePortPS  = makeFlame('flamePort',   this.flamePortEmit);
    this.flameStbdPS  = makeFlame('flameStbd',   this.flameStbdEmit);
    for (let i = 0; i < this.remoteRigs.length; i++) {
      this.remoteRigs[i].flamePS = makeFlame(`flameRemote${i}`, this.remoteRigs[i].flameEmit);
    }
  }

  // ── Smoke "fountain" particle systems ─────────────────────────────────────
  //
  // The dense directional belch: many small particles blasting out the beam,
  // warm-tinted at birth (fire amid the smoke) cooling to grey, DECELERATING via
  // a velocity-over-life gradient so they pile up into a cloud instead of flying
  // straight, GROWING via a size gradient, and ROILING via the shared noise.

  private buildSmokeParticles(): void {
    const makeSmoke = (name: string, emitVec: Vector3) => {
      const ps = new ParticleSystem(name, 900, this.scene);
      ps.particleTexture = this.blobTex;
      ps.emitter    = emitVec;
      ps.minEmitBox = new Vector3(-0.14, -0.12, -0.14);
      ps.maxEmitBox = new Vector3( 0.14,  0.12,  0.14);
      // colour-over-life: warm fire core → grey smoke → fade
      ps.addColorGradient(0.00, new Color4(1.00, 0.78, 0.34, 0.00));
      ps.addColorGradient(0.06, new Color4(1.00, 0.66, 0.24, 1.00));
      ps.addColorGradient(0.25, new Color4(0.58, 0.50, 0.44, 0.95));
      ps.addColorGradient(0.70, new Color4(0.44, 0.42, 0.40, 0.78));
      ps.addColorGradient(1.00, new Color4(0.32, 0.32, 0.32, 0.00));
      // grow as it billows — larger swell
      ps.addSizeGradient(0.00, 0.60, 1.30);
      ps.addSizeGradient(1.00, 5.00, 7.50);
      // fast out the muzzle, then decelerate hard and hang
      ps.addVelocityGradient(0.00, 1.00);
      ps.addVelocityGradient(0.18, 0.35);
      ps.addVelocityGradient(1.00, 0.05);
      ps.minLifeTime  = 1.4;   ps.maxLifeTime  = 3.4;
      ps.minEmitPower = 10;    ps.maxEmitPower = 27;
      ps.updateSpeed  = 0.012;
      ps.gravity      = new Vector3(0, 1.2, 0);   // smoke rises as it slows
      ps.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
      ps.renderingGroupId = 3;   // above ALL ocean LODs (far=0, lod1=1, lod0/near=2)
      ps.noiseTexture = this.smokeNoise;
      ps.noiseStrength = new Vector3(6, 8, 6);
      ps.emitRate     = 0;
      ps.start();
      return ps;
    };
    this.smokePortPS  = makeSmoke('smokePort',   this.smokePortEmit);
    this.smokeStbdPS  = makeSmoke('smokeStbd',   this.smokeStbdEmit);
    for (let i = 0; i < this.remoteRigs.length; i++) {
      this.remoteRigs[i].smokePS = makeSmoke(`smokeRemote${i}`, this.remoteRigs[i].smokeEmit);
    }
  }

  // ── Lingering smoke-cloud particle systems ────────────────────────────────
  //
  // The hanging pall left after the shot: few-but-large, slow-rising, long-lived
  // billows whose alpha HOLDS for ~5s then fades over ~10s (lifetime 10–15s).

  private buildLingerParticles(): void {
    const makeLinger = (name: string, emitVec: Vector3) => {
      const ps = new ParticleSystem(name, 500, this.scene);
      ps.particleTexture = this.blobTex;
      ps.emitter    = emitVec;
      ps.minEmitBox = new Vector3(-0.40, -0.20, -0.40);
      ps.maxEmitBox = new Vector3( 0.40,  0.40,  0.40);
      // alpha climbs fast, HOLDS through ~1/3 of life (~5s of 15s), then fades to 0
      ps.addColorGradient(0.00, new Color4(0.50, 0.48, 0.45, 0.00));
      ps.addColorGradient(0.08, new Color4(0.48, 0.46, 0.43, 0.62));
      ps.addColorGradient(0.33, new Color4(0.45, 0.44, 0.42, 0.55));
      ps.addColorGradient(1.00, new Color4(0.40, 0.40, 0.40, 0.00));
      // swell over the whole life
      ps.addSizeGradient(0.00, 1.50, 2.50);
      ps.addSizeGradient(0.40, 5.00, 7.00);
      ps.addSizeGradient(1.00, 8.00, 11.0);
      // Blast OUT fast (like the fountain) so the lingering pall fills the same wide
      // footprint as the initial plume, then decelerate hard and hang for many seconds.
      ps.addVelocityGradient(0.00, 1.00);
      ps.addVelocityGradient(0.05, 0.15);
      ps.addVelocityGradient(1.00, 0.02);
      ps.minLifeTime  = 10.0;  ps.maxLifeTime  = 15.0;
      ps.minEmitPower = 9.0;   ps.maxEmitPower = 24.0;
      ps.updateSpeed  = 0.012;
      ps.gravity      = new Vector3(0, 0.5, 0);   // slow drift upward
      ps.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
      ps.renderingGroupId = 3;   // above ALL ocean LODs (far=0, lod1=1, lod0/near=2)
      ps.noiseTexture = this.smokeNoise;
      ps.noiseStrength = new Vector3(2.0, 2.5, 2.0);
      ps.emitRate     = 0;
      ps.start();
      return ps;
    };
    this.lingerPortPS  = makeLinger('lingerPort',   this.lingerPortEmit);
    this.lingerStbdPS  = makeLinger('lingerStbd',   this.lingerStbdEmit);
    for (let i = 0; i < this.remoteRigs.length; i++) {
      this.remoteRigs[i].lingerPS = makeLinger(`lingerRemote${i}`, this.remoteRigs[i].lingerEmit);
    }
  }

  // ── Impact particle systems ───────────────────────────────────────────────

  private buildImpactParticles(): void {
    // Water geyser — a big sheet of spray. Direction is set per-impact (biased back
    // along the ball's entry), here we just configure the body: many particles that
    // grow as they fly and fall back under heavy gravity.
    for (let i = 0; i < this.SPLASH_FX_POOL; i++) {
      const emit = new Vector3(0, 0, 0);
      this.splashFx.push({ ps: this.makeSplash(`cannonSplash${i}`, emit), emit, startT: -1, cutoffT: -1 });
    }

    // Land impact — big puffy smoke + dust. Dust-brown at birth settling to grey
    // smoke, growing large and roiling (shared noise). Direction set per-impact.
    this.dirtPS = new ParticleSystem('cannonDirt', 700, this.scene);
    this.dirtPS.particleTexture = this.blobTex;
    this.dirtPS.emitter    = this.dirtEmit;
    this.dirtPS.minEmitBox = new Vector3(-0.3, 0, -0.3);
    this.dirtPS.maxEmitBox = new Vector3( 0.3, 0.3,  0.3);
    this.dirtPS.addColorGradient(0.00, new Color4(0.55, 0.42, 0.22, 0.00));
    this.dirtPS.addColorGradient(0.08, new Color4(0.60, 0.46, 0.26, 0.95));
    this.dirtPS.addColorGradient(0.45, new Color4(0.50, 0.45, 0.38, 0.82));
    this.dirtPS.addColorGradient(1.00, new Color4(0.42, 0.40, 0.37, 0.00));
    this.dirtPS.addSizeGradient(0.0, 0.50, 1.20);
    this.dirtPS.addSizeGradient(1.0, 3.50, 5.50);
    this.dirtPS.minLifeTime  = 0.80;  this.dirtPS.maxLifeTime  = 1.50;
    this.dirtPS.minEmitPower = 6;     this.dirtPS.maxEmitPower = 20;
    this.dirtPS.direction1   = new Vector3(-1.5, 5, -1.5);  // overwritten per impact
    this.dirtPS.direction2   = new Vector3( 1.5, 12, 1.5);
    this.dirtPS.gravity      = new Vector3(0, -20, 0);      // heavy: dust kicks up then drops fast
    this.dirtPS.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
    this.dirtPS.renderingGroupId = 3;   // above all ocean LODs
    this.dirtPS.noiseTexture = this.smokeNoise;
    this.dirtPS.noiseStrength = new Vector3(3, 3, 3);
    this.dirtPS.emitRate     = 0;
    this.dirtPS.start();

    // Lingering land dust — the slow pall left after a land hit (like the cannon's
    // lingering smoke, but dusty browns instead of grey). Spreads OUT from the impact
    // along the ground, swells, then hangs for several seconds before fading.
    this.landSmokePS = new ParticleSystem('cannonLandSmoke', 700, this.scene);
    this.landSmokePS.particleTexture = this.blobTex;
    this.landSmokePS.emitter    = this.landSmokeEmit;
    this.landSmokePS.minEmitBox = new Vector3(-1.0, 0, -1.0);
    this.landSmokePS.maxEmitBox = new Vector3( 1.0, 0.4,  1.0);
    // dusty brown at birth → settling grey-brown → fade; alpha holds then fades
    this.landSmokePS.addColorGradient(0.00, new Color4(0.54, 0.45, 0.30, 0.00));
    this.landSmokePS.addColorGradient(0.10, new Color4(0.52, 0.44, 0.31, 0.58));
    this.landSmokePS.addColorGradient(0.40, new Color4(0.47, 0.43, 0.37, 0.50));
    this.landSmokePS.addColorGradient(1.00, new Color4(0.41, 0.39, 0.37, 0.00));
    this.landSmokePS.addSizeGradient(0.00, 1.20, 2.20);
    this.landSmokePS.addSizeGradient(0.40, 4.00, 6.00);
    this.landSmokePS.addSizeGradient(1.00, 6.50, 9.00);
    this.landSmokePS.addVelocityGradient(0.00, 1.00);
    this.landSmokePS.addVelocityGradient(0.06, 0.20);   // spread out fast, then hang
    this.landSmokePS.addVelocityGradient(1.00, 0.02);
    this.landSmokePS.minLifeTime  = 6.0;  this.landSmokePS.maxLifeTime  = 11.0;
    this.landSmokePS.minEmitPower = 6;    this.landSmokePS.maxEmitPower = 16;
    this.landSmokePS.gravity      = new Vector3(0, 0.4, 0);   // slow drift upward
    this.landSmokePS.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
    this.landSmokePS.renderingGroupId = 3;
    this.landSmokePS.noiseTexture = this.smokeNoise;
    this.landSmokePS.noiseStrength = new Vector3(2.5, 2.5, 2.5);
    this.landSmokePS.emitRate     = 0;
    this.landSmokePS.start();

    // Wood splinters for a ship hit — lots of small, sharp, dark-brown chunks flung
    // out fast under heavy gravity for a brief moment (shattering hull timber).
    this.shipDebrisPS = new ParticleSystem('shipDebris', 900, this.scene);
    this.shipDebrisPS.particleTexture = this.blobTex;
    this.shipDebrisPS.emitter    = this.shipDebrisEmit;
    this.shipDebrisPS.minEmitBox = new Vector3(-0.25, 0, -0.25);
    this.shipDebrisPS.maxEmitBox = new Vector3( 0.25, 0.25, 0.25);
    this.shipDebrisPS.color1     = new Color4(0.46, 0.33, 0.18, 1.00);
    this.shipDebrisPS.color2     = new Color4(0.28, 0.19, 0.10, 1.00);
    this.shipDebrisPS.colorDead  = new Color4(0.22, 0.15, 0.08, 0.00);
    this.shipDebrisPS.minSize      = 0.09;  this.shipDebrisPS.maxSize      = 0.36;
    this.shipDebrisPS.minLifeTime  = 0.45;  this.shipDebrisPS.maxLifeTime  = 1.30;
    this.shipDebrisPS.minEmitPower = 9;     this.shipDebrisPS.maxEmitPower = 24;
    this.shipDebrisPS.direction1   = new Vector3(-1, 3, -1);   // overwritten per hit
    this.shipDebrisPS.direction2   = new Vector3( 1, 7,  1);
    this.shipDebrisPS.gravity      = new Vector3(0, -30, 0);    // chunks fall fast
    this.shipDebrisPS.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
    this.shipDebrisPS.renderingGroupId = 3;
    this.shipDebrisPS.emitRate     = 0;
    this.shipDebrisPS.start();

    // Quick gust of fire at the impact — a brief bright additive flame burst, like
    // the powder/timber flaring on the hit.
    this.shipFirePS = new ParticleSystem('shipFire', 320, this.scene);
    this.shipFirePS.particleTexture = this.blobTex;
    this.shipFirePS.emitter    = this.shipFireEmit;
    this.shipFirePS.minEmitBox = new Vector3(-0.2, 0, -0.2);
    this.shipFirePS.maxEmitBox = new Vector3( 0.2, 0.2,  0.2);
    this.shipFirePS.color1     = new Color4(1.00, 0.92, 0.55, 1.00);
    this.shipFirePS.color2     = new Color4(1.00, 0.46, 0.10, 0.95);
    this.shipFirePS.colorDead  = new Color4(0.45, 0.12, 0.01, 0.00);
    this.shipFirePS.addSizeGradient(0.0, 0.40, 0.90);
    this.shipFirePS.addSizeGradient(1.0, 1.80, 2.80);
    this.shipFirePS.minLifeTime  = 0.12;  this.shipFirePS.maxLifeTime  = 0.42;
    this.shipFirePS.minEmitPower = 7;     this.shipFirePS.maxEmitPower = 20;
    this.shipFirePS.direction1   = new Vector3(-1, 2, -1);   // overwritten per hit
    this.shipFirePS.direction2   = new Vector3( 1, 6,  1);
    this.shipFirePS.gravity      = new Vector3(0, 3, 0);     // fire lifts a touch
    this.shipFirePS.blendMode    = ParticleSystem.BLENDMODE_ADD;
    this.shipFirePS.renderingGroupId = 3;
    this.shipFirePS.emitRate     = 0;
    this.shipFirePS.start();

    // Black sooty smoke that hangs over the strike for several seconds — darker than
    // the brown dust, rising slowly and swelling, alpha holding then fading.
    this.shipSmokePS = new ParticleSystem('shipSmoke', 600, this.scene);
    this.shipSmokePS.particleTexture = this.blobTex;
    this.shipSmokePS.emitter    = this.shipSmokeEmit;
    this.shipSmokePS.minEmitBox = new Vector3(-0.5, 0, -0.5);
    this.shipSmokePS.maxEmitBox = new Vector3( 0.5, 0.4,  0.5);
    this.shipSmokePS.addColorGradient(0.00, new Color4(0.09, 0.08, 0.07, 0.00));
    this.shipSmokePS.addColorGradient(0.10, new Color4(0.11, 0.10, 0.09, 0.74));
    this.shipSmokePS.addColorGradient(0.45, new Color4(0.14, 0.13, 0.12, 0.62));
    this.shipSmokePS.addColorGradient(1.00, new Color4(0.17, 0.17, 0.17, 0.00));
    this.shipSmokePS.addSizeGradient(0.00, 1.00, 2.00);
    this.shipSmokePS.addSizeGradient(0.40, 4.00, 6.00);
    this.shipSmokePS.addSizeGradient(1.00, 6.50, 9.50);
    this.shipSmokePS.addVelocityGradient(0.00, 1.00);
    this.shipSmokePS.addVelocityGradient(0.12, 0.20);
    this.shipSmokePS.addVelocityGradient(1.00, 0.02);
    this.shipSmokePS.minLifeTime  = 5.0;  this.shipSmokePS.maxLifeTime  = 9.0;
    this.shipSmokePS.minEmitPower = 4;    this.shipSmokePS.maxEmitPower = 12;
    this.shipSmokePS.gravity      = new Vector3(0, 0.8, 0);   // hot smoke rises slowly
    this.shipSmokePS.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
    this.shipSmokePS.renderingGroupId = 3;
    this.shipSmokePS.noiseTexture = this.smokeNoise;
    this.shipSmokePS.noiseStrength = new Vector3(2.5, 3.0, 2.5);
    this.shipSmokePS.emitRate     = 0;
    this.shipSmokePS.start();
  }

  /** Factory for one water-spout particle system (pooled so impacts don't share one). */
  private makeSplash(name: string, emit: Vector3): ParticleSystem {
    const ps = new ParticleSystem(name, 600, this.scene);
    ps.particleTexture = this.blobTex;
    ps.emitter    = emit;
    ps.minEmitBox = new Vector3(-0.4, 0, -0.4);
    ps.maxEmitBox = new Vector3( 0.4, 0.2,  0.4);
    // Fine mist: small, mostly-transparent droplets that hang and fade.
    ps.color1     = new Color4(0.82, 0.91, 1.00, 0.28);
    ps.color2     = new Color4(0.92, 0.97, 1.00, 0.18);
    ps.colorDead  = new Color4(0.86, 0.93, 1.00, 0.00);
    ps.addSizeGradient(0.0, 0.06, 0.14);   // tiny droplets
    ps.addSizeGradient(1.0, 0.35, 0.70);
    ps.minLifeTime  = 0.55;  ps.maxLifeTime  = 1.80;
    ps.minEmitPower = 6;     ps.maxEmitPower = 13;
    ps.direction1   = new Vector3(-2, 5,  -2);   // overwritten per impact
    ps.direction2   = new Vector3( 2, 10,  2);
    ps.gravity      = new Vector3(0, -46, 0);
    ps.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
    ps.renderingGroupId = 3;
    ps.emitRate     = 0;
    ps.start();
    return ps;
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private setupInput(): void {
    this.keyHandler = (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement) return;
      // Elevation: HOLD Shift to raise / Control to lower — tick() swings the angle continuously while
      // held (ignore the auto-repeat; the held flag drives it). Keyup clears the flag.
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight')     { this.elevRaiseHeld = true; return; }
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') { this.elevLowerHeld = true; return; }
      if (e.repeat) return;
      if (e.code === 'KeyZ')      this.armOrFire('port');
      else if (e.code === 'KeyC') this.armOrFire('stbd');
      else if (e.code === 'KeyG') this.toggleShotType();   // swap round ↔ bar shot
    };
    // Keyup is unconditional (no input-focus guard) so the elevation can never get stuck "held".
    this.keyUpHandler = (e: KeyboardEvent) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight')       { this.elevRaiseHeld = false; }
      else if (e.code === 'ControlLeft' || e.code === 'ControlRight') { this.elevLowerHeld = false; }
    };
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('keyup', this.keyUpHandler);
  }

  // ── Gunnery state machine (public; driven by keys + HUD) ───────────────────
  //
  // Per side: STOWED → (arm) → ARMING → READY → (fire) → FIRING → RELOADING → STOWED.
  // Animations (ports/run-out/recoil) are eased in SloopController via VesselService.

  /** Pull the LOCAL ship's gun layout from its vessel def (per-vessel battery + handedness), or fall
   *  back to the default sloop battery. Cheap; called whenever a side begins a broadside. */
  private syncGuns(): void {
    const c = this.vesselService.getCannons();
    this.muzzles = (c && c.port.length && c.stbd.length) ? c : DEFAULT_MUZZLES;
    this.gunsPerSide = Math.max(1, this.muzzles.port.length);
    this.zone.run(() => this.gunCount.set(this.gunsPerSide));
  }

  /** Size + seed a side's per-gun reload arrays for the current battery. Each gun gets a FIXED reload-time
   *  factor (its own cadence) and starts LOADED (run out + charged). */
  private armGunArrays(side: 'port' | 'stbd'): void {
    const g = this.gun[side], n = this.gunsPerSide;
    g.loadAt = new Array(n).fill(0);        // 0 ≤ elapsed → loaded
    g.loadStart = new Array(n).fill(0);
    g.fireAt = new Array(n).fill(Infinity);
    g.factor = Array.from({ length: n }, () => 1 + (Math.random() * 2 - 1) * RELOAD_VAR);
  }

  /** Z / port button, C / stbd button. ARM (run out) if stowed; otherwise FIRE every gun currently loaded. */
  armOrFire(side: 'port' | 'stbd'): void {
    const g = this.gun[side];
    if (g.state === 'stowed') {
      this.syncGuns();
      this.armGunArrays(side);
      g.state = 'arming';
      this.vesselService.setGunDeploy(side, 1);
      this.multiplayerService.broadcastGunState(side, 1);
      this.publishState(side);
    } else if (g.state === 'engaged') {
      this.fireLoaded(side);
    }
  }

  /** Queue every LOADED, not-already-firing gun on this side to fire, rippled by a human stagger (so a full
   *  battery still rolls down the side). Guns mid-reload simply don't fire → a partial broadside. */
  private fireLoaded(side: 'port' | 'stbd'): void {
    const g = this.gun[side];
    let order = 0;
    for (let i = 0; i < this.gunsPerSide; i++) {
      if (this.elapsed >= g.loadAt[i] && g.fireAt[i] === Infinity) {   // loaded + no shot already queued
        g.fireAt[i] = this.elapsed + order * (STAGGER_MIN + Math.random() * (STAGGER_MAX - STAGGER_MIN));
        order++;
      }
    }
  }

  /** Esc / stand-down: stow an arming/engaged side back to closed ports (no fire). */
  cancel(side?: 'port' | 'stbd'): void {
    const sides: ('port' | 'stbd')[] = side ? [side] : ['port', 'stbd'];
    for (const s of sides) {
      const g = this.gun[s];
      if (g.state === 'arming' || g.state === 'engaged') {
        g.state = 'stowed';
        this.vesselService.setGunDeploy(s, 0);
        this.multiplayerService.broadcastGunState(s, 0);
        this.zone.run(() => {
          (s === 'port' ? this.portReloadFrac : this.stbdReloadFrac).set(0);
          (s === 'port' ? this.portLoaded : this.stbdLoaded).set(0);
        });
        this.publishState(s);
      }
    }
  }

  /** True if any side is run out (arming/engaged) so Esc should stand down rather than pause. */
  anyCancellable(): boolean {
    return this.gun.port.state === 'arming' || this.gun.port.state === 'engaged'
        || this.gun.stbd.state === 'arming' || this.gun.stbd.state === 'engaged';
  }

  /** Map the internal run-out state + per-gun load to the HUD GunState. */
  private publishState(side: 'port' | 'stbd'): void {
    const g = this.gun[side];
    let st: GunState;
    if (g.state === 'arming') st = 'arming';
    else if (g.state !== 'engaged') st = 'stowed';
    else st = this.loadedCount(side) > 0 ? 'ready' : 'reloading';   // ≥1 loaded → can fire; else still reloading
    this.zone.run(() => (side === 'port' ? this.portGunState : this.stbdGunState).set(st));
  }

  /** How many of a side's guns are currently loaded. */
  private loadedCount(side: 'port' | 'stbd'): number {
    const g = this.gun[side];
    let n = 0;
    for (let i = 0; i < this.gunsPerSide; i++) if (this.elapsed >= g.loadAt[i]) n++;
    return n;
  }

  /** Advance one side's gunnery each frame: run-out, queued fires, and per-gun reloads. */
  private tickGun(side: 'port' | 'stbd', _dt: number): void {
    const g = this.gun[side];
    if (g.state === 'arming') {
      if (this.vesselService.isGunReady(side)) { g.state = 'engaged'; this.publishState(side); }
      return;
    }
    if (g.state !== 'engaged') return;

    const prevLoaded = this.loadedCount(side);
    // Fire any guns whose queued shot time has arrived; each then begins its own reload.
    for (let i = 0; i < this.gunsPerSide; i++) {
      if (g.fireAt[i] !== Infinity && this.elapsed >= g.fireAt[i]) {
        g.fireAt[i] = Infinity;
        this.vesselService.addCannonRecoil(side);   // hull shudder
        this.fireOneCannon(side, i);
        this.vesselService.addGunRecoilKick(side);
        this.vesselService.crewGunWork(side);        // gun crew works the piece (crew P3)
        const dur = this.vesselService.getReloadWindow() * g.factor[i] * (1 + (Math.random() * 2 - 1) * RELOAD_JITTER);
        g.loadStart[i] = this.elapsed;
        g.loadAt[i] = this.elapsed + Math.max(0.3, dur);
      }
    }

    // HUD readiness bar = mean per-gun load progress (smooth; full = whole battery loaded).
    let progSum = 0;
    for (let i = 0; i < this.gunsPerSide; i++) {
      const span = g.loadAt[i] - g.loadStart[i];
      progSum += span <= 0 ? 1 : Math.min(1, Math.max(0, (this.elapsed - g.loadStart[i]) / span));
    }
    this.zone.run(() => (side === 'port' ? this.portReloadFrac : this.stbdReloadFrac).set(progSum / this.gunsPerSide));

    // Surface the loaded count (for the pip readout); re-publish the FIRE!/Reloading… label on the 0↔≥1 boundary.
    const nowLoaded = this.loadedCount(side);
    const loadSig = side === 'port' ? this.portLoaded : this.stbdLoaded;
    if (loadSig() !== nowLoaded) this.zone.run(() => loadSig.set(nowLoaded));
    if ((prevLoaded > 0) !== (nowLoaded > 0)) this.publishState(side);
  }

  // ── Aiming aid (predicted trajectory) ───────────────────────────────────────

  /** Show/update the predicted arc per run-out side: GREEN, ending AT the target, when a lock has a firing
   *  solution; RED splashing into the sea on free aim. Hidden otherwise. */
  private updateAimArcs(): void {
    let lock: { id: string; x: number; z: number } | null = null;   // for the HUD reticle (locked ship)
    for (const side of ['port', 'stbd'] as const) {
      const tubes = this.aimTubes[side];
      const ready = this.gun[side].state === 'engaged';   // show the aim tubes whenever the battery is run out
      if (!ready) { for (const t of tubes) t.setEnabled(false); continue; }

      // Solve the lock ONCE (round/bar) — reused for every gun's arc shape, its colour, and the reticle.
      let sol: ReturnType<CannonService['solveLock']> = null;
      if (this.shotType() !== 'grape') {
        const vs = this.vesselService.state();
        const hRad = vs.heading * Math.PI / 180, sinH = Math.sin(hRad), cosH = Math.cos(hRad);
        const beamX = side === 'port' ? -cosH : cosH, beamZ = side === 'port' ? sinH : -sinH;
        sol = this.solveLock(side, vs, beamX, beamZ, this.muzzleV(), this.muzzles[side][0].y);
        if (sol && !lock) lock = { id: sol.lockId, x: sol.cx, z: sol.cz };   // park the reticle ON the locked ship
      }

      const mat     = this.aimMaterial(!!sol);   // locked → green solution arc; free → red
      const muzzles = this.muzzles[side];
      // One arc per cannon: each gun launches from its own muzzle, sharing the side's launch solution, so the
      // arcs run parallel on free aim and converge onto the lock — a sheaf that reads as the whole broadside.
      for (let i = 0; i < muzzles.length; i++) {
        // Per-cannon: only show this gun's arc if THAT gun is actually loaded (reloading guns have no arc).
        const loaded = i < this.gunsPerSide && this.elapsed >= this.gun[side].loadAt[i];
        if (!loaded) { if (tubes[i]) tubes[i].setEnabled(false); continue; }
        const path = this.buildArcPath(side, sol, muzzles[i]);
        const prev = tubes[i];
        if (prev) {
          // Reuse the geometry — same sample count, so update in place (cheap).
          const tube = MeshBuilder.CreateTube('aim_' + side + i, { path, instance: prev }, this.scene);
          tube.material = mat;                  // recolour by lock state each frame
          tube.setEnabled(true);
          tubes[i] = tube;
        } else {
          const tube = MeshBuilder.CreateTube('aim_' + side + i, {
            path, radius: AIM_RADIUS, tessellation: 6, cap: Mesh.NO_CAP, updatable: true,
          }, this.scene);
          tube.material         = mat;
          tube.isPickable       = false;
          tube.renderingGroupId = 3;        // draw over the water like the cannon FX
          tube.alphaIndex       = 0;        // behind the smoke/flame within the group
          tubes[i]              = tube;
        }
      }
      // Gun count dropped (vessel/def change): retire the surplus tubes.
      for (let i = muzzles.length; i < tubes.length; i++) tubes[i].setEnabled(false);
    }
    // World-space reticle on the locked ship (camera-facing); gentle pulse so it reads as a live lock.
    const ret = this.reticleMesh();
    if (lock) {
      ret.position.set(lock.x, this.RETICLE_Y, lock.z);
      ret.scaling.setAll(1 + 0.08 * Math.sin(this.elapsed * 6));
      if (!ret.isEnabled()) ret.setEnabled(true);
    } else if (ret.isEnabled()) {
      ret.setEnabled(false);
    }
    // Publish the lock id for any Angular HUD binding (throttled to id changes; the mesh handles per-frame motion).
    if ((this.lockTarget()?.id ?? null) !== (lock?.id ?? null)) {
      this.zone.run(() => this.lockTarget.set(lock));
    }
  }

  /**
   * Soft aim-assist: find the enemy roughly abeam on `side` (within LOCK_ARC of the beam, in range) and solve
   * the LEADING low-arc shot to it — aiming at a HEIGHT on the target chosen by gunElevDeg (waterline↔mast).
   * The azimuth correction is CLAMPED to AIM_CONE of the raw beam, so it only refines a generally-good aim
   * (you still have to bring the broadside to bear). Returns the launch direction + h/v speed split, or null
   * when there's no valid lock — in which case the caller fires straight out the beam at the manual elevation.
   * ox/oz = ship centre (so every gun + the preview share one solution); muzzleY = representative gun height.
   */
  private solveLock(side: 'port' | 'stbd', vs: { x: number; z: number; heading: number },
                    beamX: number, beamZ: number, mv: number, muzzleY: number):
                    { dirX: number; dirZ: number; vh: number; vy0: number; lockId: string; px: number; pz: number; cx: number; cz: number } | null {
    const enemies = this.multiplayerService.otherPlayers();
    if (!enemies.length) return null;
    const beamAng = Math.atan2(beamX, beamZ);
    const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));   // → [-π, π]

    // Acquire: the enemy whose bearing is closest to the beam, within the arc + range.
    let best: { id: string; x: number; z: number; heading: number; speed: number } | null = null;
    let bestOff = this.LOCK_ARC_DEG * Math.PI / 180;
    for (const e of enemies) {
      const dx = e.x - vs.x, dz = e.z - vs.z, dist = Math.hypot(dx, dz);
      if (dist < 2 || dist > this.LOCK_MAX_RANGE) continue;
      const off = Math.abs(norm(Math.atan2(dx, dz) - beamAng));
      if (off < bestOff) { bestOff = off; best = e as never; }
    }
    if (!best) return null;

    // Aim HEIGHT on the target from the manual elevation control (Shift/Ctrl, Hull/Mast presets).
    const tf   = Math.max(0, Math.min(1, (this.gunElevDeg() - this.ELEV_HULL) / (this.ELEV_MAST - this.ELEV_HULL)));
    const aimY = this.AIM_LOW_Y + (this.AIM_HIGH_Y - this.AIM_LOW_Y) * tf;
    // Target world velocity (same dead-reckoning the server adjudicator uses).
    const tvx = Math.sin(best.heading * Math.PI / 180) * best.speed * this.TRAVEL_SCALE;
    const tvz = Math.cos(best.heading * Math.PI / 180) * best.speed * this.TRAVEL_SCALE;
    const v = mv, v2 = v * v, dY = aimY - muzzleY, ox = vs.x, oz = vs.z;
    // Iterate lead → range → flight-time → re-lead, then solve the low (direct-fire) launch elevation.
    let tof = Math.hypot(best.x - ox, best.z - oz) / (v * 0.97), theta = 0, px = best.x, pz = best.z, R = 0;
    for (let k = 0; k < 3; k++) {
      px = best.x + tvx * tof; pz = best.z + tvz * tof;
      R = Math.hypot(px - ox, pz - oz);
      const disc = v2 * v2 - G * (G * R * R + 2 * dY * v2);
      if (disc < 0) return null;                                  // out of ballistic reach
      theta = Math.atan2(v2 - Math.sqrt(disc), G * R);            // low arc
      tof = R / (v * Math.cos(theta));
    }
    // Azimuth toward the lead point, CLAMPED to the cone around the beam (positioning still matters).
    const cone = this.AIM_CONE_DEG * Math.PI / 180;
    const az   = beamAng + Math.max(-cone, Math.min(cone, norm(Math.atan2(px - ox, pz - oz) - beamAng)));
    return { dirX: Math.sin(az), dirZ: Math.cos(az), vh: v * Math.cos(theta), vy0: v * Math.sin(theta), lockId: best.id, px, pz, cx: best.x, cz: best.z };
  }

  /** Sample the predicted arc this side would fly. With a lock `sol` (round/bar) it traces the SOLVED leading
   *  shot and STOPS at the target intercept (so the arc visually lands on the locked ship); free aim splashes
   *  down at the waterline. `sol` is solved once by updateAimArcs and passed in (no double-solve). */
  private buildArcPath(side: 'port' | 'stbd', sol: ReturnType<CannonService['solveLock']>, muz: Muz): Vector3[] {
    const vs   = this.vesselService.state();
    const hRad = vs.heading * Math.PI / 180;
    const sinH = Math.sin(hRad), cosH = Math.cos(hRad);

    const beamX   = side === 'port' ? -cosH :  cosH;
    const beamZ   = side === 'port' ?  sinH : -sinH;
    const elevRad = this.gunElevDeg() * Math.PI / 180;
    const mv      = this.muzzleV();

    const ox  = vs.x + muz.x * cosH + muz.z * sinH;
    const oy  = muz.y;
    const oz  = vs.z - muz.x * sinH + muz.z * cosH;

    const vh  = sol ? sol.vh  : mv * Math.cos(elevRad);
    const vy0 = sol ? sol.vy0 : mv * Math.sin(elevRad);
    const bvx = (sol ? sol.dirX : beamX) * vh, bvz = (sol ? sol.dirZ : beamZ) * vh;

    let tEnd: number;
    if (sol) {
      // Locked: stop at the intercept — time to fly the horizontal range to the lead point (vh = horiz speed).
      tEnd = Math.hypot(sol.px - ox, sol.pz - oz) / Math.max(1, vh);
    } else {
      // Free aim: solve oy + vy0·t − ½·g·t² = waterline for the splash-down time.
      const a = 0.5 * G, b = -vy0, c = AIM_WATER_Y - oy;
      const disc = b * b - 4 * a * c;
      tEnd = disc > 0 ? (-b + Math.sqrt(disc)) / (2 * a) : 2.0;
    }
    tEnd = Math.max(0.3, Math.min(tEnd, 6.0));

    const path: Vector3[] = [];
    for (let i = 0; i < AIM_SAMPLES; i++) {
      const t = (tEnd * i) / (AIM_SAMPLES - 1);
      path.push(new Vector3(ox + bvx * t, oy + vy0 * t - 0.5 * G * t * t, oz + bvz * t));
    }
    return path;
  }

  /** Self-lit translucent arc material. LOCKED = a confident GREEN solution arc (you have a firing solution);
   *  FREE = the old RED guess. Two cached materials so each side colours independently. */
  private aimMaterial(locked: boolean): StandardMaterial {
    if (locked) {
      if (!this.aimMatLock) this.aimMatLock = this.makeAimMat('aimMatLock', new Color3(0.24, 0.95, 0.40), 0.40);
      return this.aimMatLock;
    }
    if (!this.aimMat) this.aimMat = this.makeAimMat('aimMatFree', new Color3(0.95, 0.30, 0.12), 0.24);
    return this.aimMat;
  }

  private makeAimMat(name: string, color: Color3, alpha: number): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.emissiveColor   = color;
    m.diffuseColor    = new Color3(0, 0, 0);
    m.specularColor   = new Color3(0, 0, 0);
    m.disableLighting = true;
    m.alpha           = alpha;
    m.backFaceCulling = false;
    return m;
  }

  /** Lazily build the lock-reticle billboard: four amber corner-brackets on a transparent quad, camera-facing,
   *  drawn over the water. Parked on the soft-locked enemy by updateAimArcs; hidden when there's no lock. */
  private reticleMesh(): Mesh {
    if (this.reticle) return this.reticle;
    const S = 128;
    const tex = new DynamicTexture('lockReticleTex', { width: S, height: S }, this.scene, true);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(255, 90, 60, 0.98)';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    const m = 16, len = 34;
    for (const [x, y, sx, sy] of [[m, m, 1, 1], [S - m, m, -1, 1], [m, S - m, 1, -1], [S - m, S - m, -1, -1]] as const) {
      ctx.beginPath();
      ctx.moveTo(x, y + sy * len); ctx.lineTo(x, y); ctx.lineTo(x + sx * len, y);
      ctx.stroke();
    }
    tex.update();
    tex.hasAlpha = true;

    const mat = new StandardMaterial('lockReticleMat', this.scene);
    mat.emissiveTexture            = tex;   // brackets glow their own colour
    mat.diffuseTexture             = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.diffuseColor               = new Color3(0, 0, 0);
    mat.specularColor              = new Color3(0, 0, 0);
    mat.disableLighting            = true;
    mat.backFaceCulling            = false;

    const plane = MeshBuilder.CreatePlane('lockReticle', { size: 8 }, this.scene);
    plane.material         = mat;
    plane.billboardMode    = Mesh.BILLBOARDMODE_ALL;
    plane.renderingGroupId = 3;        // over the water, with the cannon FX
    plane.isPickable       = false;
    plane.setEnabled(false);
    this.reticle = plane;
    return plane;
  }

  // ── Main tick ─────────────────────────────────────────────────────────────

  private tick(dt: number): void {
    this.elapsed += dt;

    // ── Continuous gun elevation (hold Shift/Control) ────────────────────────
    const elevDir = (this.elevRaiseHeld ? 1 : 0) - (this.elevLowerHeld ? 1 : 0);
    if (elevDir !== 0) { this.elevate(elevDir * this.ELEV_RATE_DPS * dt); }

    // ── Per-side gunnery state machines ──────────────────────────────────────
    this.tickGun('port', dt);
    this.tickGun('stbd', dt);

    // ── Aiming aid: live trajectory preview for any run-out, ready side ────────
    this.updateAimArcs();

    // ── Active cannonball arcs ────────────────────────────────────────────────
    for (const ball of this.balls) {
      if (!ball.alive) continue;
      ball.t += dt;
      const bx = ball.ox + ball.vx * ball.t;
      const by = ball.oy + ball.vy * ball.t - 0.5 * G * ball.t * ball.t;
      const bz = ball.oz + ball.vz * ball.t;
      ball.mesh.position.set(bx, by, bz);
      // Round shot rolls lazily; bar shot whirls end-over-end (the bar lies along X → fast Z spin
      // throws the two heads around, plus a little Y wobble for a chaotic tumble); grape pellets buzz briskly.
      if      (ball.kind === 'bar')   { ball.mesh.rotation.z += dt * 26; ball.mesh.rotation.y += dt * 6; }
      else if (ball.kind === 'grape') { ball.mesh.rotation.z += dt * 14; }
      else                            { ball.mesh.rotation.z += dt * 5; }

      // Ship hits are adjudicated by the SERVER (combat_hit). We defer the cosmetic until
      // THIS ball has flown the server's time-of-flight, so the impact lands in sync with
      // the visible ball arriving (not instantly at the muzzle). Such a ball never splashes.
      if (ball.pendingHit) {
        if (ball.t >= (ball.hitAt ?? 0)) {
          this.executeShipHit(ball.pendingHit, ball);
          ball.pendingHit = null;
        }
        continue;
      }

      // Misses into water/land. Impact at the SURFACE the ball strikes: sea level (0) over water, or the terrain
      // TOP over land — the heightfield can be well above y=0, so testing only `by < 0.8` let the shot punch
      // through a hill and "impact" at sea level inside the land. Use the terrain height at the ball's x,z.
      const surfaceY = this.terrainService.getElevation(bx, bz);   // terrain top (land >0) / seabed (water <0)
      const groundY  = surfaceY > 0 ? surfaceY : 0;
      if ((by < groundY + 0.5 && ball.t > 0.4) || ball.t > 25) {
        this.onImpact(bx, bz, ball.vx, ball.vy - G * ball.t, ball.vz, ball.kind, groundY);
        ball.alive = false;
        ball.mesh.setEnabled(false);
      }
    }

    // ── Muzzle flash lights decay ─────────────────────────────────────────────
    this.decayFlash(this.flashPort,   this.flashPortEndT);
    this.decayFlash(this.flashStbd,   this.flashStbdEndT);
    this.decayFlash(this.shipFlash,   this.shipFlashEndT);
    for (const rig of this.remoteRigs) this.decayFlash(rig.light, rig.lightEndT);

    // ── Particle burst cutoffs ────────────────────────────────────────────────
    this.explosions?.update(dt);
    if (this.smoke) {
      // Drift the smoke downwind: wind blows FROM fromBearingDeg, so smoke travels toward from+180°, at a
      // fraction of wind speed (it's near the surface and the puffs carry their own belch velocity).
      const w = this.vesselService.getWind();
      const toRad = ((w.fromBearingDeg + 180) % 360) * Math.PI / 180;
      const drift = Math.min(w.speed, 14) * 0.3;
      this.smoke.update(dt, Math.sin(toRad) * drift, Math.cos(toRad) * drift);
    }
    if (this.flameCutoffT > 0 && this.elapsed >= this.flameCutoffT) {
      this.flamePortPS.emitRate = 0;
      this.flameStbdPS.emitRate = 0;
      this.flameCutoffT = -1;
    }
    if (this.smokeCutoffT > 0 && this.elapsed >= this.smokeCutoffT) {
      this.smokePortPS.emitRate = 0;
      this.smokeStbdPS.emitRate = 0;
      this.smokeCutoffT = -1;
    }
    if (this.lingerCutoffT > 0 && this.elapsed >= this.lingerCutoffT) {
      this.lingerPortPS.emitRate = 0;
      this.lingerStbdPS.emitRate = 0;
      this.lingerCutoffT = -1;
    }
    for (const fx of this.splashFx) {
      if (fx.startT > 0 && this.elapsed >= fx.startT) {
        fx.ps.emitRate = 3500;                  // begin this spout on its rebound
        fx.cutoffT = this.elapsed + 0.16;
        fx.startT = -1;
      }
      if (fx.cutoffT > 0 && this.elapsed >= fx.cutoffT) {
        fx.ps.emitRate = 0;
        fx.cutoffT = -1;
      }
    }
    if (this.shipDebrisCutoffT > 0 && this.elapsed >= this.shipDebrisCutoffT) {
      this.shipDebrisPS.emitRate = 0;
      this.shipDebrisCutoffT = -1;
    }
    if (this.shipFireCutoffT > 0 && this.elapsed >= this.shipFireCutoffT) {
      this.shipFirePS.emitRate = 0;
      this.shipFireCutoffT = -1;
    }
    if (this.shipSmokeCutoffT > 0 && this.elapsed >= this.shipSmokeCutoffT) {
      this.shipSmokePS.emitRate = 0;
      this.shipSmokeCutoffT = -1;
    }
    if (this.dirtCutoffT > 0 && this.elapsed >= this.dirtCutoffT) {
      this.dirtPS.emitRate = 0;
      this.dirtCutoffT = -1;
    }
    if (this.landSmokeCutoffT > 0 && this.elapsed >= this.landSmokeCutoffT) {
      this.landSmokePS.emitRate = 0;
      this.landSmokeCutoffT = -1;
    }
    // Remote rig plume cutoffs — each pooled rig ages independently.
    for (const rig of this.remoteRigs) {
      if (rig.flameCutoffT > 0 && this.elapsed >= rig.flameCutoffT) {
        rig.flamePS.emitRate = 0;
        rig.flameCutoffT = -1;
      }
      if (rig.smokeCutoffT > 0 && this.elapsed >= rig.smokeCutoffT) {
        rig.smokePS.emitRate = 0;
        rig.smokeCutoffT = -1;
      }
      if (rig.lingerCutoffT > 0 && this.elapsed >= rig.lingerCutoffT) {
        rig.lingerPS.emitRate = 0;
        rig.lingerCutoffT = -1;
      }
    }
  }

  private decayFlash(light: PointLight | null, endT: number): void {
    if (!light || endT < 0 || this.elapsed >= endT) {
      if (light) light.intensity = 0;
      return;
    }
    const env = (endT - this.elapsed) / FLASH_DUR;
    // Peak intensity (tunable): the long-range STANDARD falloff spreads this across the whole
    // ~1 km radius, so distant cliffs / enemy ships catch a fading wash of it when guns fire.
    light.intensity = env * 6.0 * (0.85 + 0.15 * Math.random());
  }

  // ── Fire one cannon of a broadside (fixed beam direction, no aiming) ────────

  private fireOneCannon(side: 'port' | 'stbd', idx: number): void {
    const vs   = this.vesselService.state();
    const hRad = vs.heading * Math.PI / 180;
    const sinH = Math.sin(hRad);
    const cosH = Math.cos(hRad);

    // Beam direction (perpendicular to the hull): port out −X, starboard out +X. Each vessel's def
    // places its muzzles on the matching side, so the ball always leaves out its own rail.
    const dirX = side === 'port' ? -cosH :  cosH;   // raw beam (muzzle FX + grape spread fire out the rail)
    const dirZ = side === 'port' ?  sinH : -sinH;
    const elevRad = this.gunElevDeg() * Math.PI / 180;
    const mv   = this.muzzleV();

    // Muzzle world position from this cannon's local offset, rotated by heading.
    const muz = this.muzzles[side][idx] ?? this.muzzles[side][0];
    const mwx = vs.x + muz.x * cosH + muz.z * sinH;
    const mwy = muz.y;
    const mwz = vs.z - muz.x * sinH + muz.z * cosH;

    const kind  = this.shotType();
    const myId  = this.multiplayerService.getMyId() ?? 'local';
    // Soft aim-assist (round/bar only): a lock leads + ranges the shot onto an enemy roughly abeam. Computed
    // from the ship centre so every gun in the broadside shares one solution (parallel converging shots).
    const sol = kind !== 'grape' ? this.solveLock(side, vs, dirX, dirZ, mv, muz.y) : null;
    // Round/bar = one shot out the beam. Grape = a fan of GRAPE_PELLETS, each its own server-adjudicated shot
    // with scattered azimuth + elevation (a true canister spread). Magnitude stays `mv`, so each pellet sits in
    // the server's grape speed band.
    const pellets = kind === 'grape' ? GRAPE_PELLETS : 1;
    for (let k = 0; k < pellets; k++) {
      let bvx: number, vyk: number, bvz: number;
      if (kind === 'grape') {
        const az = (Math.random() * 2 - 1) * GRAPE_SPREAD_RAD;   // rotate the beam in the horizontal plane
        const ca = Math.cos(az), sa = Math.sin(az);
        const ddx = dirX * ca - dirZ * sa, ddz = dirX * sa + dirZ * ca;
        const el  = elevRad + (Math.random() * 2 - 1) * GRAPE_ELEV_RAD;
        const vh  = mv * Math.cos(el); vyk = mv * Math.sin(el);
        bvx = ddx * vh; bvz = ddz * vh;
      } else if (sol) {
        bvx = sol.dirX * sol.vh; vyk = sol.vy0; bvz = sol.dirZ * sol.vh;   // leading, range-correct solution
      } else {
        const vh = mv * Math.cos(elevRad); vyk = mv * Math.sin(elevRad);
        bvx = dirX * vh; bvz = dirZ * vh;                                  // straight out the beam (no lock)
      }
      const seq = ++this.shotSeq;
      this.launchBall(mwx, mwy, mwz, bvx, vyk, bvz, myId, seq, kind);
      this.multiplayerService.broadcastShot(mwx, mwy, mwz, bvx, vyk, bvz, seq, kind);
    }
    this.birds.startleAt(mwx, mwz);   // the bang flushes nearby resting gulls
    this.dolphins.scatterFrom(mwx, mwz);   // …and sends nearby dolphins bolting
    this.fishSchool.scatterFrom(mwx, mwz);   // …and scatters the bait-fish schools
    this.oceanService.startleFish(mwx, mwz);   // …and scatters the drifting shallow-water fish
    this.muzzleEffect(side, mwx, mwy, mwz, dirX, dirZ);
    this.playCannonSound();
  }

  /** Flash + flame core + smoke fountain + lingering cloud, blasting out the beam. */
  private muzzleEffect(side: 'port' | 'stbd', mwx: number, mwy: number, mwz: number, dirX: number, dirZ: number): void {
    const isPort   = side === 'port';
    const flamePS  = isPort ? this.flamePortPS  : this.flameStbdPS;
    const smokePS  = isPort ? this.smokePortPS  : this.smokeStbdPS;
    const lingerPS = isPort ? this.lingerPortPS : this.lingerStbdPS;
    const flash    = isPort ? this.flashPort    : this.flashStbd;
    const fEmit    = isPort ? this.flamePortEmit  : this.flameStbdEmit;
    const sEmit    = isPort ? this.smokePortEmit  : this.smokeStbdEmit;
    const lEmit    = isPort ? this.lingerPortEmit : this.lingerStbdEmit;

    // Muzzle-flash point light (a touch longer than before).
    flash.position.set(mwx, mwy, mwz);
    if (isPort) this.flashPortEndT = this.elapsed + FLASH_DUR;
    else        this.flashStbdEndT = this.elapsed + FLASH_DUR;
    // Warm glow on the sea below the muzzle (the point light can't light the emissive ocean).
    // Pass the beam direction so the hull masks the glow to the firing side (no cross-deck bleed).
    this.oceanService.addCannonFlash(mwx, mwz, dirX, dirZ);

    // 1) Muzzle fireball — a volumetric raymarched billboard at the barrel mouth (default); the legacy
    //    additive flame jet is the opt-out fallback (localStorage.ignis_muzzle='particles').
    if (this.explosions) {
      this.explosions.spawn(mwx + dirX * 0.5, mwy + 0.1, mwz + dirZ * 0.5);
    } else {
      const fSpread = 0.16;
      flamePS.direction1.set(dirX - fSpread, 0.04, dirZ - fSpread);
      flamePS.direction2.set(dirX + fSpread, 0.30, dirZ + fSpread);
      fEmit.set(mwx, mwy, mwz);
      flamePS.emitRate  = 1800;
      this.flameCutoffT = this.elapsed + 0.22;
    }

    // 2) Smoke belch — shader puffs (default) rising/drifting out the barrel, else the legacy fountain PS.
    const sSpread = 0.32;
    if (this.smoke) {
      this.smoke.belch(mwx + dirX * 0.3, mwy, mwz + dirZ * 0.3, dirX, dirZ);
    } else {
      smokePS.direction1.set(dirX * 1.0 - sSpread, 0.12, dirZ * 1.0 - sSpread);
      smokePS.direction2.set(dirX * 1.5 + sSpread, 0.55, dirZ * 1.5 + sSpread);
      sEmit.set(mwx + dirX * 0.3, mwy, mwz + dirZ * 0.3);
      smokePS.emitRate  = 850;
      this.smokeCutoffT = this.elapsed + 0.55;
    }

    // 3) Lingering pall — shader puffs (default) that hang + drift, else the legacy linger PS.
    if (this.smoke) {
      this.smoke.pall(mwx + dirX * 0.3, mwy + 0.2, mwz + dirZ * 0.3, dirX, dirZ);
    } else {
      lEmit.set(mwx + dirX * 0.3, mwy + 0.2, mwz + dirZ * 0.3);
      lingerPS.direction1.set(dirX * 1.0 - sSpread, 0.10, dirZ * 1.0 - sSpread);
      lingerPS.direction2.set(dirX * 1.5 + sSpread, 0.65, dirZ * 1.5 + sSpread);
      lingerPS.emitRate  = 120;
      this.lingerCutoffT = this.elapsed + 0.55;
    }
  }

  /**
   * Get the muzzle rig owning this remote shooter, assigning one on first fire. Sticky per shooter
   * (so a ship's staggered broadside reuses its own rig); when the pool is exhausted the least
   * recently used rig is recycled.
   */
  private acquireRemoteRig(shooterId: string): RemoteMuzzleRig {
    const owned = this.remoteRigByShooter.get(shooterId);
    if (owned !== undefined) {
      this.remoteRigs[owned].lastUsed = ++this.remoteRigClock;
      return this.remoteRigs[owned];
    }
    // Prefer a free rig; otherwise evict the least-recently-used one.
    let idx = this.remoteRigs.findIndex(r => r.shooterId === null);
    if (idx < 0) {
      idx = 0;
      for (let i = 1; i < this.remoteRigs.length; i++) {
        if (this.remoteRigs[i].lastUsed < this.remoteRigs[idx].lastUsed) idx = i;
      }
      const evicted = this.remoteRigs[idx].shooterId;
      if (evicted !== null) this.remoteRigByShooter.delete(evicted);
    }
    const rig = this.remoteRigs[idx];
    rig.shooterId = shooterId;
    rig.lastUsed  = ++this.remoteRigClock;
    this.remoteRigByShooter.set(shooterId, idx);
    return rig;
  }

  private fireRemoteEffect(
    shooterId: string, ox: number, oy: number, oz: number, vx: number, vz: number,
  ): void {
    const hLen = Math.sqrt(vx * vx + vz * vz);
    if (hLen < 0.001) return;
    const dx = vx / hLen;
    const dz = vz / hLen;

    const rig = this.acquireRemoteRig(shooterId);

    // Muzzle flash
    rig.light?.position.set(ox, oy, oz);
    rig.lightEndT = this.elapsed + FLASH_DUR;
    // Warm glow on the sea below the remote muzzle too (dx,dz is the unit beam direction).
    this.oceanService.addCannonFlash(ox, oz, dx, dz);

    // 1) Muzzle fireball — volumetric billboard (default) or the legacy flame jet (opt-out fallback).
    if (this.explosions) {
      this.explosions.spawn(ox + dx * 0.5, oy + 0.1, oz + dz * 0.5);
    } else {
      const fSpread = 0.16;
      rig.flamePS.direction1.set(dx - fSpread, 0.04, dz - fSpread);
      rig.flamePS.direction2.set(dx + fSpread, 0.30, dz + fSpread);
      rig.flameEmit.set(ox, oy, oz);
      rig.flamePS.emitRate = 1800;
      rig.flameCutoffT = this.elapsed + 0.22;
    }

    // 2) Smoke belch — shader puffs (default) or the legacy fountain PS (opt-out fallback).
    const sSpread = 0.32;
    if (this.smoke) {
      this.smoke.belch(ox + dx * 0.3, oy, oz + dz * 0.3, dx, dz);
    } else {
      rig.smokePS.direction1.set(dx * 1.0 - sSpread, 0.12, dz * 1.0 - sSpread);
      rig.smokePS.direction2.set(dx * 1.5 + sSpread, 0.55, dz * 1.5 + sSpread);
      rig.smokeEmit.set(ox + dx * 0.3, oy, oz + dz * 0.3);
      rig.smokePS.emitRate = 850;
      rig.smokeCutoffT = this.elapsed + 0.55;
    }

    // 3) Lingering pall — shader puffs (default) or the legacy linger PS (opt-out fallback).
    if (this.smoke) {
      this.smoke.pall(ox + dx * 0.3, oy + 0.2, oz + dz * 0.3, dx, dz);
    } else {
      rig.lingerEmit.set(ox + dx * 0.3, oy + 0.2, oz + dz * 0.3);
      rig.lingerPS.direction1.set(dx * 1.0 - sSpread, 0.10, dz * 1.0 - sSpread);
      rig.lingerPS.direction2.set(dx * 1.5 + sSpread, 0.65, dz * 1.5 + sSpread);
      rig.lingerPS.emitRate = 120;
      rig.lingerCutoffT = this.elapsed + 0.55;
    }

    // Recoil on the firing vessel
    this.multiplayerService.applyRemoteRecoil(ox, oz);

    // Distance-attenuated cannon sound
    const vs     = this.vesselService.state();
    const distSq = (ox - vs.x) ** 2 + (oz - vs.z) ** 2;
    const vol    = Math.max(0, 1 - Math.sqrt(distSq) / 800);
    if (vol > 0.01) this.playCannonSound(vol);
  }

  launchBall(
    ox: number, oy: number, oz: number,
    vx: number, vy: number, vz: number,
    shooterId = 'local', seq = 0, kind: ShotKind = 'round',
  ): void {
    const ball = this.balls.find(b => !b.alive);
    if (!ball) return;
    Object.assign(ball, { ox, oy, oz, vx, vy, vz, t: 0, alive: true, kind, key: `${shooterId}:${seq}`, pendingHit: null, hitAt: 0 });
    ball.mesh.position.set(ox, oy, oz);
    ball.mesh.rotation.setAll(0);
    const isBar = kind === 'bar';
    ball.mesh.isVisible    = !isBar;   // round + grape = the sphere; bar = hide it, show the dumbbell
    ball.barMesh.isVisible = isBar;
    ball.mesh.scaling.setAll(kind === 'grape' ? 0.4 : 1);   // grape = a small pellet
    ball.mesh.setEnabled(true);
  }

  // ── Sound effects ─────────────────────────────────────────────────────────

  /** Build the cannon audio bus: dry → limiter, plus a parallel convolver reverb. */
  private buildCannonAudio(): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    const dest = this.sfxMaster ?? ctx.destination;

    // Limiter — catches the summed peaks of overlapping shots so a broadside lands
    // powerful but never ear-piercing. Fast attack; release kept long so the reverb
    // tail isn't pumped/ducked.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value      = 6;
    limiter.ratio.value     = 16;
    limiter.attack.value    = 0.002;
    limiter.release.value   = 0.30;
    limiter.connect(dest);

    // Reverb chain (parallel wet path): pre-delay → long slow convolver → darkening
    // lowpass → wet gain → limiter. A 5 s, slow-decaying impulse plus pre-delay makes
    // the boom BLOOM and roll out across the bay for seconds instead of stopping dead
    // like a drum hit. The lowpass keeps the long tail dark/distant, not hissy.
    const preDelay = ctx.createDelay(0.5);
    preDelay.delayTime.value = 0.09;

    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeReverbIR(ctx, 5.0, 1.3);

    const dark = ctx.createBiquadFilter(); dark.type = 'lowpass';
    dark.frequency.value = 1500;

    const wet = ctx.createGain();
    wet.gain.value = 1.0;

    preDelay.connect(reverb); reverb.connect(dark); dark.connect(wet); wet.connect(limiter);

    const send = ctx.createGain();
    send.gain.value = 1.0;
    send.connect(preDelay);

    const bus = ctx.createGain();
    bus.gain.value = 1.0;
    bus.connect(limiter);   // dry
    bus.connect(send);      // wet
    this.cannonBus = bus;
  }

  /** Exponentially-decaying stereo noise → a natural reverb impulse response. */
  private makeReverbIR(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const ir  = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, decay);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return ir;
  }

  // A deep, powerful cannon shot: a sharp ignition BANG, a throaty down-swept BLAST,
  // a pitched PUNCH, a controlled SUB chest-thump, and a long ROLL that the bus
  // reverb turns into rolling reverberation. The limiter keeps three-in-a-row safe.
  private playCannonSound(vol = 1.0): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const out = this.cannonBus ?? this.sfxMaster ?? ctx.destination;
    const t   = ctx.currentTime;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    const noise = (secs: number): AudioBufferSourceNode => {
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * secs)), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf;
      return src;
    };

    // 1) BANG — sharp ignition transient: bright but very short.
    {
      const src = noise(0.06);
      const bp  = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = rnd(1400, 2200); bp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.85 * vol, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(t); src.stop(t + 0.07);
    }

    // 2) BLAST — lowpassed noise sweeping down hard: the throaty roar of the powder.
    {
      const src = noise(0.7);
      const lp  = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(rnd(800, 1000), t);
      lp.frequency.exponentialRampToValueAtTime(85, t + 0.45);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.6 * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.62);
      src.connect(lp); lp.connect(g); g.connect(out);
      src.start(t); src.stop(t + 0.7);
    }

    // 3) PUNCH — a pitched thump for the percussive hit.
    {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(rnd(105, 125), t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.0 * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.33);
    }

    // 4) SUB — the deep chest-thump that makes it feel powerful (kept controlled).
    {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(rnd(58, 66), t);
      osc.frequency.exponentialRampToValueAtTime(24, t + 0.55);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9 * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.95);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.97);
    }

    // 5) ROLL — a long, sustained low rumble. Fed through the bus reverb it becomes
    //    the boom rolling out across the water for several seconds (the part that
    //    turns a "drum hit" into a "cannon"). Two stages: a near growl then a long
    //    decaying thunder.
    {
      const src = noise(1.7);
      const lp  = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(380, t);
      lp.frequency.exponentialRampToValueAtTime(95, t + 1.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.72 * vol, t + 0.05);
      g.gain.setTargetAtTime(0.0, t + 0.28, 0.42);   // tighter thunder decay (less breathy tail)
      src.connect(lp); lp.connect(g); g.connect(out);
      src.start(t); src.stop(t + 1.7);
    }
  }

  /** A one-shot white-noise buffer source of `secs` length. */
  private noiseSource(secs: number): AudioBufferSourceNode | null {
    const ctx = this.sfxCtx;
    if (!ctx) return null;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * secs)), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    return src;
  }

  // Water impact: a heavy GOOSH (resonant pitch-dropping plunge + low whoomp + sub)
  // followed by a FOAMY SPRAY hiss that swells just after and rains back down.
  private playSplashSound(vol = 1.0): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const out = this.cannonBus ?? this.sfxMaster ?? ctx.destination;
    const t   = ctx.currentTime;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    // resonant "gloop" — bandpass noise sweeping down (the watery plunge)
    {
      const src = this.noiseSource(0.5); if (!src) return;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4.0;
      bp.frequency.setValueAtTime(rnd(520, 640), t);
      bp.frequency.exponentialRampToValueAtTime(120, t + 0.30);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.5 * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(t); src.stop(t + 0.5);
    }
    // low whoomp — displaced water mass
    {
      const src = this.noiseSource(0.5); if (!src) return;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(700, t);
      lp.frequency.exponentialRampToValueAtTime(110, t + 0.32);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.1 * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      src.connect(lp); lp.connect(g); g.connect(out);
      src.start(t); src.stop(t + 0.5);
    }
    // sub thump — the impact weight
    {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(rnd(85, 100), t);
      osc.frequency.exponentialRampToValueAtTime(34, t + 0.22);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.85 * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.40);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.42);
    }
    // foamy spray — bright bubbly hiss that swells in then rains down (~1 s)
    {
      const src = this.noiseSource(1.2); if (!src) return;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2400;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';  lp.frequency.value = 8500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.55 * vol, t + 0.10);
      g.gain.setTargetAtTime(0.0, t + 0.24, 0.34);
      src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(out);
      src.start(t); src.stop(t + 1.2);
    }
  }

  // Land impact: a hard THUD (sub drop + gritty crack) then a CLATTER of debris —
  // a scatter of short filtered ticks settling over ~0.9 s.
  private playLandImpactSound(vol = 1.0): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const out = this.cannonBus ?? this.sfxMaster ?? ctx.destination;
    const t   = ctx.currentTime;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    // hard thud — sub sine drop
    {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(rnd(120, 140), t);
      osc.frequency.exponentialRampToValueAtTime(32, t + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.35 * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.36);
    }
    // gritty crack of the strike
    {
      const src = this.noiseSource(0.18); if (!src) return;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2800, t);
      lp.frequency.exponentialRampToValueAtTime(400, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.1 * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      src.connect(lp); lp.connect(g); g.connect(out);
      src.start(t); src.stop(t + 0.18);
    }
    // clatter — a scatter of short ticks (falling debris) over ~0.9 s
    {
      for (let k = 0; k < 9; k++) {
        const dt  = rnd(0.06, 0.85);
        const src = this.noiseSource(0.06); if (!src) continue;
        const bp  = ctx.createBiquadFilter(); bp.type = 'bandpass';
        bp.frequency.value = rnd(800, 3200); bp.Q.value = rnd(2, 6);
        const g = ctx.createGain();
        const amp = rnd(0.12, 0.40) * vol * (1 - dt);   // later ticks softer
        g.gain.setValueAtTime(0.0, t + dt);
        g.gain.linearRampToValueAtTime(Math.max(0.02, amp), t + dt + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.05);
        src.connect(bp); bp.connect(g); g.connect(out);
        src.start(t + dt); src.stop(t + dt + 0.07);
      }
    }
  }

  // Ship hit: the hard land-impact sound PLUS a timber CRACK and a longer shatter of
  // woody splinter ticks — the sound of multiple pieces of hull breaking apart.
  private playShipHitSound(vol = 1.0): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    this.playLandImpactSound(vol);   // base hard impact (thud + debris clatter)
    if (ctx.state === 'suspended') ctx.resume();
    const out = this.cannonBus ?? this.sfxMaster ?? ctx.destination;
    const t   = ctx.currentTime;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    // CRUNCH — the ball crushing into the planking: a dense, crackly burst (sparse
    // sharp clicks packed together) band-passed into the woody range and decaying.
    // Two passes (the hit, then the timber giving way) for a hit-then-break read.
    const crunch = (delay: number, secs: number, fLo: number, fHi: number, gain: number) => {
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * secs)), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const env   = Math.pow(1 - i / d.length, 1.6);
        const spike = Math.random() < 0.07 ? (Math.random() * 2 - 1) : (Math.random() * 2 - 1) * 0.22;
        d[i] = spike * env;
      }
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp  = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(fHi, t + delay);
      bp.frequency.exponentialRampToValueAtTime(fLo, t + delay + secs * 0.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * vol, t + delay);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + secs);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(t + delay); src.stop(t + delay + secs + 0.02);
    };
    crunch(0.00, 0.30, 240, 1100, 1.5);   // crushing impact
    crunch(0.10, 0.34, 180,  800, 1.0);   // planking caving in

    // sharp splintering crack(s) — the timber giving way
    for (let k = 0; k < 4; k++) {
      const dt  = k * 0.045;
      const src = this.noiseSource(0.10); if (!src) continue;
      const bp  = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(rnd(900, 1500), t + dt);
      bp.frequency.exponentialRampToValueAtTime(rnd(300, 500), t + dt + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t + dt);
      g.gain.linearRampToValueAtTime(0.9 * vol, t + dt + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.10);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(t + dt); src.stop(t + dt + 0.11);
    }
    // shattering wood pieces — many short woody ticks over ~1.1 s
    for (let k = 0; k < 18; k++) {
      const dt  = rnd(0.02, 1.10);
      const src = this.noiseSource(0.05); if (!src) continue;
      const bp  = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = rnd(260, 1900); bp.Q.value = rnd(3, 9);
      const g = ctx.createGain();
      const amp = rnd(0.10, 0.35) * vol * (1 - dt / 1.2);
      g.gain.setValueAtTime(0.0, t + dt);
      g.gain.linearRampToValueAtTime(Math.max(0.02, amp), t + dt + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.05);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(t + dt); src.stop(t + dt + 0.07);
    }
  }

  // ── Server-adjudicated ship hit (authoritative) ─────────────────────────────

  /**
   * A server-confirmed hit. The server's adjudication already accounts for the ball's
   * flight time, so we DEFER the cosmetic until the matching in-flight ball has actually
   * flown that long (`tof`) — the impact then lands in sync with the visible ball arriving,
   * instead of instantly at the muzzle while a sibling miss splashes seconds later. If the
   * ball is missing or already past its tof (e.g. high latency), play it immediately.
   */
  private onCombatHit(msg: CombatHitMsg): void {
    const ball = this.balls.find(b => b.alive && b.key === `${msg.shooterId}:${msg.seq}`);
    if (ball && typeof msg.tof === 'number' && ball.t < msg.tof) {
      ball.pendingHit = msg;          // fired from the tick once ball.t reaches tof
      ball.hitAt = msg.tof;
      return;
    }
    this.executeShipHit(msg, ball ?? null);
  }

  /**
   * Play the authoritative ship-hit reaction: shudder the struck ship, refine the impact
   * onto the actual hull surface (mesh raycast along the ball's incoming line), burn a
   * scorch mark, play the splinter/fire cosmetic, and despawn the matching ball.
   */
  private executeShipHit(msg: CombatHitMsg, ball: Ball | null): void {
    // Shudder the struck ship — deferred to here so the lurch coincides with the impact.
    const side: 'port' | 'stbd' = msg.side === 'port' ? 'port' : 'stbd';
    if (msg.victimId === this.multiplayerService.getMyId()) this.vesselService.addHitShudder(side);
    else                                                     this.multiplayerService.applyHitShudder(String(msg.victimId), side);

    const myId = this.multiplayerService.getMyId();
    const shipRoot: TransformNode | null = msg.victimId === myId
      ? this.vesselService.getRoot()
      : this.multiplayerService.getRemoteRoot(msg.victimId);

    // Incoming direction from the matching ball (then despawn it); else shooter→impact.
    let dirX = 0, dirY = -1, dirZ = 0;
    if (ball) {
      const vyi = ball.vy - G * ball.t;
      const l = Math.hypot(ball.vx, vyi, ball.vz) || 1;
      dirX = ball.vx / l; dirY = vyi / l; dirZ = ball.vz / l;
      ball.alive = false;
      ball.mesh.setEnabled(false);
    } else {
      const sRoot = msg.shooterId === myId
        ? this.vesselService.getRoot()
        : this.multiplayerService.getRemoteRoot(msg.shooterId);
      if (sRoot) {
        const dx = msg.hx - sRoot.position.x, dy = msg.hy - sRoot.position.y, dz = msg.hz - sRoot.position.z;
        const l = Math.hypot(dx, dy, dz) || 1;
        dirX = dx / l; dirY = dy / l; dirZ = dz / l;
      }
    }

    // Raycast onto the hull for the exact surface point; fall back to the server point.
    let px = msg.hx, py = msg.hy, pz = msg.hz;
    if (shipRoot) {
      const start = new Vector3(px - dirX * 6, py - dirY * 6, pz - dirZ * 6);
      const pick = this.scene.pickWithRay(
        new Ray(start, new Vector3(dirX, dirY, dirZ), 12),
        (m) => this.isUnder(m, shipRoot),
      );
      if (pick?.hit && pick.pickedPoint) {
        px = pick.pickedPoint.x; py = pick.pickedPoint.y; pz = pick.pickedPoint.z;
        // Burn a lasting scorch mark onto the actual surface we struck — but NOT for grapeshot, which peppers
        // the crew, not the timbers (no hull damage → no char).
        if (pick.pickedMesh && !msg.grape) {
          const n = pick.getNormal(true) ?? new Vector3(-dirX, -dirY, -dirZ);
          const small = msg.zone === 'masts';
          this.addScorchDecal(String(msg.victimId), pick.pickedMesh, pick.pickedPoint, n, small);
        }
      }
    }

    this.playShipHitCosmetic(px, py, pz, dirX, dirY, dirZ);
  }

  /**
   * Project a charred scorch decal onto the struck mesh at `point`, facing `normal`.
   * Parented to the mesh so it sails with the ship; persists until the ship is repaired.
   * Oldest decals fade off once a ship accrues more than `DECAL_MAX_PER_SHIP`.
   */
  private addScorchDecal(
    victimId: string, target: AbstractMesh, point: Vector3, normal: Vector3, small: boolean,
  ): void {
    this.ensureScorchMat();
    if (!this.scorchMat) return;

    const base = small ? 0.55 : 1.35;
    const s = base * (0.82 + Math.random() * 0.36);
    let decal: Mesh;
    try {
      decal = MeshBuilder.CreateDecal('scorch', target as Mesh, {
        position: point,
        normal,
        size: new Vector3(s, s, Math.max(0.6, s * 0.7)),
        angle: Math.random() * Math.PI * 2,
        cullBackFaces: true,
      });
    } catch {
      return; // skinned/degenerate target the projector can't handle — skip the mark
    }
    decal.material        = this.scorchMat;
    decal.isPickable      = false;
    decal.receiveShadows  = true;
    decal.renderingGroupId = target.renderingGroupId;
    decal.setParent(target);   // follow the hull as it moves

    const list = this.decals.get(victimId) ?? [];
    list.push(decal);
    while (list.length > DECAL_MAX_PER_SHIP) list.shift()?.dispose();
    this.decals.set(victimId, list);
  }

  /** Remove every scorch decal on a ship (called when that ship repairs to full). */
  private clearShipDecals(victimId: string): void {
    const list = this.decals.get(victimId);
    if (!list) return;
    for (const d of list) d.dispose();
    this.decals.delete(victimId);
  }

  /** Lazily build the shared scorch material: charred radial albedo + a dented normal map. */
  private ensureScorchMat(): void {
    if (this.scorchMat) return;
    const S = 128, cx = S / 2, cy = S / 2;

    // Albedo — overlapping ragged char blotches with an alpha falloff to the rim.
    const alb = new DynamicTexture('scorchAlb', { width: S, height: S }, this.scene, true);
    const ctx = alb.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, S, S);
    for (let i = 0; i < 5; i++) {
      const a  = (i / 5) * Math.PI * 2;
      const ox = cx + Math.cos(a) * S * 0.10, oy = cy + Math.sin(a) * S * 0.10;
      const r  = S * (0.34 + Math.random() * 0.10);
      const g  = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
      g.addColorStop(0,    'rgba(8,6,5,0.96)');
      g.addColorStop(0.5,  'rgba(20,15,12,0.78)');
      g.addColorStop(0.85, 'rgba(36,27,20,0.30)');
      g.addColorStop(1,    'rgba(40,30,22,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.fill();
    }
    // Faint warm rim to read as a singed, raised lip around the burn.
    const rim = ctx.createRadialGradient(cx, cy, S * 0.18, cx, cy, S * 0.30);
    rim.addColorStop(0,   'rgba(0,0,0,0)');
    rim.addColorStop(0.6, 'rgba(74,42,20,0.20)');
    rim.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = rim; ctx.fillRect(0, 0, S, S);
    alb.hasAlpha = true;
    alb.update();

    // Normal map — a central pit so light catches a shallow dent in the planking.
    const bump = new DynamicTexture('scorchBump', { width: S, height: S }, this.scene, false);
    const bctx = bump.getContext() as CanvasRenderingContext2D;
    const img  = bctx.createImageData(S, S);
    const R2   = (S * 0.42) * (S * 0.42);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
      const slope = (2 / R2) * Math.exp(-(r * r) / R2);   // |d height / d r| of a Gaussian pit
      let nx = r > 0.001 ? (dx / r) * slope * 38 : 0;
      let ny = r > 0.001 ? (dy / r) * slope * 38 : 0;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv; ny *= inv;
      const o = (y * S + x) * 4;
      img.data[o]     = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      img.data[o + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);
    bump.update();

    const mat = new StandardMaterial('scorchMat', this.scene);
    mat.diffuseTexture            = alb;
    mat.diffuseColor              = new Color3(1, 1, 1);
    mat.specularColor             = new Color3(0.03, 0.03, 0.03);
    mat.bumpTexture               = bump;
    mat.useAlphaFromDiffuseTexture = true;
    mat.zOffset                   = -2;   // lift off the hull to beat z-fighting
    this.scorchMat = mat;
  }

  /** True if `mesh` is `root` or one of its descendants. */
  private isUnder(mesh: AbstractMesh, root: TransformNode): boolean {
    let n: TransformNode | null = mesh;
    while (n) { if (n === root) return true; n = n.parent as TransformNode | null; }
    return false;
  }

  /** Unit reverse of a ball's incoming velocity (its entry direction + angle, flipped). */
  private reverseDir(vx: number, vyImpact: number, vz: number): [number, number, number] {
    const l = Math.hypot(vx, vyImpact, vz) || 1;
    return [-vx / l, -vyImpact / l, -vz / l];
  }

  /** Aim a particle system's emission cone along (rx,ry,rz): throw speed `spd`,
   *  horizontal spread `spr`, vertical spread `sprY`, plus an extra upward bias. */
  private setCone(
    ps: ParticleSystem, rx: number, ry: number, rz: number,
    spd: number, spr: number, sprY: number, upBias = 0,
  ): void {
    ps.direction1.set(rx * spd - spr, ry * spd + upBias - sprY, rz * spd - spr);
    ps.direction2.set(rx * spd + spr, ry * spd + upBias + sprY, rz * spd + spr);
  }

  /** Wood splinters + fire gust + flash + dust + smoke for a ship hit at a world point,
   *  sprayed back along the reverse of the ball's incoming direction (dirX,dirY,dirZ). */
  private playShipHitCosmetic(px: number, py: number, pz: number, dirX: number, dirY: number, dirZ: number): void {
    const vs   = this.vesselService.state();
    const dist = Math.hypot(px - vs.x, pz - vs.z);
    const vol  = Math.max(0, 1 - dist / 800);

    this.shipDebrisEmit.set(px, py, pz);
    this.dirtEmit.set(px, py, pz);
    this.landSmokeEmit.set(px, py, pz);

    // Reverse-incoming: splinters/dust burst back out of the entry, close in.
    const rx = -dirX, ry = -dirY, rz = -dirZ;
    this.setCone(this.shipDebrisPS, rx, ry, rz, 1.1, 0.65, 0.45);
    this.setCone(this.dirtPS,       rx, ry, rz, 0.85, 0.55, 0.40);
    this.setCone(this.landSmokePS,  rx, ry, rz, 0.45, 0.35, 0.25);

    this.shipDebrisPS.emitRate = 3200;
    this.shipDebrisCutoffT     = this.elapsed + 0.14;
    this.dirtPS.emitRate       = 2200;
    this.dirtCutoffT           = this.elapsed + 0.14;
    this.landSmokePS.emitRate  = 200;
    this.landSmokeCutoffT      = this.elapsed + 0.5;

    // Black sooty smoke that hangs over the strike for several seconds.
    this.shipSmokeEmit.set(px, py + 0.4, pz);
    this.shipSmokePS.direction1.set(rx * 0.7 - 0.5, 0.7, rz * 0.7 - 0.5);
    this.shipSmokePS.direction2.set(rx * 0.7 + 0.5, 1.8, rz * 0.7 + 0.5);
    this.shipSmokePS.emitRate  = 170;
    this.shipSmokeCutoffT      = this.elapsed + 0.6;

    // Quick gust of fire + a flash of light at the strike point.
    this.shipFireEmit.set(px, py, pz);
    this.setCone(this.shipFirePS, rx, ry, rz, 0.75, 0.45, 0.35);
    this.shipFirePS.emitRate = 1600;
    this.shipFireCutoffT     = this.elapsed + 0.10;
    this.shipFlash.position.set(px, py, pz);
    this.shipFlashEndT       = this.elapsed + FLASH_DUR;

    if (vol > 0.01) this.playShipHitSound(vol);
  }

  // ── Impact ────────────────────────────────────────────────────────────────

  private onImpact(wx: number, wz: number, vx: number, vyImpact: number, vz: number,
                   kind: ShotKind, groundY: number): void {
    // Reverse-incoming cone: ejecta sprays back along the ball's entry angle, flipped.
    const [rx, ry, rz] = this.reverseDir(vx, vyImpact, vz);

    // Distance-attenuate the impact sound by how far it landed from the player.
    const vs   = this.vesselService.state();
    const dist = Math.hypot(wx - vs.x, wz - vs.z);
    const vol  = Math.max(0, 1 - dist / 800);

    const isLand = this.terrainService.isOnLand(wx, wz);
    if (isLand) {
      // Dust thrown BACK along the entry line (plus a little lift), not a vertical column. Spawned at the terrain
      // SURFACE height (groundY) so a hillside hit kicks dust up on the slope, not down at sea level.
      this.setCone(this.dirtPS, rx, ry, rz, 1.2, 0.65, 0.45, 0.5);
      this.dirtEmit.set(wx, groundY + 0.6, wz);
      this.dirtPS.emitRate = 2400;
      this.dirtCutoffT     = this.elapsed + 0.16;
      // Lingering dust pall: drifts back along the entry then hangs (dusty browns).
      this.setCone(this.landSmokePS, rx, ry, rz, 0.5, 0.35, 0.25, 0.2);
      this.landSmokeEmit.set(wx, groundY + 0.7, wz);
      this.landSmokePS.emitRate  = 220;
      this.landSmokeCutoffT      = this.elapsed + 0.5;
      if (vol > 0.01) this.playLandImpactSound(vol);
    } else if (kind === 'grape') {
      // Grapeshot pellets prick the surface — NOT the heavy round/bar plunge. A tiny rain-drop ripple (no geyser
      // column, no spout particles) + a soft high patter (throttled, since a volley lands many pellets at once).
      this.oceanService.addSplash(wx, wz, 0.18);
      if (vol > 0.01 && this.elapsed - this._lastGrapeSplashSound > 0.18) {
        this._lastGrapeSplashSound = this.elapsed;
        this.playGrapeWaterSound(vol);
      }
    } else {
      // Round/bar: spray thrown BACK along the entry (toward where the ball came from) plus an
      // upward bias so it still reads as a spout; strong gravity arcs it back down.
      const fx = this.splashFx.find(f => f.startT < 0 && f.cutoffT < 0) ?? this.splashFx[0];
      this.setCone(fx.ps, rx, ry, rz, 1.1, 0.65, 0.7, 1.1);
      fx.emit.set(wx, 0.25, wz);
      // Spout rises only as the crater REBOUNDS. The surface dwells in its dip
      // longer, so wait until it starts bouncing back (~0.35 s) before erupting.
      fx.startT = this.elapsed + 0.35;
      // Punch the actual ocean surface (crater first, then geyser); shown the same on
      // every client (each simulates the ball locally).
      this.oceanService.addSplash(wx, wz);
      if (vol > 0.01) this.playSplashSound(vol);
    }
  }

  private _lastGrapeSplashSound = -1;

  /** Soft, brief high "patter/hiss" of grape pellets pricking the water — no deep plunge of a round/bar splash. */
  private playGrapeWaterSound(vol = 1.0): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const out = this.cannonBus ?? this.sfxMaster ?? ctx.destination;
    const t   = ctx.currentTime;
    const src = this.noiseSource(0.25); if (!src) return;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1700;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7; bp.frequency.value = 3000;
    const g  = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5 * vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out);
    src.start(t); src.stop(t + 0.2);
  }
}
