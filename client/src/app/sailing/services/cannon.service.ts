import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  Scene, Mesh, MeshBuilder, Vector3, Color3, Color4,
  StandardMaterial, DynamicTexture, ParticleSystem, PointLight,
} from '@babylonjs/core';
import { SceneService }   from './scene.service';
import { VesselService }  from './vessel.service';
import { IslandService }  from './island.service';

// ── Constants ─────────────────────────────────────────────────────────────────

const G             = 9.81;
const MAX_CHARGE    = 2.8;          // seconds of hold for full charge
const MIN_V         = 20;           // muzzle velocity (m/s) at minimum charge
const MAX_V         = 72;           // muzzle velocity at full charge
const ELEV_RAD      = 11 * Math.PI / 180;  // fixed launch elevation
const BALL_POOL     = 8;            // max simultaneous cannonballs

// Muzzle tip in vessel root-local space.
// Barrel cylinder (h=1.26) centred at x=±2.10 → tip at ±(2.10 + 0.63) = ±2.73
const PORT_MUZ = { x: -2.73, y: 1.48, z: 0 } as const;
const STBD_MUZ = { x:  2.73, y: 1.48, z: 0 } as const;

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
  private sceneService  = inject(SceneService);
  private vesselService = inject(VesselService);
  private islandService = inject(IslandService);
  private zone          = inject(NgZone);

  // ── Public signals (consumed by HUD / GameComponent) ─────────────────────
  readonly isCharging  = signal(false);
  readonly chargeLevel = signal(0);     // 0 → 1

  // ── Private state ─────────────────────────────────────────────────────────
  private scene!:   Scene;
  private elapsed = 0;
  private chargeT = 0;                  // seconds spacebar has been held

  // Reticles — flat discs floating just above the water surface
  private reticlePort!: Mesh;
  private reticleStbd!: Mesh;

  // Cannonball pool
  private balls: Ball[] = [];

  // Muzzle-flash point lights (two, one per cannon, reused)
  private flashPort!: PointLight;
  private flashStbd!: PointLight;
  private flashPortEndT = -1;
  private flashStbdEndT = -1;

  // Muzzle blast (flame) particle systems — short bright horizontal burst
  private flamePortPS!:  ParticleSystem;
  private flameStbdPS!:  ParticleSystem;
  private flamePortEmit  = new Vector3(0, 0, 0);
  private flameStbdEmit  = new Vector3(0, 0, 0);
  private flameCutoffT   = -1;

  // Smoke particle systems — grey-brown plume that drifts outward then rises
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

  // Input handlers (stored for cleanup)
  private keyDownFn!: (e: KeyboardEvent) => void;
  private keyUpFn!:   (e: KeyboardEvent) => void;

  // Web Audio context for sound effects (separate from Tone.js music context)
  private sfxCtx: AudioContext | null = null;

  // ── Init / dispose ────────────────────────────────────────────────────────

  init(): void {
    this.scene = this.sceneService.scene;
    this.sfxCtx = new AudioContext();
    this.buildParticleTex();         // shared soft-blob texture
    this.buildReticles();
    this.buildBallPool();
    this.buildFlashLights();
    this.buildFlameParticles();
    this.buildSmokeParticles();
    this.buildImpactParticles();
    this.setupInput();
    this.scene.registerBeforeRender(() => {
      const dt = Math.min(this.scene.getEngine().getDeltaTime() * 0.001, 0.05);
      this.tick(dt);
    });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyDownFn);
    window.removeEventListener('keyup',   this.keyUpFn);
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

  // ── Shared soft-blob texture for all particle systems ─────────────────────

  private blobTex!: DynamicTexture;

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
    // Procedural target ring on a DynamicTexture
    const rtex = new DynamicTexture('reticleTex', { width: 128, height: 128 }, this.scene, false);
    const ctx  = rtex.getContext() as CanvasRenderingContext2D;
    // Outer ring
    ctx.strokeStyle = 'rgba(255, 210, 50, 0.95)';
    ctx.lineWidth   = 6;
    ctx.beginPath(); ctx.arc(64, 64, 50, 0, Math.PI * 2); ctx.stroke();
    // Inner ring
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(64, 64, 28, 0, Math.PI * 2); ctx.stroke();
    // Crosshairs
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
      d.rotation.x    = Math.PI / 2;   // lie flat on the water
      d.position.y    = 0.30;
      d.material      = mat;
      d.isPickable    = false;
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
  // Short, bright, horizontal — direction updated at fire() time from heading.

  private buildFlameParticles(): void {
    const makeFlame = (name: string, emitVec: Vector3) => {
      const ps = new ParticleSystem(name, 140, this.scene);
      ps.particleTexture = this.blobTex;
      ps.emitter    = emitVec;
      ps.minEmitBox = new Vector3(-0.15, -0.10, -0.15);
      ps.maxEmitBox = new Vector3( 0.15,  0.10,  0.15);
      // White-hot core → orange → nothing
      ps.color1     = new Color4(1.00, 0.98, 0.80, 1.00);
      ps.color2     = new Color4(1.00, 0.50, 0.06, 0.90);
      ps.colorDead  = new Color4(0.55, 0.18, 0.01, 0.00);
      ps.minSize      = 0.50;  ps.maxSize      = 2.20;   // big enough to see clearly
      ps.minLifeTime  = 0.14;  ps.maxLifeTime  = 0.45;   // longer so it's not just 3 frames
      ps.minEmitPower = 8;     ps.maxEmitPower = 22;
      ps.updateSpeed  = 0.016;
      // Placeholder directions — overwritten each fire() with correct heading
      ps.direction1   = new Vector3(-1, 0.05, 0);
      ps.direction2   = new Vector3(-1, 0.30, 0);
      ps.gravity      = new Vector3(0, -0.8, 0);   // gentle droop, stays visible
      ps.blendMode    = ParticleSystem.BLENDMODE_ADD;
      ps.renderingGroupId = 1;                      // render after ocean geometry
      ps.emitRate     = 0;
      ps.start();
      return ps;
    };
    this.flamePortPS = makeFlame('flamePort', this.flamePortEmit);
    this.flameStbdPS = makeFlame('flameStbd', this.flameStbdEmit);
  }

  // ── Smoke particle systems ─────────────────────────────────────────────────
  // Grey-brown plume that drifts outward then slowly rises.
  // Direction updated at fire() time from heading.

  private buildSmokeParticles(): void {
    const makeSmoke = (name: string, emitVec: Vector3) => {
      const ps = new ParticleSystem(name, 160, this.scene);
      ps.particleTexture = this.blobTex;
      ps.emitter    = emitVec;
      ps.minEmitBox = new Vector3(-0.22, -0.10, -0.22);
      ps.maxEmitBox = new Vector3( 0.22,  0.10,  0.22);
      // Grey-brown gunpowder smoke — slightly more opaque so it reads clearly
      ps.color1     = new Color4(0.65, 0.60, 0.52, 0.85);
      ps.color2     = new Color4(0.45, 0.42, 0.38, 0.70);
      ps.colorDead  = new Color4(0.28, 0.28, 0.28, 0.00);
      ps.minSize      = 1.2;   ps.maxSize      = 5.0;
      ps.minLifeTime  = 1.0;   ps.maxLifeTime  = 3.0;
      ps.minEmitPower = 0.8;   ps.maxEmitPower = 3.5;
      ps.updateSpeed  = 0.016;
      // Placeholder — overwritten each fire() with correct heading
      ps.direction1   = new Vector3(-0.5, 0.3, -0.5);
      ps.direction2   = new Vector3( 0.5, 1.5,  0.5);
      ps.gravity      = new Vector3(0, 0.9, 0);   // smoke rises over its lifetime
      ps.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
      ps.renderingGroupId = 1;                     // render after ocean geometry
      ps.emitRate     = 0;
      ps.start();
      return ps;
    };
    this.smokePortPS = makeSmoke('smokePort', this.smokePortEmit);
    this.smokeStbdPS = makeSmoke('smokeStbd', this.smokeStbdEmit);
  }

  // ── Impact particle systems ───────────────────────────────────────────────

  private buildImpactParticles(): void {
    // Water splash
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

    // Dirt puff
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
    this.keyDownFn = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      e.preventDefault();
      this.chargeT = 0;
      this.zone.run(() => { this.isCharging.set(true); this.chargeLevel.set(0); });
      this.reticlePort.setEnabled(true);
      this.reticleStbd.setEnabled(true);
    };
    this.keyUpFn = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !this.isCharging()) return;
      e.preventDefault();
      const charge = Math.min(this.chargeT / MAX_CHARGE, 1.0);
      this.zone.run(() => { this.isCharging.set(false); this.chargeLevel.set(0); });
      this.reticlePort.setEnabled(false);
      this.reticleStbd.setEnabled(false);
      this.fire(charge);
    };
    window.addEventListener('keydown', this.keyDownFn);
    window.addEventListener('keyup',   this.keyUpFn);
  }

  // ── Main tick ─────────────────────────────────────────────────────────────

  private tick(dt: number): void {
    this.elapsed += dt;

    // ── Charge accumulation + reticle update ─────────────────────────────────
    if (this.isCharging()) {
      this.chargeT = Math.min(this.chargeT + dt, MAX_CHARGE);
      const charge = this.chargeT / MAX_CHARGE;
      this.zone.run(() => this.chargeLevel.set(charge));

      const vs   = this.vesselService.state();
      const hRad = vs.heading * Math.PI / 180;
      const v    = MIN_V + charge * (MAX_V - MIN_V);
      const { portLand, stbdLand } = this.computeLanding(vs.x, vs.z, hRad, v);

      // Pulse: shrinks slightly and grows back — draws the eye to the target
      const pulse = 1.0 + 0.15 * Math.sin(this.elapsed * 8);
      const scale = (0.55 + charge * 0.65) * pulse;

      this.reticlePort.position.x = portLand.x;
      this.reticlePort.position.z = portLand.z;
      this.reticlePort.scaling.setAll(scale);

      this.reticleStbd.position.x = stbdLand.x;
      this.reticleStbd.position.z = stbdLand.z;
      this.reticleStbd.scaling.setAll(scale);
    }

    // ── Active cannonball arcs ────────────────────────────────────────────────
    for (const ball of this.balls) {
      if (!ball.alive) continue;
      ball.t += dt;
      const bx = ball.ox + ball.vx * ball.t;
      const by = ball.oy + ball.vy * ball.t - 0.5 * G * ball.t * ball.t;
      const bz = ball.oz + ball.vz * ball.t;
      ball.mesh.position.set(bx, by, bz);
      ball.mesh.rotation.z += dt * 5;   // visible spin

      // Impact: hit ground level (accounting for wave crests staying ~<2 m above 0)
      // or max flight time guard of 25 s
      if ((by < 0.8 && ball.t > 0.4) || ball.t > 25) {
        this.onImpact(bx, bz);
        ball.alive = false;
        ball.mesh.setEnabled(false);
      }
    }

    // ── Muzzle flash lights decay ─────────────────────────────────────────────
    this.updateFlash(this.flashPort, this.flashPortEndT);
    this.updateFlash(this.flashStbd, this.flashStbdEndT);

    // ── Particle burst cutoffs (one-shot burst → emitRate → 0) ───────────────
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

  private updateFlash(light: PointLight, endT: number): void {
    if (!light || endT < 0 || this.elapsed >= endT) {
      if (light) light.intensity = 0;
      return;
    }
    const remaining = endT - this.elapsed;
    const env = remaining / 0.45;                      // 1 → 0 over flash duration
    light.intensity = env * 4.5 * (0.75 + 0.25 * Math.random());
  }

  // ── Compute landing spots ─────────────────────────────────────────────────

  private computeLanding(
    bx: number, bz: number, hRad: number, v: number,
  ): { portLand: { x: number; z: number }; stbdLand: { x: number; z: number } } {
    const cosH = Math.cos(hRad), sinH = Math.sin(hRad);
    // Root-local → world transform for each muzzle tip
    const pMx = bx + PORT_MUZ.x * cosH;  const pMz = bz - PORT_MUZ.x * sinH;
    const sMx = bx + STBD_MUZ.x * cosH;  const sMz = bz - STBD_MUZ.x * sinH;
    // Perpendicular unit vectors: port = (-cosH, sinH), stbd = (cosH, -sinH)
    const vh = v * Math.cos(ELEV_RAD);
    const T  = 2 * v * Math.sin(ELEV_RAD) / G;   // symmetric time of flight
    return {
      portLand: { x: pMx + (-cosH) * vh * T,  z: pMz + ( sinH) * vh * T  },
      stbdLand: { x: sMx + ( cosH) * vh * T,  z: sMz + (-sinH) * vh * T  },
    };
  }

  // ── Fire ──────────────────────────────────────────────────────────────────

  private fire(charge: number): void {
    if (charge < 0.04) return;   // ignore accidental taps
    const clamp = Math.max(0.12, charge);
    const v     = MIN_V + clamp * (MAX_V - MIN_V);
    const vh    = v * Math.cos(ELEV_RAD);
    const vy    = v * Math.sin(ELEV_RAD);

    const vs   = this.vesselService.state();
    const hRad = vs.heading * Math.PI / 180;
    const cosH = Math.cos(hRad), sinH = Math.sin(hRad);

    // Muzzle world positions
    const pMx = vs.x + PORT_MUZ.x * cosH, pMy = PORT_MUZ.y, pMz = vs.z - PORT_MUZ.x * sinH;
    const sMx = vs.x + STBD_MUZ.x * cosH, sMy = STBD_MUZ.y, sMz = vs.z - STBD_MUZ.x * sinH;

    // Port fires in (-cosH, sinH) direction; stbd fires in (+cosH, -sinH)
    this.launchBall(pMx, pMy, pMz, -cosH * vh, vy,  sinH * vh);
    this.launchBall(sMx, sMy, sMz,  cosH * vh, vy, -sinH * vh);

    // Muzzle flash lights
    this.flashPort.position.set(pMx, pMy, pMz);  this.flashPortEndT = this.elapsed + 0.45;
    this.flashStbd.position.set(sMx, sMy, sMz);  this.flashStbdEndT = this.elapsed + 0.45;

    // ── Directional muzzle effects ───────────────────────────────────────────
    // Port fires in (-cosH, 0, sinH); stbd fires in (+cosH, 0, -sinH).
    // We bake the heading into direction1/direction2 so particles fly out of
    // the barrel rather than straight up.
    const fSpread = 0.18;   // half-cone for flame  (~±10°)
    const sSpread = 0.40;   // half-cone for smoke  (~±23°, looser puff)

    // Port cannon — outward direction is (-cosH, 0, sinH)
    this.flamePortPS.direction1.set(-cosH - fSpread, 0.06, sinH - fSpread);
    this.flamePortPS.direction2.set(-cosH + fSpread, 0.32, sinH + fSpread);
    this.smokePortPS.direction1.set(-cosH - sSpread, 0.18, sinH - sSpread);
    this.smokePortPS.direction2.set(-cosH + sSpread, 1.10, sinH + sSpread);

    // Starboard cannon — outward direction is (+cosH, 0, -sinH)
    this.flameStbdPS.direction1.set( cosH - fSpread, 0.06, -sinH - fSpread);
    this.flameStbdPS.direction2.set( cosH + fSpread, 0.32, -sinH + fSpread);
    this.smokeStbdPS.direction1.set( cosH - sSpread, 0.18, -sinH - sSpread);
    this.smokeStbdPS.direction2.set( cosH + sSpread, 1.10, -sinH + sSpread);

    // Position emitters at muzzle tips
    this.flamePortEmit.set(pMx, pMy, pMz);
    this.flameStbdEmit.set(sMx, sMy, sMz);
    this.smokePortEmit.set(pMx, pMy, pMz);
    this.smokeStbdEmit.set(sMx, sMy, sMz);

    // Flame burst: very short (0.18 s) — the initial fireball
    this.flamePortPS.emitRate = 450;
    this.flameStbdPS.emitRate = 450;
    this.flameCutoffT = this.elapsed + 0.18;

    // Smoke cloud: longer (1.4 s) — lingers and rises
    this.smokePortPS.emitRate = 110;
    this.smokeStbdPS.emitRate = 110;
    this.smokeCutoffT = this.elapsed + 1.4;

    // Ship recoil + cannon boom
    this.vesselService.addCannonRecoil();
    this.playCannonSound();
  }

  private launchBall(
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

  // ── Sound effects (synthesised via Web Audio API) ─────────────────────────

  /** Cannon boom: deep low-frequency rumble + wideband crack transient. */
  private playCannonSound(): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;

    // ── Crack transient ───────────────────────────────────────────────────
    const crackBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
    const cd = crackBuf.getChannelData(0);
    for (let i = 0; i < cd.length; i++) cd[i] = Math.random() * 2 - 1;
    const crack = ctx.createBufferSource();
    crack.buffer = crackBuf;

    const crackHpf = ctx.createBiquadFilter();
    crackHpf.type = 'highpass';
    crackHpf.frequency.value = 1200;

    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(1.4, t);
    crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    crack.connect(crackHpf);
    crackHpf.connect(crackGain);
    crackGain.connect(ctx.destination);
    crack.start(t); crack.stop(t + 0.13);

    // ── Low boom ──────────────────────────────────────────────────────────
    const boomBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
    const bd = boomBuf.getChannelData(0);
    for (let i = 0; i < bd.length; i++) bd[i] = Math.random() * 2 - 1;
    const boom = ctx.createBufferSource();
    boom.buffer = boomBuf;

    const boomLpf = ctx.createBiquadFilter();
    boomLpf.type = 'lowpass';
    boomLpf.frequency.setValueAtTime(600, t);
    boomLpf.frequency.exponentialRampToValueAtTime(55, t + 0.5);

    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(1.1, t);
    boomGain.gain.exponentialRampToValueAtTime(0.001, t + 1.1);

    boom.connect(boomLpf);
    boomLpf.connect(boomGain);
    boomGain.connect(ctx.destination);
    boom.start(t); boom.stop(t + 1.2);

    // ── Low-sine resonance (cannon barrel "ring") ─────────────────────────
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(72, t);
    osc.frequency.exponentialRampToValueAtTime(22, t + 0.55);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.70, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);

    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.56);
  }

  /** Water splash: band-pass filtered noise burst. */
  private playSplashSound(): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;

    const bufLen = Math.floor(ctx.sampleRate * 0.55);
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const d      = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Highpass removes deep rumble, bandpass adds splashy midrange character
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 180;

    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(900, t);
    bpf.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    bpf.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.85, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.50);

    src.connect(hpf); hpf.connect(bpf); bpf.connect(gain); gain.connect(ctx.destination);
    src.start(t); src.stop(t + 0.56);
  }

  /** Land impact: sharp crack + earthy thud. */
  private playLandImpactSound(): void {
    const ctx = this.sfxCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;

    // ── Crack ────────────────────────────────────────────────────────────
    const bufLen = Math.floor(ctx.sampleRate * 0.3);
    const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const d      = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.setValueAtTime(3500, t);
    lpf.frequency.exponentialRampToValueAtTime(250, t + 0.25);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(1.0, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);

    src.connect(lpf); lpf.connect(noiseGain); noiseGain.connect(ctx.destination);
    src.start(t); src.stop(t + 0.30);

    // ── Thud ─────────────────────────────────────────────────────────────
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(100, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.22);

    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.65, t);
    thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);

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
