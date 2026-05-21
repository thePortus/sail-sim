import { Injectable, inject } from '@angular/core';
import {
  Scene, MeshBuilder, StandardMaterial, Color3, Color4, Vector3,
  DynamicTexture, Mesh, TransformNode, ParticleSystem,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { Weather } from '../models';

const CLOUD_SPREAD   = 45000;   // world area seeded with clouds
const CLUSTER_COUNT  = 28;      // number of cloud groups
const ALT_HIGH       = 3800;    // altitude in calm weather
const ALT_LOW        = 1400;    // altitude in storm weather

@Injectable({ providedIn: 'root' })
export class CloudService {
  private sceneService = inject(SceneService);

  private cloudRoots:  TransformNode[] = [];
  private cirrusRoots: TransformNode[] = [];
  private cloudMat!:   StandardMaterial;
  private cirrusMat!:  StandardMaterial;
  private rainSystem:       ParticleSystem | null = null;
  private cloudPuffSystems: ParticleSystem[]      = [];
  private puffTex!:         DynamicTexture;
  private rainPos      = new Vector3(0, 80, 0);

  private windX      = 5;
  private windZ      = 3;
  private stormLevel = 0;   // 0 = calm → 1 = max storm (drives tick() colour blending)

  init(): void {
    const scene = this.sceneService.scene;
    this.buildCloudMaterial(scene);
    this.buildClouds(scene);
    this.buildCirrusLayer(scene);
    this.buildRainSystem(scene);
    this.buildCloudPuffSystems(scene);

    scene.registerBeforeRender(() => {
      const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
      this.tick(dt);
    });
  }

  // ── Cloud texture: multi-puff layered detail ─────────────────────────────────

  private buildCloudMaterial(scene: Scene): void {
    // 512×256 canvas — six overlapping radial gradients produce a bumpy cumulonimbus
    // silhouette rather than a single smooth ellipse.
    const tex = new DynamicTexture('cloudTex', { width: 512, height: 256 }, scene, false);
    const ctx  = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 256);

    // Each puff centre adds its own bright core, creating uneven lumpy edges.
    const puffs = [
      { cx: 256, cy: 128, r: 140 },   // main body
      { cx: 168, cy: 108, r:  96 },   // left lobe
      { cx: 344, cy: 112, r:  88 },   // right lobe
      { cx: 256, cy:  88, r:  72 },   // top dome
      { cx: 196, cy: 154, r:  60 },   // lower-left
      { cx: 316, cy: 150, r:  56 },   // lower-right
    ];

    for (const p of puffs) {
      const grd = ctx.createRadialGradient(p.cx, p.cy, 0, p.cx, p.cy, p.r);
      grd.addColorStop(0.00, 'rgba(255,255,255,0.92)');
      grd.addColorStop(0.25, 'rgba(248,250,255,0.72)');
      grd.addColorStop(0.55, 'rgba(240,245,255,0.30)');
      grd.addColorStop(0.85, 'rgba(235,242,255,0.06)');
      grd.addColorStop(1.00, 'rgba(255,255,255,0.00)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, 512, 256);
    }
    tex.update();
    tex.hasAlpha = true;

    this.cloudMat = new StandardMaterial('cloudMat', scene);
    this.cloudMat.diffuseTexture             = tex;
    this.cloudMat.useAlphaFromDiffuseTexture = true;
    this.cloudMat.backFaceCulling            = false;
    this.cloudMat.disableLighting            = true;
    this.cloudMat.emissiveColor              = new Color3(1, 1, 1);
    this.cloudMat.alpha                      = 0.72;
  }

  // ── Cloud clusters ─────────────────────────────────────────────────────────

  private buildClouds(scene: Scene): void {
    const rng = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

    for (let i = 0; i < CLUSTER_COUNT; i++) {
      const cx    = rng(-CLOUD_SPREAD / 2, CLOUD_SPREAD / 2);
      const cy    = rng(ALT_LOW + 600, ALT_HIGH);
      const cz    = rng(-CLOUD_SPREAD / 2, CLOUD_SPREAD / 2);
      const scale = rng(1400, 5000);   // large variation in cloud sizes

      const root = new TransformNode(`cloud_${i}`, scene);
      root.position.set(cx, cy, cz);
      this.cloudRoots.push(root);

      // Each cluster = 3–6 overlapping billboard puffs at slightly offset positions
      const puffCount = 3 + Math.floor(Math.random() * 4);
      for (let j = 0; j < puffCount; j++) {
        const plane = MeshBuilder.CreatePlane(`puff_${i}_${j}`, {
          width:           scale * rng(0.7, 1.5),
          height:          scale * rng(0.28, 0.48),
          sideOrientation: Mesh.DOUBLESIDE,
        }, scene);
        plane.parent        = root;
        plane.position.set(
          rng(-scale * 0.45, scale * 0.45),
          rng(-scale * 0.06, scale * 0.06),
          rng(-scale * 0.25, scale * 0.25),
        );
        plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        plane.material      = this.cloudMat;
        plane.isPickable    = false;
        plane.receiveShadows = false;
      }
    }
  }

  // ── High-altitude cirrus cloud layer ─────────────────────────────────────────
  // Thin ice-crystal sheets at 7200–9800 altitude, rendered as wide horizontal planes.
  // They drift slowly (jet-stream speed ~35 % of the cumulus layer) and glow warm
  // pink-orange during golden hour.

  private buildCirrusLayer(scene: Scene): void {
    // Streaky 512×128 texture — overlapping feathered horizontal bands.
    const tex = new DynamicTexture('cirrusTex', { width: 512, height: 128 }, scene, false);
    const ctx  = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 128);

    for (let i = 0; i < 10; i++) {
      const sx  = Math.random() * 380;
      const sw  = 60 + Math.random() * 220;
      const sy  = 18 + Math.random() * 92;
      const sh  = 6  + Math.random() * 30;
      const op  = (0.40 + Math.random() * 0.50).toFixed(2);
      const grd = ctx.createLinearGradient(sx, 0, sx + sw, 0);
      grd.addColorStop(0.0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.3, `rgba(255,255,255,${op})`);
      grd.addColorStop(0.7, `rgba(255,255,255,${op})`);
      grd.addColorStop(1.0, 'rgba(255,255,255,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(sx, sy, sw, sh);
    }
    tex.update();
    tex.hasAlpha = true;

    this.cirrusMat = new StandardMaterial('cirrusMat', scene);
    this.cirrusMat.diffuseTexture             = tex;
    this.cirrusMat.useAlphaFromDiffuseTexture = true;
    this.cirrusMat.backFaceCulling            = false;
    this.cirrusMat.disableLighting            = true;
    this.cirrusMat.emissiveColor              = new Color3(1, 1, 1);
    this.cirrusMat.alpha                      = 0.38;

    const rng = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
    for (let i = 0; i < 22; i++) {
      const root = new TransformNode(`cirrus_${i}`, scene);
      root.position.set(
        rng(-CLOUD_SPREAD / 2, CLOUD_SPREAD / 2),
        rng(7200, 9800),
        rng(-CLOUD_SPREAD / 2, CLOUD_SPREAD / 2),
      );
      this.cirrusRoots.push(root);

      // Horizontal plane (rotated to lie in the XZ plane) — viewed from below at sea level.
      const plane = MeshBuilder.CreatePlane(`cirrus_${i}_plane`, {
        width:           rng(7000, 16000),
        height:          rng(1200,  3500),
        sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
      plane.parent     = root;
      plane.rotation.x = Math.PI / 2;            // lay flat in the sky
      plane.rotation.y = rng(0, Math.PI * 2);    // random streak orientation
      plane.material   = this.cirrusMat;
      plane.isPickable = false;
    }
  }

  // ── Rain particle system ───────────────────────────────────────────────────

  private buildRainSystem(scene: Scene): void {
    // 4×32 streak texture — thin vertical gradient (bright middle, transparent caps)
    const rainTex = new DynamicTexture('rainTex', { width: 4, height: 32 }, scene, false);
    const rCtx    = rainTex.getContext() as CanvasRenderingContext2D;
    const rGrd    = rCtx.createLinearGradient(0, 0, 0, 32);
    rGrd.addColorStop(0.00, 'rgba(180,215,255,0.00)');
    rGrd.addColorStop(0.15, 'rgba(180,215,255,0.90)');
    rGrd.addColorStop(0.85, 'rgba(180,215,255,0.90)');
    rGrd.addColorStop(1.00, 'rgba(180,215,255,0.00)');
    rCtx.fillStyle = rGrd;
    rCtx.fillRect(0, 0, 4, 32);
    rainTex.update();
    rainTex.hasAlpha = true;

    this.rainSystem = new ParticleSystem('rain', 6000, scene);
    this.rainSystem.particleTexture = rainTex;

    // Emitter hovers above camera and tracks it each frame
    this.rainSystem.emitter    = this.rainPos;
    this.rainSystem.minEmitBox = new Vector3(-220, 0, -220);
    this.rainSystem.maxEmitBox = new Vector3( 220, 0,  220);

    // Particle colour: pale blue-white, fades out
    this.rainSystem.color1    = new Color4(0.78, 0.88, 1.0, 0.55);
    this.rainSystem.color2    = new Color4(0.72, 0.82, 1.0, 0.35);
    this.rainSystem.colorDead = new Color4(0.72, 0.82, 1.0, 0.00);

    // BILLBOARDMODE_STRETCHED rotates each particle to align with its velocity,
    // turning tiny quads into convincing rain streaks with no per-particle work.
    this.rainSystem.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    this.rainSystem.minScaleX = 0.10;
    this.rainSystem.maxScaleX = 0.18;
    this.rainSystem.minScaleY = 1.6;
    this.rainSystem.maxScaleY = 3.2;

    this.rainSystem.minLifeTime = 0.30;
    this.rainSystem.maxLifeTime = 0.60;
    this.rainSystem.emitRate    = 0;   // off until precipitation is active

    // Direction is mostly downward; updated each weather tick to angle with wind
    this.rainSystem.direction1 = new Vector3(-1, -28, -1);
    this.rainSystem.direction2 = new Vector3( 1, -22,  1);

    this.rainSystem.minEmitPower = 4;
    this.rainSystem.maxEmitPower = 8;
    this.rainSystem.updateSpeed  = 0.016;
    this.rainSystem.gravity      = new Vector3(0, -9.8, 0);
    this.rainSystem.blendMode    = ParticleSystem.BLENDMODE_STANDARD;

    this.rainSystem.start();
  }

  // ── Per-cluster cloud-puff particle halos ─────────────────────────────────────
  // One particle system per every-other cloud cluster, emitted from the cluster's
  // first billboard pane so the halo drifts with its parent cloud automatically.
  //
  // Design mirrors the flight-sim reference: BLENDMODE_STANDARD keeps clouds from
  // blowing out at night or when many overlap; low emitRate + long lifetime means
  // the halos build up slowly and persist, adding softness and volumetric depth
  // without the over-bright flare of the old BLENDMODE_ADD global wispSystem.

  private buildCloudPuffSystems(scene: Scene): void {
    // 256×256 horizontally-wide ellipse gradient — rounder than a rain drop,
    // wider than it is tall so it reads as a cloud puff when billboarded.
    this.puffTex = new DynamicTexture('puffTex', { width: 256, height: 256 }, scene, false);
    const ctx    = this.puffTex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 256, 256);
    const grd = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0.00, 'rgba(255,255,255,1.00)');
    grd.addColorStop(0.28, 'rgba(255,255,255,0.76)');
    grd.addColorStop(0.58, 'rgba(255,255,255,0.22)');
    grd.addColorStop(1.00, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(128, 128, 128, 88, 0, 0, Math.PI * 2);   // wide oval
    ctx.fill();
    this.puffTex.update();
    this.puffTex.hasAlpha = true;

    // Attach one particle system to every 2nd cluster so we get good coverage
    // without spawning 28 separate particle systems.
    for (let i = 0; i < this.cloudRoots.length; i += 2) {
      const root     = this.cloudRoots[i];
      const children = root.getChildMeshes();
      if (!children.length) continue;

      const ps = new ParticleSystem(`puff_ps_${i}`, 60, scene);
      ps.particleTexture = this.puffTex;

      // Use the first child puff plane as emitter — it inherits the cluster's world
      // position so the halo follows cloud drift every frame with zero extra code.
      ps.emitter    = children[0] as Mesh;
      ps.minEmitBox = new Vector3(-1400, -300, -1400);
      ps.maxEmitBox = new Vector3( 1400,  300,  1400);

      // Nearly white with a cool blue tint; alpha kept low so layers build gently
      ps.color1    = new Color4(1.00, 1.00, 1.00, 0.30);
      ps.color2    = new Color4(0.90, 0.92, 1.00, 0.20);
      ps.colorDead = new Color4(1.00, 1.00, 1.00, 0.00);

      // Large slow billboards — comparable scale to the cloud billboard planes
      ps.minSize     = 600;
      ps.maxSize     = 1600;
      ps.minLifeTime = 40;
      ps.maxLifeTime = 80;
      ps.emitRate    = 2;    // trickle, not burst — lets the cloud build over time

      // Near-stationary; tiny drift matches the cluster's wind speed
      ps.direction1   = new Vector3(-1, 0, -1);
      ps.direction2   = new Vector3( 1, 0,  1);
      ps.minEmitPower = 0.5;
      ps.maxEmitPower = 2.0;
      ps.updateSpeed  = 0.008;
      ps.gravity      = Vector3.Zero();   // float in place

      // Standard blend: alpha-correct, no overexposure, correct at night
      ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      ps.start();
      this.cloudPuffSystems.push(ps);
    }
  }

  // ── Per-frame tick ────────────────────────────────────────────────────────

  private tick(dt: number): void {
    // Drift clouds with wind, wrapping at world edges
    const DRIFT = 6;
    const H     = CLOUD_SPREAD / 2;
    for (const root of this.cloudRoots) {
      root.position.x += this.windX * DRIFT * dt;
      root.position.z += this.windZ * DRIFT * dt;
      if (root.position.x >  H) root.position.x -= CLOUD_SPREAD;
      if (root.position.x < -H) root.position.x += CLOUD_SPREAD;
      if (root.position.z >  H) root.position.z -= CLOUD_SPREAD;
      if (root.position.z < -H) root.position.z += CLOUD_SPREAD;
    }

    // Cirrus drift at ~35 % speed — high-altitude jet-stream effect
    for (const root of this.cirrusRoots) {
      root.position.x += this.windX * DRIFT * 0.35 * dt;
      root.position.z += this.windZ * DRIFT * 0.35 * dt;
      if (root.position.x >  H) root.position.x -= CLOUD_SPREAD;
      if (root.position.x < -H) root.position.x += CLOUD_SPREAD;
      if (root.position.z >  H) root.position.z -= CLOUD_SPREAD;
      if (root.position.z < -H) root.position.z += CLOUD_SPREAD;
    }

    // Rain emitter tracks camera so the player is always inside the rain curtain
    const cam = this.sceneService.camera;
    if (cam && this.rainSystem) {
      this.rainPos.set(cam.position.x, cam.position.y + 80, cam.position.z);
    }

    // ── Golden-hour cloud tinting ─────────────────────────────────────────────
    // Read the shared wall-clock game hour so cloud colours stay in sync with the sky.
    const gameHours = this.sceneService.gameTime();
    const elev      = Math.sin(((gameHours - 6) / 12) * Math.PI);   // -1..1
    const horizon   = Math.max(0, 1 - Math.abs(elev) / 0.22);       // peaks at dawn/dusk
    const storm       = this.stormLevel;
    const bright      = 1.0 - storm * 0.60;
    const above       = Math.max(0, elev);          // 0 at/below horizon → 1 at noon
    const nightFactor = 0.06 + above * 0.94;        // 6 % emissive at midnight → 100 % at noon

    // Cumulus: orange-pink at golden hour, grey in storm, nearly invisible at night.
    // Both emissiveColor AND alpha are scaled so night clouds vanish without a trace —
    // emissive alone isn't enough because 6 % of a white texture can still read bright.
    this.cloudMat.emissiveColor = new Color3(
      Math.min(1.0, (bright + horizon * 0.44) * nightFactor),
      Math.min(1.0, (bright + horizon * 0.08) * nightFactor),
      Math.max(0.0, (bright - horizon * 0.40) * nightFactor),
    );
    // At night (above=0): alpha = 0.45 * 0.18 ≈ 0.08  →  barely-there silhouette
    // At noon  (above=1): alpha = 0.45 (+ storm bonus)  →  normal fluffy cloud
    this.cloudMat.alpha = (0.45 + storm * 0.45) * (0.18 + above * 0.82);

    // Cirrus dims the same way — ice crystals don't glow in the dark
    if (this.cirrusMat) {
      this.cirrusMat.emissiveColor = new Color3(
        nightFactor,
        Math.min(1, nightFactor * (0.88 + horizon * 0.12 - storm * 0.20)),
        Math.max(0, nightFactor * (0.96 - horizon * 0.58 - storm * 0.14)),
      );
      this.cirrusMat.alpha = 0.38 * (0.12 + above * 0.88);
    }

    // Puff-particle halos: update newly emitted particles so they also dim at night.
    // Existing particles (40–80 s lifetime) transition gradually as old ones expire.
    const pA1 = 0.30 * nightFactor;
    const pA2 = 0.20 * nightFactor;
    for (const ps of this.cloudPuffSystems) {
      ps.color1.a = pA1;
      ps.color2.a = pA2;
    }
  }

  // ── Weather response ──────────────────────────────────────────────────────

  updateWeather(weather: Weather): void {
    this.windX = weather.wind.x;
    this.windZ = weather.wind.z;

    const beaufort  = weather.wind.beaufort;
    const storm     = Math.min(1, beaufort / 9);   // 0 = calm → 1 = severe gale
    const isRaining = weather.precipitation === 'rain';

    // Track storm level — colour/opacity is blended in tick() with golden-hour tinting
    this.stormLevel = storm;

    // Storm clouds descend — gives an ominous low-ceiling effect
    for (const root of this.cloudRoots) {
      const targetY = ALT_HIGH - storm * (ALT_HIGH - ALT_LOW) * 0.75;
      root.position.y += (targetY - root.position.y) * 0.06;
    }

    // Rain: strength proportional to storm level, direction follows wind
    if (this.rainSystem) {
      this.rainSystem.emitRate = isRaining ? 1800 + beaufort * 220 : 0;

      const spd = Math.max(1, weather.wind.speed);
      const wx  = weather.wind.x / spd;
      const wz  = weather.wind.z / spd;
      this.rainSystem.direction1.set(wx * 5 - 1, -28, wz * 5 - 1);
      this.rainSystem.direction2.set(wx * 5 + 1, -22, wz * 5 + 1);
    }
  }

  dispose(): void {
    this.rainSystem?.stop();
    this.rainSystem?.dispose();
    for (const ps of this.cloudPuffSystems) { ps.stop(); ps.dispose(); }
    this.cloudPuffSystems = [];
    this.puffTex?.dispose();
    for (const root of this.cloudRoots)  root.dispose();
    for (const root of this.cirrusRoots) root.dispose();
    this.cloudRoots  = [];
    this.cirrusRoots = [];
  }
}
