import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  Scene, Mesh, MeshBuilder, Vector3, Color3, Color4,
  StandardMaterial, DynamicTexture, ParticleSystem, PointLight,
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
const STAGGER    = 0.06;                 // seconds between the 3 cannons of a broadside
const FIRE_HOLD  = 0.45;                 // dwell after last shot before stowing (let recoil settle)

// Three muzzle tips per side in vessel root-local space, derived from the 3 gunports.
// x = lateral (port = −x, starboard = +x); y = barrel height; z = fore/aft (bow = +Z).
// (Model gunports are mirrored+flipped by the 180° instantiate flip — tune at runtime.)
type Muz = { x: number; y: number; z: number };
const MUZZLES: Record<'port' | 'stbd', Muz[]> = {
  port: [
    { x: -1.98, y: 2.05, z: 1.36 },
    { x: -1.87, y: 2.20, z: 2.40 },
    { x: -1.72, y: 2.45, z: 3.44 },
  ],
  stbd: [
    { x: 1.98, y: 2.05, z: 1.36 },
    { x: 1.87, y: 2.20, z: 2.40 },
    { x: 1.72, y: 2.45, z: 3.44 },
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
    port: { state: 'stowed', shotsFired: 0, shotTimer: 0, timer: 0 },
    stbd: { state: 'stowed', shotsFired: 0, shotTimer: 0, timer: 0 },
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

  // Smoke particle systems
  private smokePortPS!:  ParticleSystem;
  private smokeStbdPS!:  ParticleSystem;
  private smokePortEmit  = new Vector3(0, 0, 0);
  private smokeStbdEmit  = new Vector3(0, 0, 0);
  private smokeCutoffT   = -1;

  // Remote shot effects — dedicated systems so they never conflict with local fire
  private flashRemote!:       PointLight;
  private flashRemoteEndT   = -1;
  private remoteFlamePS!:    ParticleSystem;
  private remoteSmokePS!:    ParticleSystem;
  private remoteFlameEmit    = new Vector3(0, 0, 0);
  private remoteSmokeEmit    = new Vector3(0, 0, 0);
  private remoteFlameCutoffT = -1;
  private remoteSmokeCutoffT = -1;

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

  // Shared soft-blob texture for all particle systems
  private blobTex!: DynamicTexture;

  // ── Init / dispose ────────────────────────────────────────────────────────

  init(): void {
    this.scene  = this.sceneService.scene;
    this.canvas = this.scene.getEngine().getRenderingCanvas() as HTMLCanvasElement;
    this.sfxCtx = new AudioContext();
    this.sfxMaster = this.sfx.createMaster(this.sfxCtx);

    this.buildParticleTex();
    this.buildBallPool();
    this.buildFlashLights();
    this.buildFlameParticles();
    this.buildSmokeParticles();
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
      this.splashPS, this.dirtPS,
    ]) { ps?.stop(); ps?.dispose(); }
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

  // ── Muzzle blast (flame) particle systems ─────────────────────────────────

  private buildFlameParticles(): void {
    const makeFlame = (name: string, emitVec: Vector3) => {
      const ps = new ParticleSystem(name, 140, this.scene);
      ps.particleTexture = this.blobTex;
      ps.emitter    = emitVec;
      ps.minEmitBox = new Vector3(-0.15, -0.10, -0.15);
      ps.maxEmitBox = new Vector3( 0.15,  0.10,  0.15);
      ps.color1     = new Color4(1.00, 0.98, 0.80, 1.00);
      ps.color2     = new Color4(1.00, 0.50, 0.06, 0.90);
      ps.colorDead  = new Color4(0.55, 0.18, 0.01, 0.00);
      ps.minSize      = 0.50;  ps.maxSize      = 2.20;
      ps.minLifeTime  = 0.14;  ps.maxLifeTime  = 0.45;
      ps.minEmitPower = 8;     ps.maxEmitPower = 22;
      ps.updateSpeed  = 0.016;
      ps.direction1   = new Vector3(-1, 0.05, 0);
      ps.direction2   = new Vector3(-1, 0.30, 0);
      ps.gravity      = new Vector3(0, -0.8, 0);
      ps.blendMode    = ParticleSystem.BLENDMODE_ADD;
      ps.renderingGroupId = 1;
      ps.emitRate     = 0;
      ps.start();
      return ps;
    };
    this.flamePortPS  = makeFlame('flamePort',   this.flamePortEmit);
    this.flameStbdPS  = makeFlame('flameStbd',   this.flameStbdEmit);
    this.remoteFlamePS = makeFlame('flameRemote', this.remoteFlameEmit);
  }

  // ── Smoke particle systems ────────────────────────────────────────────────

  private buildSmokeParticles(): void {
    const makeSmoke = (name: string, emitVec: Vector3) => {
      const ps = new ParticleSystem(name, 160, this.scene);
      ps.particleTexture = this.blobTex;
      ps.emitter    = emitVec;
      ps.minEmitBox = new Vector3(-0.22, -0.10, -0.22);
      ps.maxEmitBox = new Vector3( 0.22,  0.10,  0.22);
      ps.color1     = new Color4(0.65, 0.60, 0.52, 0.85);
      ps.color2     = new Color4(0.45, 0.42, 0.38, 0.70);
      ps.colorDead  = new Color4(0.28, 0.28, 0.28, 0.00);
      ps.minSize      = 1.2;   ps.maxSize      = 5.0;
      ps.minLifeTime  = 1.0;   ps.maxLifeTime  = 3.0;
      ps.minEmitPower = 0.8;   ps.maxEmitPower = 3.5;
      ps.updateSpeed  = 0.016;
      ps.direction1   = new Vector3(-0.5, 0.3, -0.5);
      ps.direction2   = new Vector3( 0.5, 1.5,  0.5);
      ps.gravity      = new Vector3(0, 0.9, 0);
      ps.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
      ps.renderingGroupId = 1;
      ps.emitRate     = 0;
      ps.start();
      return ps;
    };
    this.smokePortPS  = makeSmoke('smokePort',   this.smokePortEmit);
    this.smokeStbdPS  = makeSmoke('smokeStbd',   this.smokeStbdEmit);
    this.remoteSmokePS = makeSmoke('smokeRemote', this.remoteSmokeEmit);
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
      g.shotsFired = 0; g.shotTimer = 0; g.timer = 0;
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
      // Fire the 3 cannons staggered; one full hull-roll impulse on the first.
      while (g.shotsFired < 3 && g.shotTimer >= g.shotsFired * STAGGER) {
        if (g.shotsFired === 0) this.vesselService.addCannonRecoil(side);
        this.fireOneCannon(side, g.shotsFired);
        this.vesselService.addGunRecoilKick(side);
        g.shotsFired++;
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
  }

  private decayFlash(light: PointLight, endT: number): void {
    if (!light || endT < 0 || this.elapsed >= endT) {
      if (light) light.intensity = 0;
      return;
    }
    const env = (endT - this.elapsed) / 0.45;
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

  /** Flash + flame + smoke at a muzzle, blasting out the beam direction. */
  private muzzleEffect(side: 'port' | 'stbd', mwx: number, mwy: number, mwz: number, dirX: number, dirZ: number): void {
    const fSpread = 0.18, sSpread = 0.40;
    const isPort  = side === 'port';
    const flamePS = isPort ? this.flamePortPS : this.flameStbdPS;
    const smokePS = isPort ? this.smokePortPS : this.smokeStbdPS;
    const flash   = isPort ? this.flashPort   : this.flashStbd;
    const fEmit   = isPort ? this.flamePortEmit : this.flameStbdEmit;
    const sEmit   = isPort ? this.smokePortEmit : this.smokeStbdEmit;

    flash.position.set(mwx, mwy, mwz);
    if (isPort) this.flashPortEndT = this.elapsed + 0.45;
    else        this.flashStbdEndT = this.elapsed + 0.45;

    flamePS.direction1.set(dirX - fSpread, 0.06, dirZ - fSpread);
    flamePS.direction2.set(dirX + fSpread, 0.32, dirZ + fSpread);
    smokePS.direction1.set(dirX - sSpread, 0.18, dirZ - sSpread);
    smokePS.direction2.set(dirX + sSpread, 1.10, dirZ + sSpread);
    fEmit.set(mwx, mwy, mwz);
    sEmit.set(mwx, mwy, mwz);

    flamePS.emitRate = 450;
    smokePS.emitRate = 110;
    this.flameCutoffT = this.elapsed + 0.18;
    this.smokeCutoffT = this.elapsed + 1.4;
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
    this.flashRemoteEndT = this.elapsed + 0.45;

    // Flame particles directed along shot vector
    const fSpread = 0.18;
    this.remoteFlamePS.direction1.set(dx - fSpread, 0.06, dz - fSpread);
    this.remoteFlamePS.direction2.set(dx + fSpread, 0.32, dz + fSpread);
    this.remoteFlameEmit.set(ox, oy, oz);
    this.remoteFlamePS.emitRate = 450;
    this.remoteFlameCutoffT = this.elapsed + 0.18;

    // Smoke particles
    const sSpread = 0.40;
    this.remoteSmokePS.direction1.set(dx - sSpread, 0.18, dz - sSpread);
    this.remoteSmokePS.direction2.set(dx + sSpread, 1.10, dz + sSpread);
    this.remoteSmokeEmit.set(ox, oy, oz);
    this.remoteSmokePS.emitRate = 110;
    this.remoteSmokeCutoffT = this.elapsed + 1.4;

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

  private playCannonSound(vol = 1.0): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;

    const crackBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
    const cd = crackBuf.getChannelData(0);
    for (let i = 0; i < cd.length; i++) cd[i] = Math.random() * 2 - 1;
    const crack = ctx.createBufferSource(); crack.buffer = crackBuf;
    const crackHpf = ctx.createBiquadFilter(); crackHpf.type = 'highpass'; crackHpf.frequency.value = 1200;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(1.4 * vol, t); crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    crack.connect(crackHpf); crackHpf.connect(crackGain); crackGain.connect(this.sfxMaster ?? ctx.destination);
    crack.start(t); crack.stop(t + 0.13);

    const boomBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
    const bd = boomBuf.getChannelData(0);
    for (let i = 0; i < bd.length; i++) bd[i] = Math.random() * 2 - 1;
    const boom = ctx.createBufferSource(); boom.buffer = boomBuf;
    const boomLpf = ctx.createBiquadFilter(); boomLpf.type = 'lowpass';
    boomLpf.frequency.setValueAtTime(600, t); boomLpf.frequency.exponentialRampToValueAtTime(55, t + 0.5);
    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(1.1 * vol, t); boomGain.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    boom.connect(boomLpf); boomLpf.connect(boomGain); boomGain.connect(this.sfxMaster ?? ctx.destination);
    boom.start(t); boom.stop(t + 1.2);

    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(72, t); osc.frequency.exponentialRampToValueAtTime(22, t + 0.55);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.70 * vol, t); oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    osc.connect(oscGain); oscGain.connect(this.sfxMaster ?? ctx.destination);
    osc.start(t); osc.stop(t + 0.56);
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
