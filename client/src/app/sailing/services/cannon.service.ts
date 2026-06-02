import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  Scene, Mesh, MeshBuilder, Vector3, Color3, Color4,
  StandardMaterial, DynamicTexture, ParticleSystem, PointLight,
  NoiseProceduralTexture,
} from '@babylonjs/core';
import { SceneService }       from './scene.service';
import { OceanService }       from './ocean.service';
import { VesselService }      from './vessel.service';
import { TerrainService }     from './terrain.service';
import { MultiplayerService } from './multiplayer.service';
import { SfxService }         from './sfx.service';

// ── Constants ─────────────────────────────────────────────────────────────────

const G          = 9.81;
const BALL_POOL  = 24;           // max simultaneous cannonballs (broadsides = 3/side)

// Fixed broadside ballistics (no aiming/charging — guns fire straight out the beam).
const ELEV_RAD   = 8 * Math.PI / 180;   // fixed launch elevation
const MUZZLE_V   = 55;                   // fixed muzzle velocity (m/s)
// Gap between the 3 cannons of a broadside — randomized per shot so the volley reads
// as a human gun crew firing in sequence, not a single mechanical burst.
const STAGGER_MIN = 0.18;
const STAGGER_MAX = 0.42;
const FIRE_HOLD  = 0.45;                 // dwell after last shot before stowing (let recoil settle)
const FLASH_DUR  = 0.60;                 // muzzle-flash point-light envelope (s) — a touch longer

