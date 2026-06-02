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

  // Impact particle systems
  private splashPS!:     ParticleSystem;
  private dirtPS!:       ParticleSystem;
  private splashEmit     = new Vector3(0, 0, 0);
  private dirtEmit       = new Vector3(0, 0, 0);
  private splashCutoffT  = -1;
  private dirtCutoffT    = -1;

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
    for (const ps of [
      this.flamePortPS, this.flameStbdPS, this.remoteFlamePS,
      this.smokePortPS, this.smokeStbdPS, this.remoteSmokePS,
      this.lingerPortPS, this.lingerStbdPS, this.remoteLingerPS,
      this.splashPS, this.dirtPS,
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
    for (const light of [this.flashPort, this.flashStbd, this.flashRemote]) {
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
    this.splashPS = new ParticleSystem('cannonSplash', 350, this.scene);
    this.splashPS.particleTexture = this.blobTex;
    this.splashPS.emitter    = this.splashEmit;
    this.splashPS.minEmitBox = new Vector3(-0.3, 0, -0.3);
    this.splashPS.maxEmitBox = new Vector3( 0.3, 0.1,  0.3);
    this.splashPS.color1     = new Color4(0.85, 0.95, 1.00, 0.92);
    this.splashPS.color2     = new Color4(1.00, 1.00, 1.00, 0.75);
    this.splashPS.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.splashPS.minSize      = 0.35;  this.splashPS.maxSize      = 1.60;
    this.splashPS.minLifeTime  = 0.50;  this.splashPS.maxLifeTime  = 2.00;
    this.splashPS.minEmitPower = 7;     this.splashPS.maxEmitPower = 22;
    this.splashPS.direction1   = new Vector3(-2, 8,  -2);
    this.splashPS.direction2   = new Vector3( 2, 18,  2);
    this.splashPS.gravity      = new Vector3(0, -9.81, 0);
    this.splashPS.blendMode    = ParticleSystem.BLENDMODE_ADD;
    this.splashPS.renderingGroupId = 3;   // above all ocean LODs (else the near water hides the splash)
    this.splashPS.emitRate     = 0;
    this.splashPS.start();

    this.dirtPS = new ParticleSystem('cannonDirt', 200, this.scene);
    this.dirtPS.particleTexture = this.blobTex;
    this.dirtPS.emitter    = this.dirtEmit;
    this.dirtPS.minEmitBox = new Vector3(-0.2, 0, -0.2);
    this.dirtPS.maxEmitBox = new Vector3( 0.2, 0.2,  0.2);
    this.dirtPS.color1     = new Color4(0.62, 0.44, 0.18, 0.95);
    this.dirtPS.color2     = new Color4(0.78, 0.62, 0.28, 0.75);
    this.dirtPS.colorDead  = new Color4(0.55, 0.38, 0.12, 0.00);
    this.dirtPS.minSize      = 0.25;  this.dirtPS.maxSize      = 1.20;
    this.dirtPS.minLifeTime  = 0.70;  this.dirtPS.maxLifeTime  = 2.50;
    this.dirtPS.minEmitPower = 3;     this.dirtPS.maxEmitPower = 12;
    this.dirtPS.direction1   = new Vector3(-1.5, 5, -1.5);
    this.dirtPS.direction2   = new Vector3( 1.5, 12, 1.5);
    this.dirtPS.gravity      = new Vector3(0, -9.81, 0);
    this.dirtPS.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
    this.dirtPS.renderingGroupId = 3;   // above all ocean LODs
    this.dirtPS.emitRate     = 0;
    this.dirtPS.start();
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
        if (g.shotsFired === 0) this.vesselService.addCannonRecoil(side);
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

      if ((by < 0.8 && ball.t > 0.4) || ball.t > 25) {
        this.onImpact(bx, bz);
        ball.alive = false;
        ball.mesh.setEnabled(false);
      }
    }

    // ── Muzzle flash lights decay ─────────────────────────────────────────────
    this.decayFlash(this.flashPort,   this.flashPortEndT);
    this.decayFlash(this.flashStbd,   this.flashStbdEndT);
    this.decayFlash(this.flashRemote, this.flashRemoteEndT);

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
    if (this.splashCutoffT > 0 && this.elapsed >= this.splashCutoffT) {
      this.splashPS.emitRate = 0;
      this.splashCutoffT = -1;
    }
    if (this.dirtCutoffT > 0 && this.elapsed >= this.dirtCutoffT) {
      this.dirtPS.emitRate = 0;
      this.dirtCutoffT = -1;
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

  private playSplashSound(): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.55), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 180;
    const bpf = ctx.createBiquadFilter(); bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(900, t); bpf.frequency.exponentialRampToValueAtTime(300, t + 0.4); bpf.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.85, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.50);
    src.connect(hpf); hpf.connect(bpf); bpf.connect(gain); gain.connect(this.sfxMaster ?? ctx.destination);
    src.start(t); src.stop(t + 0.56);
  }

  private playLandImpactSound(): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass';
    lpf.frequency.setValueAtTime(3500, t); lpf.frequency.exponentialRampToValueAtTime(250, t + 0.25);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(1.0, t); noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    src.connect(lpf); lpf.connect(noiseGain); noiseGain.connect(this.sfxMaster ?? ctx.destination);
    src.start(t); src.stop(t + 0.30);

    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(100, t); osc.frequency.exponentialRampToValueAtTime(28, t + 0.22);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.65, t); thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(thudGain); thudGain.connect(this.sfxMaster ?? ctx.destination);
    osc.start(t); osc.stop(t + 0.25);
  }

  // ── Impact ────────────────────────────────────────────────────────────────

  private onImpact(wx: number, wz: number): void {
    const isLand = this.terrainService.isOnLand(wx, wz);
    if (isLand) {
      this.dirtEmit.set(wx, 1.5, wz);
      this.dirtPS.emitRate = 1200;
      this.dirtCutoffT     = this.elapsed + 0.12;
      this.playLandImpactSound();
    } else {
      this.splashEmit.set(wx, 0.3, wz);
      this.splashPS.emitRate = 900;
      this.splashCutoffT     = this.elapsed + 0.12;
      this.playSplashSound();
    }
  }
}
