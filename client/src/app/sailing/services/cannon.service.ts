import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  Scene, Mesh, MeshBuilder, Vector3, Color3, Color4, Matrix,
  StandardMaterial, DynamicTexture, ParticleSystem, PointLight,
  PointerEventTypes, TransformNode,
} from '@babylonjs/core';
import { SceneService }       from './scene.service';
import { VesselService }      from './vessel.service';
import { IslandService }      from './island.service';
import { MultiplayerService } from './multiplayer.service';

// ── Constants ─────────────────────────────────────────────────────────────────

const G          = 9.81;
const MAX_CHARGE = 2.8;          // seconds of hold for full charge
const MIN_V      = 20;           // muzzle velocity (m/s) at minimum charge
const MAX_V      = 72;           // muzzle velocity at full charge
const ELEV_RAD   = 11 * Math.PI / 180;  // fixed launch elevation
const BALL_POOL  = 8;            // max simultaneous cannonballs

// Firing arc: ±60° from the beam (perpendicular to the ship).
// Angles beyond this toward bow or stern are clamped to the arc edge.
const ARC_HALF  = 60 * Math.PI / 180;

// Muzzle tip in vessel root-local space.
// x = lateral offset (port −, starboard +); z = forward offset (bow = +Z).
const PORT_MUZ = { x: -2.73, y: 2.48, z: 2.5 } as const;
const STBD_MUZ = { x:  2.73, y: 2.48, z: 2.5 } as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Ball {
  mesh:  Mesh;
  ox:    number; oy: number; oz: number;  // world-space origin
  vx:    number; vy: number; vz: number;  // world-space velocity (m/s)
  t:     number;                           // elapsed seconds since launch
  alive: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class CannonService {
  private sceneService       = inject(SceneService);
  private vesselService      = inject(VesselService);
  private islandService      = inject(IslandService);
  private multiplayerService = inject(MultiplayerService);
  private zone               = inject(NgZone);

  // ── Public signals (consumed by HUD / GameComponent) ─────────────────────
  readonly isCharging  = signal(false);
  readonly chargeLevel = signal(0);          // 0 → 1
  readonly activeSide  = signal<'port' | 'stbd'>('port');

  // ── Private state ─────────────────────────────────────────────────────────
  private scene!:   Scene;
  private canvas!:  HTMLCanvasElement;
  private elapsed = 0;
  private chargeT = 0;    // seconds RMB has been held

  // Aim direction — arc-clamped unit vector in world XZ, updated by updateAim().
  // Represents the direction the active cannon will fire.
  private aimDirX = -1;   // default: port beam when heading north
  private aimDirZ =  0;

  // Reticles — flat discs floating just above the water
  private reticlePort!: Mesh;
  private reticleStbd!: Mesh;

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

  // Impact particle systems
  private splashPS!:     ParticleSystem;
  private dirtPS!:       ParticleSystem;
  private splashEmit     = new Vector3(0, 0, 0);
  private dirtEmit       = new Vector3(0, 0, 0);
  private splashCutoffT  = -1;
  private dirtCutoffT    = -1;

  // Cannon assembly traversal pivots — one per broadside.
  // All cannon mesh components are re-parented to these in setupCannonPivots().
  // Rotating the pivot.rotation.y swings the whole cannon assembly in azimuth.
  private portPivot!: TransformNode;
  private stbdPivot!: TransformNode;

  // Arc-clamped angle (rad) from the active beam toward bow, set by updateAim().
  // portPivot.rotation.y = clampedAngle   → barrel sweeps port-beam → bow
  // stbdPivot.rotation.y = -clampedAngle  → barrel sweeps stbd-beam → bow
  private clampedAngle = 0;

  // Input handlers (stored for cleanup)
  private pointerObserver: any = null;
  private mouseMoveFn!: (e: MouseEvent) => void;
  private ctxMenuFn!:   (e: Event) => void;

  // Web Audio context for sound effects
  private sfxCtx: AudioContext | null = null;

  // Shared soft-blob texture for all particle systems
  private blobTex!: DynamicTexture;

  // ── Init / dispose ────────────────────────────────────────────────────────

  init(): void {
    this.scene  = this.sceneService.scene;
    this.canvas = this.scene.getEngine().getRenderingCanvas() as HTMLCanvasElement;
    this.sfxCtx = new AudioContext();

    this.buildParticleTex();
    this.buildReticles();
    this.buildBallPool();
    this.buildFlashLights();
    this.buildFlameParticles();
    this.buildSmokeParticles();
    this.buildImpactParticles();
    this.setupCannonPivots();
    this.setupInput();

    // Wire remote-shot callback (avoids circular injection with MultiplayerService)
    this.multiplayerService.onRemoteShot = (ox, oy, oz, vx, vy, vz) => {
      this.launchBall(ox, oy, oz, vx, vy, vz);
    };

    this.scene.registerBeforeRender(() => {
      const dt = Math.min(this.scene.getEngine().getDeltaTime() * 0.001, 0.05);
      this.tick(dt);
    });
  }

  dispose(): void {
    if (this.pointerObserver) {
      this.scene?.onPointerObservable.remove(this.pointerObserver);
      this.pointerObserver = null;
    }
    window.removeEventListener('mousemove', this.mouseMoveFn);
    this.canvas?.removeEventListener('contextmenu', this.ctxMenuFn);

    this.multiplayerService.onRemoteShot = null;

    // Cannon pivots are children of the vessel root and will be disposed with
    // it — null them here so tick() stops touching them during teardown.
    this.portPivot = null!;
    this.stbdPivot = null!;

    this.reticlePort?.dispose();
    this.reticleStbd?.dispose();
    for (const b of this.balls) b.mesh.dispose();
    this.flashPort?.dispose();
    this.flashStbd?.dispose();
    for (const ps of [
      this.flamePortPS, this.flameStbdPS,
      this.smokePortPS, this.smokeStbdPS,
      this.splashPS, this.dirtPS,
    ]) { ps?.stop(); ps?.dispose(); }
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

  // ── Reticles ──────────────────────────────────────────────────────────────

  private buildReticles(): void {
    const rtex = new DynamicTexture('reticleTex', { width: 128, height: 128 }, this.scene, false);
    const ctx  = rtex.getContext() as CanvasRenderingContext2D;
    ctx.strokeStyle = 'rgba(255, 210, 50, 0.95)';
    ctx.lineWidth   = 6;
    ctx.beginPath(); ctx.arc(64, 64, 50, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(64, 64, 28, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2.5;
    [[64,14,64,48],[64,80,64,114],[14,64,48,64],[80,64,114,64]].forEach(
      ([x1,y1,x2,y2]) => { ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); }
    );
    rtex.update();
    rtex.hasAlpha = true;

    const mat = new StandardMaterial('reticleMat', this.scene);
    mat.diffuseTexture  = rtex;
    mat.emissiveTexture = rtex;
    mat.opacityTexture  = rtex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;

    for (const id of ['reticle_port', 'reticle_stbd']) {
      const d = MeshBuilder.CreateDisc(id, { radius: 3.5, tessellation: 40 }, this.scene);
      d.rotation.x = Math.PI / 2;
      d.position.y = 0.30;
      d.material   = mat;
      d.isPickable = false;
      d.setEnabled(false);
      if (id === 'reticle_port') this.reticlePort = d;
      else                       this.reticleStbd = d;
    }
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
      l.range     = 10;
      return l;
    };
    this.flashPort = make('cannonFlashPort');
    this.flashStbd = make('cannonFlashStbd');
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
    this.flamePortPS = makeFlame('flamePort', this.flamePortEmit);
    this.flameStbdPS = makeFlame('flameStbd', this.flameStbdEmit);
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
    this.smokePortPS = makeSmoke('smokePort', this.smokePortEmit);
    this.smokeStbdPS = makeSmoke('smokeStbd', this.smokeStbdEmit);
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

  // ── Cannon traversal pivots ───────────────────────────────────────────────
  //
  // Each cannon assembly (9 parts) is re-parented from the vessel root to a
  // shared TransformNode whose position is the barrel trunnion point.
  // Rotating that node's Y axis swings the whole assembly in azimuth.
  //
  // Pivot coordinate-frame maths (Ry(α) maps +X → (cosα, 0, -sinα) in Babylon):
  //   portPivot.rotation.y = +clamped   → muzzle sweeps port-beam → bow    ✓
  //   stbdPivot.rotation.y = -clamped   → muzzle sweeps stbd-beam → bow    ✓

  private setupCannonPivots(): void {
    const root = this.vesselService.getRoot();

    const reparent = (
      pivotPos: Vector3,
      names: string[],
    ): TransformNode => {
      const pivot = new TransformNode('cannon_pivot', this.scene);
      pivot.parent   = root;
      pivot.position = pivotPos.clone();
      for (const name of names) {
        const m = this.scene.getMeshByName(name);
        if (!m) continue;
        // m.position is currently in vessel-root-local space.
        // After re-parenting, subtract the pivot's root-local offset so the
        // mesh retains the same world position.
        const orig = m.position.clone();
        m.parent      = pivot;
        m.position.x  = orig.x - pivotPos.x;
        m.position.y  = orig.y - pivotPos.y;
        m.position.z  = orig.z - pivotPos.z;
      }
      return pivot;
    };

    // GLB with 180° Y-flip: sloop-cannon-port.glb stays on the port side (-X),
    // sloop-cannon-starboard.glb stays on the starboard side (+X).
    this.portPivot = reparent(new Vector3(-1.66, 2.57, 2.16), ['sloop_cannon_port']);
    this.stbdPivot = reparent(new Vector3( 1.64, 2.51, 2.18), ['sloop_cannon_stbd']);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private setupInput(): void {
    this.ctxMenuFn = (e: Event) => e.preventDefault();
    this.canvas.addEventListener('contextmenu', this.ctxMenuFn);

    // Both press and release through BabylonJS's pointer observable — avoids
    // the macOS context-menu swallowing of raw window.mouseup for button 2.
    this.pointerObserver = this.scene.onPointerObservable.add((info) => {
      if (info.event.button !== 2) return;

      if (info.type === PointerEventTypes.POINTERDOWN) {
        this.chargeT = 0;
        this.updateAim(info.event.clientX, info.event.clientY);
        this.zone.run(() => { this.isCharging.set(true); this.chargeLevel.set(0); });
        // Reticle visibility set in tick() once active side is known

      } else if (info.type === PointerEventTypes.POINTERUP) {
        if (!this.isCharging()) return;
        const charge = Math.min(this.chargeT / MAX_CHARGE, 1.0);
        this.zone.run(() => { this.isCharging.set(false); this.chargeLevel.set(0); });
        this.reticlePort.setEnabled(false);
        this.reticleStbd.setEnabled(false);
        this.fire(charge);
      }
    });

    this.mouseMoveFn = (e: MouseEvent) => {
      if (!this.isCharging()) return;
      this.updateAim(e.clientX, e.clientY);
    };
    window.addEventListener('mousemove', this.mouseMoveFn);
  }

  // ── Aim update with arc clamping ──────────────────────────────────────────
  //
  // The aim direction is clamped so it stays within ±ARC_HALF of the beam.
  // This is the realistic firing arc of a fixed broadside cannon — it can
  // traverse somewhat forward and aft but cannot fire through the bow or stern.
  //
  // Coordinate frame:
  //   forward   = (sin hRad,  cos hRad) in world XZ   (+Z = north/bow)
  //   port beam = (-cos hRad, sin hRad)                (90° CCW from forward)
  //   stbd beam = ( cos hRad,-sin hRad)                (90° CW from forward)

  private updateAim(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    const ray = this.scene.createPickingRay(sx, sy, Matrix.Identity(), this.scene.activeCamera);
    if (Math.abs(ray.direction.y) < 0.001) return;

    const t       = -ray.origin.y / ray.direction.y;
    const targetX = ray.origin.x + t * ray.direction.x;
    const targetZ = ray.origin.z + t * ray.direction.z;

    const vs   = this.vesselService.state();
    const hRad = vs.heading * Math.PI / 180;
    const sinH = Math.sin(hRad);
    const cosH = Math.cos(hRad);

    // Raw aim direction from vessel centre
    const dx  = targetX - vs.x;
    const dz  = targetZ - vs.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.5) return;
    const rawX = dx / len;
    const rawZ = dz / len;

    // Port beam direction; if dotPort >= 0 the cursor is on the port side
    const portBeamX = -cosH;
    const portBeamZ =  sinH;
    const dotPort   = rawX * portBeamX + rawZ * portBeamZ;
    const isPort    = dotPort >= 0;

    // Active beam direction for this side
    const beamX = isPort ?  portBeamX : -portBeamX;
    const beamZ = isPort ?  portBeamZ : -portBeamZ;

    // Decompose raw aim into (beam, forward) components, then clamp the
    // angle from the beam axis to ±ARC_HALF.
    const compBeam = rawX * beamX + rawZ * beamZ;
    const compFwd  = rawX * sinH  + rawZ * cosH;
    const angle    = Math.atan2(compFwd, Math.max(0.001, compBeam));
    const clamped  = Math.max(-ARC_HALF, Math.min(ARC_HALF, angle));

    // Store for use in tick() to drive pivot traversal rotation
    this.clampedAngle = clamped;

    // Reconstruct unit aim vector from clamped angle
    // (beam and forward are orthogonal unit vectors → result is unit length)
    this.aimDirX = Math.cos(clamped) * beamX + Math.sin(clamped) * sinH;
    this.aimDirZ = Math.cos(clamped) * beamZ + Math.sin(clamped) * cosH;
  }

  // ── Main tick ─────────────────────────────────────────────────────────────

  private tick(dt: number): void {
    this.elapsed += dt;

    // ── Charge accumulation + reticle ────────────────────────────────────────
    if (this.isCharging()) {
      this.chargeT = Math.min(this.chargeT + dt, MAX_CHARGE);
      const charge = this.chargeT / MAX_CHARGE;
      this.zone.run(() => this.chargeLevel.set(charge));

      const vs   = this.vesselService.state();
      const hRad = vs.heading * Math.PI / 180;
      const sinH = Math.sin(hRad);
      const cosH = Math.cos(hRad);

      // Determine active side from current aim direction vs. port beam
      const portBeamX = -cosH, portBeamZ = sinH;
      const isPort    = (this.aimDirX * portBeamX + this.aimDirZ * portBeamZ) >= 0;
      const side: 'port' | 'stbd' = isPort ? 'port' : 'stbd';
      if (this.activeSide() !== side) {
        this.zone.run(() => this.activeSide.set(side));
      }

      // Active muzzle world position (local muzzle → world via heading rotation)
      const muz  = isPort ? PORT_MUZ : STBD_MUZ;
      const mwx  = vs.x + muz.x * cosH + muz.z * sinH;
      const mwz  = vs.z - muz.x * sinH + muz.z * cosH;

      // Landing spot from muzzle in the clamped aim direction
      const v   = MIN_V + charge * (MAX_V - MIN_V);
      const vh  = v * Math.cos(ELEV_RAD);
      const T   = 2 * v * Math.sin(ELEV_RAD) / G;
      const lx  = mwx + this.aimDirX * vh * T;
      const lz  = mwz + this.aimDirZ * vh * T;

      // Show only the active reticle
      const pulse = 1.0 + 0.15 * Math.sin(this.elapsed * 8);
      const scale = (0.55 + charge * 0.65) * pulse;

      if (isPort) {
        this.reticlePort.setEnabled(true);
        this.reticleStbd.setEnabled(false);
        this.reticlePort.position.x = lx;
        this.reticlePort.position.z = lz;
        this.reticlePort.scaling.setAll(scale);
      } else {
        this.reticleStbd.setEnabled(true);
        this.reticlePort.setEnabled(false);
        this.reticleStbd.position.x = lx;
        this.reticleStbd.position.z = lz;
        this.reticleStbd.scaling.setAll(scale);
      }

      // ── Cannon traversal ─────────────────────────────────────────────────────
      // The active cannon instantly tracks the clamped aim angle.
      // The inactive cannon smoothly returns to the beam-rest position.
      // Pivot rotation maths derived from BabylonJS YXZ Euler + Ry(α) analysis:
      //   portPivot.rotation.y = +clamped → port muzzle sweeps toward bow  ✓
      //   stbdPivot.rotation.y = −clamped → stbd muzzle sweeps toward bow  ✓
      if (this.portPivot) {
        const returnFactor = Math.exp(-8 * dt);
        if (isPort) {
          this.portPivot.rotation.y = this.clampedAngle;
          this.stbdPivot.rotation.y *= returnFactor;
        } else {
          this.portPivot.rotation.y *= returnFactor;
          this.stbdPivot.rotation.y = -this.clampedAngle;
        }
      }
    } else {
      // Not charging — both cannons drift back to beam-rest position
      if (this.portPivot) {
        const returnFactor = Math.exp(-5 * dt);
        this.portPivot.rotation.y *= returnFactor;
        this.stbdPivot.rotation.y *= returnFactor;
      }
    }

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
    this.decayFlash(this.flashPort, this.flashPortEndT);
    this.decayFlash(this.flashStbd, this.flashStbdEndT);

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
  }

  private decayFlash(light: PointLight, endT: number): void {
    if (!light || endT < 0 || this.elapsed >= endT) {
      if (light) light.intensity = 0;
      return;
    }
    const env = (endT - this.elapsed) / 0.45;
    light.intensity = env * 4.5 * (0.75 + 0.25 * Math.random());
  }

  // ── Fire ──────────────────────────────────────────────────────────────────

  private fire(charge: number): void {
    if (charge < 0.04) return;
    const clamp = Math.max(0.12, charge);
    const v     = MIN_V + clamp * (MAX_V - MIN_V);
    const vh    = v * Math.cos(ELEV_RAD);
    const vy    = v * Math.sin(ELEV_RAD);

    const vs   = this.vesselService.state();
    const hRad = vs.heading * Math.PI / 180;
    const sinH = Math.sin(hRad);
    const cosH = Math.cos(hRad);

    // Active side is whatever was last shown in tick()
    const isPort = this.activeSide() === 'port';
    const muz    = isPort ? PORT_MUZ : STBD_MUZ;
    const mwx    = vs.x + muz.x * cosH + muz.z * sinH;
    const mwy    = muz.y;
    const mwz    = vs.z - muz.x * sinH + muz.z * cosH;

    const bvx = this.aimDirX * vh;
    const bvz = this.aimDirZ * vh;

    this.launchBall(mwx, mwy, mwz, bvx, vy, bvz);
    this.multiplayerService.broadcastShot(mwx, mwy, mwz, bvx, vy, bvz);

    // Flash + muzzle effects on the active side
    const fSpread = 0.18;
    const sSpread = 0.40;
    const flamePS = isPort ? this.flamePortPS : this.flameStbdPS;
    const smokePS = isPort ? this.smokePortPS : this.smokeStbdPS;
    const flash   = isPort ? this.flashPort   : this.flashStbd;
    const fEmit   = isPort ? this.flamePortEmit : this.flameStbdEmit;
    const sEmit   = isPort ? this.smokePortEmit : this.smokeStbdEmit;

    flash.position.set(mwx, mwy, mwz);
    if (isPort) this.flashPortEndT = this.elapsed + 0.45;
    else        this.flashStbdEndT = this.elapsed + 0.45;

    flamePS.direction1.set(this.aimDirX - fSpread, 0.06, this.aimDirZ - fSpread);
    flamePS.direction2.set(this.aimDirX + fSpread, 0.32, this.aimDirZ + fSpread);
    smokePS.direction1.set(this.aimDirX - sSpread, 0.18, this.aimDirZ - sSpread);
    smokePS.direction2.set(this.aimDirX + sSpread, 1.10, this.aimDirZ + sSpread);
    fEmit.set(mwx, mwy, mwz);
    sEmit.set(mwx, mwy, mwz);

    flamePS.emitRate = 450;
    smokePS.emitRate = 110;
    this.flameCutoffT = this.elapsed + 0.18;
    this.smokeCutoffT = this.elapsed + 1.4;

    this.vesselService.addCannonRecoil();
    this.playCannonSound();
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

  private playCannonSound(): void {
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
    crackGain.gain.setValueAtTime(1.4, t); crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    crack.connect(crackHpf); crackHpf.connect(crackGain); crackGain.connect(ctx.destination);
    crack.start(t); crack.stop(t + 0.13);

    const boomBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
    const bd = boomBuf.getChannelData(0);
    for (let i = 0; i < bd.length; i++) bd[i] = Math.random() * 2 - 1;
    const boom = ctx.createBufferSource(); boom.buffer = boomBuf;
    const boomLpf = ctx.createBiquadFilter(); boomLpf.type = 'lowpass';
    boomLpf.frequency.setValueAtTime(600, t); boomLpf.frequency.exponentialRampToValueAtTime(55, t + 0.5);
    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(1.1, t); boomGain.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    boom.connect(boomLpf); boomLpf.connect(boomGain); boomGain.connect(ctx.destination);
    boom.start(t); boom.stop(t + 1.2);

    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(72, t); osc.frequency.exponentialRampToValueAtTime(22, t + 0.55);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.70, t); oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    osc.connect(oscGain); oscGain.connect(ctx.destination);
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
    src.connect(hpf); hpf.connect(bpf); bpf.connect(gain); gain.connect(ctx.destination);
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
    src.connect(lpf); lpf.connect(noiseGain); noiseGain.connect(ctx.destination);
    src.start(t); src.stop(t + 0.30);

    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(100, t); osc.frequency.exponentialRampToValueAtTime(28, t + 0.22);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.65, t); thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(thudGain); thudGain.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.25);
  }

  // ── Impact ────────────────────────────────────────────────────────────────

  private onImpact(wx: number, wz: number): void {
    const isLand = this.islandService.isOnLand(wx, wz);
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