// Three muzzle tips per side in vessel root-local space, derived from the 3 gunports.
// x = lateral (port = −x, starboard = +x); y = barrel height; z = fore/aft (bow = +Z).
// (Model gunports are mirrored+flipped by the 180° instantiate flip — tune at runtime.)
// y lowered from the gunport-rim values so balls/blast emit from the barrel mouth,
// not above it.
type Muz = { x: number; y: number; z: number };
const MUZZLES: Record<'port' | 'stbd', Muz[]> = {
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

interface Ball {
  mesh:  Mesh;
  ox:    number; oy: number; oz: number;  // world-space origin
  vx:    number; vy: number; vz: number;  // world-space velocity (m/s)
  t:     number;                           // elapsed seconds since launch
  alive: boolean;
}

/** Per-side gunnery cycle. */
type GunState = 'stowed' | 'arming' | 'ready' | 'firing' | 'reloading';

interface SideGun {
  state:      GunState;
  shotsFired: number;   // 0..3 within the current broadside
  shotTimer:  number;   // stagger accumulator within firing
  nextShotAt: number;   // shotTimer threshold at which the next cannon fires (randomized)
  timer:      number;   // dwell (firing) / countdown (reloading)
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
  private zone               = inject(NgZone);

  // ── Public signals (consumed by HUD) — per-side gun state + reload progress ──
  readonly portGunState  = signal<GunState>('stowed');
  readonly stbdGunState  = signal<GunState>('stowed');
  readonly portReloadFrac = signal(0);   // 0..1 reload progress
  readonly stbdReloadFrac = signal(0);

  // ── Private state ─────────────────────────────────────────────────────────
  private scene!:   Scene;
  private canvas!:  HTMLCanvasElement;
  private elapsed = 0;

  // Per-side gunnery state machines.
  private readonly gun: Record<'port' | 'stbd', SideGun> = {
    port: { state: 'stowed', shotsFired: 0, shotTimer: 0, nextShotAt: 0, timer: 0 },
    stbd: { state: 'stowed', shotsFired: 0, shotTimer: 0, nextShotAt: 0, timer: 0 },
  };
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  // Cannonball pool
  private balls: Ball[] = [];

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

  // Remote shot effects — dedicated systems so they never conflict with local fire
  private flashRemote!:       PointLight;
  private flashRemoteEndT   = -1;
  private remoteFlamePS!:    ParticleSystem;
  private remoteSmokePS!:    ParticleSystem;
  private remoteLingerPS!:   ParticleSystem;
  private remoteFlameEmit    = new Vector3(0, 0, 0);
  private remoteSmokeEmit    = new Vector3(0, 0, 0);
  private remoteLingerEmit   = new Vector3(0, 0, 0);
  private remoteFlameCutoffT = -1;
  private remoteSmokeCutoffT = -1;
  private remoteLingerCutoffT = -1;

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
    this.sfxCtx = new AudioContext();
    this.sfxMaster = this.sfx.createMaster(this.sfxCtx);
    this.buildCannonAudio();

    this.buildParticleTex();
    this.buildSmokeNoise();
    this.buildBallPool();
    this.buildFlashLights();
    this.buildFlameParticles();
    this.buildSmokeParticles();
    this.buildLingerParticles();
    this.buildImpactParticles();
    this.setupInput();

    // Wire remote-shot callback (avoids circular injection with MultiplayerService)
    this.multiplayerService.onRemoteShot = (ox, oy, oz, vx, vy, vz) => {
      console.log('[Cannon] fireRemoteEffect called', ox, oy, oz, vx, vy, vz);
      this.launchBall(ox, oy, oz, vx, vy, vz);
      this.fireRemoteEffect(ox, oy, oz, vx, vz);
    };

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
    this.multiplayerService.onRemoteShot = null;

    for (const b of this.balls) b.mesh.dispose();
    this.flashPort?.dispose();
    this.flashStbd?.dispose();
    this.flashRemote?.dispose();
    this.shipFlash?.dispose();
    for (const ps of [
      this.flamePortPS, this.flameStbdPS, this.remoteFlamePS,
      this.smokePortPS, this.smokeStbdPS, this.remoteSmokePS,
      this.lingerPortPS, this.lingerStbdPS, this.remoteLingerPS,
      ...this.splashFx.map(f => f.ps),
      this.dirtPS, this.landSmokePS, this.shipDebrisPS, this.shipFirePS, this.shipSmokePS,
    ]) { ps?.stop(); ps?.dispose(); }
    this.smokeNoise?.dispose();
    this.cannonBus = null;   // torn down with the context below
    this.sfx.releaseMaster(this.sfxMaster);
    this.sfxMaster = null;
    this.sfxCtx?.close().catch(() => {});
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
      this.balls.push({ mesh: m, ox:0, oy:0, oz:0, vx:0, vy:0, vz:0, t:0, alive: false });
    }
  }

  // ── Flash lights ──────────────────────────────────────────────────────────

  private buildFlashLights(): void {
    const make = (name: string) => {
      const l = new PointLight(name, Vector3.Zero(), this.scene);
      l.diffuse   = new Color3(1.0, 0.72, 0.22);
      l.specular  = new Color3(1.0, 0.50, 0.08);
      l.intensity = 0;
      l.range     = 40;   // enough to light nearby hull / water nicely
      return l;
    };
    this.flashPort   = make('cannonFlashPort');
    this.flashStbd   = make('cannonFlashStbd');
    this.flashRemote = make('cannonFlashRemote');
    this.shipFlash   = make('cannonShipHitFlash');

    // Exclude large scene meshes so the muzzle flash doesn't incorrectly
    // illuminate the entire terrain or distant islands.
    this.excludeMeshFromFlashLights('terrain_heightfield');

    // Island meshes are loaded asynchronously — wire them up as they arrive.
    this.scene.onNewMeshAddedObservable.add((mesh) => {
      if (mesh.name.startsWith('island_') || mesh.name === 'terrain_heightfield') {
        this.excludeMeshFromFlashLights(mesh.name);
      }
    });
  }

  private excludeMeshFromFlashLights(meshName: string): void {
    const mesh = this.scene.getMeshByName(meshName);
    if (!mesh) return;
    for (const light of [this.flashPort, this.flashStbd, this.flashRemote, this.shipFlash]) {
      if (light && !light.excludedMeshes.includes(mesh)) {
        light.excludedMeshes.push(mesh);
      }
    }
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
    this.remoteFlamePS = makeFlame('flameRemote', this.remoteFlameEmit);
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
    this.remoteSmokePS = makeSmoke('smokeRemote', this.remoteSmokeEmit);
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
    this.remoteLingerPS = makeLinger('lingerRemote', this.remoteLingerEmit);
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
    ps.color1     = new Color4(0.82, 0.91, 1.00, 0.95);
    ps.color2     = new Color4(0.92, 0.97, 1.00, 0.80);
    ps.colorDead  = new Color4(0.86, 0.93, 1.00, 0.00);
    ps.addSizeGradient(0.0, 0.22, 0.45);   // small droplets
    ps.addSizeGradient(1.0, 1.10, 1.90);
    ps.minLifeTime  = 0.55;  ps.maxLifeTime  = 1.80;
    ps.minEmitPower = 7;     ps.maxEmitPower = 15;
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
      if (e.repeat) return;
      if (e.code === 'KeyZ')      this.armOrFire('port');
      else if (e.code === 'KeyC') this.armOrFire('stbd');
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  // ── Gunnery state machine (public; driven by keys + HUD) ───────────────────
  //
  // Per side: STOWED → (arm) → ARMING → READY → (fire) → FIRING → RELOADING → STOWED.
  // Animations (ports/run-out/recoil) are eased in SloopController via VesselService.

  /** Z / port button, C / stbd button. ARM if stowed; FIRE if ready; else ignore. */
  armOrFire(side: 'port' | 'stbd'): void {
    const g = this.gun[side];
    if (g.state === 'stowed') {
      g.state = 'arming';
      this.vesselService.setGunDeploy(side, 1);
      this.multiplayerService.broadcastGunState(side, 1);
      this.publishState(side);
    } else if (g.state === 'ready') {
      g.state = 'firing';
      g.shotsFired = 0; g.shotTimer = 0; g.nextShotAt = 0; g.timer = 0;
      this.publishState(side);
    }
  }

  /** Esc / stand-down: cancel an arming/ready side back to stowed (no fire). */
  cancel(side?: 'port' | 'stbd'): void {
    const sides: ('port' | 'stbd')[] = side ? [side] : ['port', 'stbd'];
    for (const s of sides) {
      const g = this.gun[s];
      if (g.state === 'arming' || g.state === 'ready') {
        g.state = 'stowed';
        this.vesselService.setGunDeploy(s, 0);
        this.multiplayerService.broadcastGunState(s, 0);
        this.publishState(s);
      }
    }
  }

  /** True if any side is mid-arm/ready (so Esc should stand down rather than pause). */
  anyCancellable(): boolean {
    return this.gun.port.state === 'arming' || this.gun.port.state === 'ready'
        || this.gun.stbd.state === 'arming' || this.gun.stbd.state === 'ready';
  }

  private publishState(side: 'port' | 'stbd'): void {
    const st = this.gun[side].state;
    this.zone.run(() => (side === 'port' ? this.portGunState : this.stbdGunState).set(st));
  }

  /** Advance one side's gunnery state machine each frame. */
  private tickGun(side: 'port' | 'stbd', dt: number): void {
    const g = this.gun[side];
    if (g.state === 'arming') {
      if (this.vesselService.isGunReady(side)) { g.state = 'ready'; this.publishState(side); }

    } else if (g.state === 'firing') {
      g.shotTimer += dt;
      // Fire the 3 cannons in sequence with a randomized human gap; one full
      // hull-roll impulse on the first.
      while (g.shotsFired < 3 && g.shotTimer >= g.nextShotAt) {
        this.vesselService.addCannonRecoil(side);   // hull shudder per shot (3 lurches)
        this.fireOneCannon(side, g.shotsFired);
        this.vesselService.addGunRecoilKick(side);
        g.shotsFired++;
        g.nextShotAt += STAGGER_MIN + Math.random() * (STAGGER_MAX - STAGGER_MIN);
      }
      if (g.shotsFired >= 3) {
        g.timer += dt;
        if (g.timer >= FIRE_HOLD) {
          g.state = 'reloading'; g.timer = 0;
          this.vesselService.setGunDeploy(side, 0);   // stow gun + close ports
          this.multiplayerService.broadcastGunState(side, 0);
          this.publishState(side);
        }
      }

    } else if (g.state === 'reloading') {
      g.timer += dt;
      const frac = Math.min(1, g.timer / this.vesselService.getReloadWindow());
      this.zone.run(() => (side === 'port' ? this.portReloadFrac : this.stbdReloadFrac).set(frac));
      if (frac >= 1 && this.vesselService.isGunSettled(side)) {
        g.state = 'stowed';
        this.zone.run(() => (side === 'port' ? this.portReloadFrac : this.stbdReloadFrac).set(0));
        this.publishState(side);
      }
    }
  }

  // ── Main tick ─────────────────────────────────────────────────────────────

  private tick(dt: number): void {
    this.elapsed += dt;

    // ── Per-side gunnery state machines ──────────────────────────────────────
    this.tickGun('port', dt);
    this.tickGun('stbd', dt);

    // ── Active cannonball arcs ────────────────────────────────────────────────
    for (const ball of this.balls) {
      if (!ball.alive) continue;
      ball.t += dt;
      const bx = ball.ox + ball.vx * ball.t;
      const by = ball.oy + ball.vy * ball.t - 0.5 * G * ball.t * ball.t;
      const bz = ball.oz + ball.vz * ball.t;
      ball.mesh.position.set(bx, by, bz);
      ball.mesh.rotation.z += dt * 5;

      // Ship hit — only after the ball has cleared the firing vessel (t>0.35), so a
      // freshly-fired ball never registers a hit on its own ship at the muzzle.
      if (ball.t > 0.35) {
        const ship = this.shipHitTest(bx, by, bz);
        if (ship) {
          this.onShipImpact(bx, by, bz, ball.vx, ball.vy - G * ball.t, ball.vz, ship);
          ball.alive = false;
          ball.mesh.setEnabled(false);
          continue;
        }
      }

      if ((by < 0.8 && ball.t > 0.4) || ball.t > 25) {
        this.onImpact(bx, bz, ball.vx, ball.vy - G * ball.t, ball.vz);
        ball.alive = false;
        ball.mesh.setEnabled(false);
      }
    }

    // ── Muzzle flash lights decay ─────────────────────────────────────────────
    this.decayFlash(this.flashPort,   this.flashPortEndT);
    this.decayFlash(this.flashStbd,   this.flashStbdEndT);
    this.decayFlash(this.flashRemote, this.flashRemoteEndT);
    this.decayFlash(this.shipFlash,   this.shipFlashEndT);

    // ── Particle burst cutoffs ────────────────────────────────────────────────
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
    if (this.remoteFlameCutoffT > 0 && this.elapsed >= this.remoteFlameCutoffT) {
      this.remoteFlamePS.emitRate = 0;
      this.remoteFlameCutoffT = -1;
    }
    if (this.remoteSmokeCutoffT > 0 && this.elapsed >= this.remoteSmokeCutoffT) {
      this.remoteSmokePS.emitRate = 0;
      this.remoteSmokeCutoffT = -1;
    }
    if (this.remoteLingerCutoffT > 0 && this.elapsed >= this.remoteLingerCutoffT) {
      this.remoteLingerPS.emitRate = 0;
      this.remoteLingerCutoffT = -1;
    }
  }

  private decayFlash(light: PointLight, endT: number): void {
    if (!light || endT < 0 || this.elapsed >= endT) {
      if (light) light.intensity = 0;
      return;
    }
    const env = (endT - this.elapsed) / FLASH_DUR;
    light.intensity = env * 8.0 * (0.85 + 0.15 * Math.random());
  }

  // ── Fire one cannon of a broadside (fixed beam direction, no aiming) ────────

  private fireOneCannon(side: 'port' | 'stbd', idx: number): void {
    const vs   = this.vesselService.state();
    const hRad = vs.heading * Math.PI / 180;
    const sinH = Math.sin(hRad);
    const cosH = Math.cos(hRad);

    // Beam direction (perpendicular to the hull): port = (-cosH, sinH), stbd = (cosH, -sinH).
    const dirX = side === 'port' ? -cosH :  cosH;
    const dirZ = side === 'port' ?  sinH : -sinH;
    const vh   = MUZZLE_V * Math.cos(ELEV_RAD);
    const vy   = MUZZLE_V * Math.sin(ELEV_RAD);
    const bvx  = dirX * vh;
    const bvz  = dirZ * vh;

    // Muzzle world position from this cannon's local offset, rotated by heading.
    const muz = MUZZLES[side][idx] ?? MUZZLES[side][0];
    const mwx = vs.x + muz.x * cosH + muz.z * sinH;
    const mwy = muz.y;
    const mwz = vs.z - muz.x * sinH + muz.z * cosH;

    this.launchBall(mwx, mwy, mwz, bvx, vy, bvz);
    this.multiplayerService.broadcastShot(mwx, mwy, mwz, bvx, vy, bvz);
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

    // 1) Flame core — tight, fast jet right out the barrel.
    const fSpread = 0.16;
    flamePS.direction1.set(dirX - fSpread, 0.04, dirZ - fSpread);
    flamePS.direction2.set(dirX + fSpread, 0.30, dirZ + fSpread);
    fEmit.set(mwx, mwy, mwz);
    flamePS.emitRate  = 1800;
    this.flameCutoffT = this.elapsed + 0.22;

    // 2) Smoke fountain — dense directional belch (emitted slightly ahead of the mouth).
    const sSpread = 0.32;
    smokePS.direction1.set(dirX * 1.0 - sSpread, 0.12, dirZ * 1.0 - sSpread);
    smokePS.direction2.set(dirX * 1.5 + sSpread, 0.55, dirZ * 1.5 + sSpread);
    sEmit.set(mwx + dirX * 0.3, mwy, mwz + dirZ * 0.3);
    smokePS.emitRate  = 850;
    this.smokeCutoffT = this.elapsed + 0.55;

    // 3) Lingering cloud — same wide directional spread as the fountain so the pall
    //    that hangs covers the whole plume footprint, just slower and far longer-lived.
    lEmit.set(mwx + dirX * 0.3, mwy + 0.2, mwz + dirZ * 0.3);
    lingerPS.direction1.set(dirX * 1.0 - sSpread, 0.10, dirZ * 1.0 - sSpread);
    lingerPS.direction2.set(dirX * 1.5 + sSpread, 0.65, dirZ * 1.5 + sSpread);
    lingerPS.emitRate  = 120;
    this.lingerCutoffT = this.elapsed + 0.55;
  }

  private fireRemoteEffect(
    ox: number, oy: number, oz: number, vx: number, vz: number,
  ): void {
    const hLen = Math.sqrt(vx * vx + vz * vz);
    if (hLen < 0.001) return;
    const dx = vx / hLen;
    const dz = vz / hLen;

    // Muzzle flash
    this.flashRemote.position.set(ox, oy, oz);
    this.flashRemoteEndT = this.elapsed + FLASH_DUR;

    // 1) Flame core — tight, fast jet along the shot vector
    const fSpread = 0.16;
    this.remoteFlamePS.direction1.set(dx - fSpread, 0.04, dz - fSpread);
    this.remoteFlamePS.direction2.set(dx + fSpread, 0.30, dz + fSpread);
    this.remoteFlameEmit.set(ox, oy, oz);
    this.remoteFlamePS.emitRate = 1800;
    this.remoteFlameCutoffT = this.elapsed + 0.22;

    // 2) Smoke fountain — dense directional belch
    const sSpread = 0.32;
    this.remoteSmokePS.direction1.set(dx * 1.0 - sSpread, 0.12, dz * 1.0 - sSpread);
    this.remoteSmokePS.direction2.set(dx * 1.5 + sSpread, 0.55, dz * 1.5 + sSpread);
    this.remoteSmokeEmit.set(ox + dx * 0.3, oy, oz + dz * 0.3);
    this.remoteSmokePS.emitRate = 850;
    this.remoteSmokeCutoffT = this.elapsed + 0.55;

    // 3) Lingering cloud — same wide spread as the fountain (covers the plume footprint)
    this.remoteLingerEmit.set(ox + dx * 0.3, oy + 0.2, oz + dz * 0.3);
    this.remoteLingerPS.direction1.set(dx * 1.0 - sSpread, 0.10, dz * 1.0 - sSpread);
    this.remoteLingerPS.direction2.set(dx * 1.5 + sSpread, 0.65, dz * 1.5 + sSpread);
    this.remoteLingerPS.emitRate = 120;
    this.remoteLingerCutoffT = this.elapsed + 0.55;

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
  ): void {
    const ball = this.balls.find(b => !b.alive);
    if (!ball) return;
    Object.assign(ball, { ox, oy, oz, vx, vy, vz, t: 0, alive: true });
    ball.mesh.position.set(ox, oy, oz);
    ball.mesh.rotation.setAll(0);
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

  // ── Ship hit (cosmetic) ─────────────────────────────────────────────────────

  /**
   * Local ship + remote ships hull test. Returns the hit ship's pose plus which ship
   * it was ('local' or a remote player id) so we can shudder the right vessel, or null.
   */
  private shipHitTest(bx: number, by: number, bz: number):
    { x: number; z: number; heading: number; target: 'local' | string } | null {
    if (by < -1.0 || by > 6.0) return null;   // outside the hull/deck height band
    const vs = this.vesselService.state();
    if (this.hullContains(bx, bz, vs.x, vs.z, vs.heading)) {
      return { x: vs.x, z: vs.z, heading: vs.heading, target: 'local' };
    }
    const remote = this.multiplayerService.shipHitAt(bx, bz);
    return remote ? { x: remote.x, z: remote.z, heading: remote.heading, target: remote.id } : null;
  }

  /** Oriented-ellipse hull test (~18 m × 7 m) around a ship at (sx,sz,headingDeg). */
  private hullContains(bx: number, bz: number, sx: number, sz: number, headingDeg: number): boolean {
    const dx = bx - sx, dz = bz - sz;
    const hr = headingDeg * Math.PI / 180;
    const lat = dx * Math.cos(hr) - dz * Math.sin(hr);
    const lon = dx * Math.sin(hr) + dz * Math.cos(hr);
    return (lat * lat) / 12.25 + (lon * lon) / 81.0 <= 1.0;
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

  /** Cannonball strikes a hull: wood splinters + fire gust + flash + dust + smoke,
   *  oriented to the hit, and a heavy shudder on the struck ship (local or remote). */
  private onShipImpact(
    bx: number, by: number, bz: number, vx: number, vyImpact: number, vz: number,
    ship: { x: number; z: number; heading: number; target: 'local' | string },
  ): void {
    const vs   = this.vesselService.state();
    const dist = Math.hypot(bx - vs.x, bz - vs.z);
    const vol  = Math.max(0, 1 - dist / 800);

    // Emit everything from the actual strike point on the hull.
    this.shipDebrisEmit.set(bx, by, bz);
    this.dirtEmit.set(bx, by, bz);
    this.landSmokeEmit.set(bx, by, bz);

    // Spray back along the REVERSE of the ball's incoming velocity (its exact entry
    // direction AND angle, flipped) — splinters/dust blast back out of the entry
    // toward where the ball came from, not straight up.
    const [rx, ry, rz] = this.reverseDir(vx, vyImpact, vz);   // unit reverse-incoming
    // Short throw — it's reverse-incoming, it bursts back out of the entry, close in.
    this.setCone(this.shipDebrisPS, rx, ry, rz, 1.1, 0.65, 0.45);   // splinters back out the entry
    this.setCone(this.dirtPS,       rx, ry, rz, 0.85, 0.55, 0.40);  // dust back along the entry line
    this.setCone(this.landSmokePS,  rx, ry, rz, 0.45, 0.35, 0.25);  // pall drifts back then hangs

    this.shipDebrisPS.emitRate = 3200;
    this.shipDebrisCutoffT     = this.elapsed + 0.14;
    this.dirtPS.emitRate       = 2200;
    this.dirtCutoffT           = this.elapsed + 0.14;
    this.landSmokePS.emitRate  = 200;
    this.landSmokeCutoffT      = this.elapsed + 0.5;

    // Black sooty smoke that hangs over the strike — leans slightly back along the
    // entry, then rises and lingers for several seconds.
    this.shipSmokeEmit.set(bx, by + 0.4, bz);
    this.shipSmokePS.direction1.set(rx * 0.7 - 0.5, 0.7, rz * 0.7 - 0.5);
    this.shipSmokePS.direction2.set(rx * 0.7 + 0.5, 1.8, rz * 0.7 + 0.5);
    this.shipSmokePS.emitRate  = 170;
    this.shipSmokeCutoffT      = this.elapsed + 0.6;

    // Quick gust of fire + a flash of light at the strike point (fire flares back
    // out the entry along the same reverse-incoming cone).
    this.shipFireEmit.set(bx, by, bz);
    this.setCone(this.shipFirePS, rx, ry, rz, 0.75, 0.45, 0.35);
    this.shipFirePS.emitRate = 1600;
    this.shipFireCutoffT     = this.elapsed + 0.10;
    this.shipFlash.position.set(bx, by, bz);
    this.shipFlashEndT       = this.elapsed + FLASH_DUR;

    // Heavy shudder on whichever ship was struck. The struck SIDE (from the impact's
    // lateral offset) sets which way it heels/lurches — away from the blow.
    const hr  = ship.heading * Math.PI / 180;
    const lat = (bx - ship.x) * Math.cos(hr) - (bz - ship.z) * Math.sin(hr);
    const struckSide: 'port' | 'stbd' = lat < 0 ? 'port' : 'stbd';
    if (ship.target === 'local') this.vesselService.addHitShudder(struckSide);
    else                         this.multiplayerService.applyHitShudder(ship.target, struckSide);

    if (vol > 0.01) this.playShipHitSound(vol);
  }

  // ── Impact ────────────────────────────────────────────────────────────────

  private onImpact(wx: number, wz: number, vx: number, vyImpact: number, vz: number): void {
    // Reverse-incoming cone: ejecta sprays back along the ball's entry angle, flipped.
    const [rx, ry, rz] = this.reverseDir(vx, vyImpact, vz);

    // Distance-attenuate the impact sound by how far it landed from the player.
    const vs   = this.vesselService.state();
    const dist = Math.hypot(wx - vs.x, wz - vs.z);
    const vol  = Math.max(0, 1 - dist / 800);

    const isLand = this.terrainService.isOnLand(wx, wz);
    if (isLand) {
      // Dust thrown BACK along the entry line (plus a little lift), not a vertical column.
      this.setCone(this.dirtPS, rx, ry, rz, 1.2, 0.65, 0.45, 0.5);
      this.dirtEmit.set(wx, 0.6, wz);
      this.dirtPS.emitRate = 2400;
      this.dirtCutoffT     = this.elapsed + 0.16;
      // Lingering dust pall: drifts back along the entry then hangs (dusty browns).
      this.setCone(this.landSmokePS, rx, ry, rz, 0.5, 0.35, 0.25, 0.2);
      this.landSmokeEmit.set(wx, 0.7, wz);
      this.landSmokePS.emitRate  = 220;
      this.landSmokeCutoffT      = this.elapsed + 0.5;
      if (vol > 0.01) this.playLandImpactSound(vol);
    } else {
      // Spray thrown BACK along the entry (toward where the ball came from) plus an
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
}
