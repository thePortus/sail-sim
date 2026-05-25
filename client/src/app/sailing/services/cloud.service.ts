import { Injectable, inject } from '@angular/core';
import {
  Scene, MeshBuilder, ShaderMaterial, StandardMaterial, Mesh, Vector2, Vector3,
  Color3, Color4, ParticleSystem, DynamicTexture, SolidParticleSystem, SolidParticle,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { Weather } from '../models';

// ── Shared noise helpers (prepended to cirrus shader) ────────────────────────
const NOISE_HELPERS = `
float _nh(float ax, float ay, float az) {
  return fract(sin(ax * 127.1 + ay * 311.7 + az * 74.7) * 43758.5453);
}

float vNoise(float px, float py, float pz) {
  float ix = floor(px); float fx = fract(px); fx = fx*fx*(3.0-2.0*fx);
  float iy = floor(py); float fy = fract(py); fy = fy*fy*(3.0-2.0*fy);
  float iz = floor(pz); float fz = fract(pz); fz = fz*fz*(3.0-2.0*fz);
  float v00 = mix(_nh(ix,     iy,     iz    ), _nh(ix+1.0, iy,     iz    ), fx);
  float v10 = mix(_nh(ix,     iy+1.0, iz    ), _nh(ix+1.0, iy+1.0, iz    ), fx);
  float v01 = mix(_nh(ix,     iy,     iz+1.0), _nh(ix+1.0, iy,     iz+1.0), fx);
  float v11 = mix(_nh(ix,     iy+1.0, iz+1.0), _nh(ix+1.0, iy+1.0, iz+1.0), fx);
  return mix(mix(v00, v10, fy), mix(v01, v11, fy), fz);
}

float cloudFBM(float px, float py, float pz) {
  float v  = vNoise(px,       py,       pz      ) * 0.5000;
  v       += vNoise(px*2.03,  py*2.03,  pz*2.03 ) * 0.2500;
  v       += vNoise(px*4.09,  py*4.09,  pz*4.09 ) * 0.1250;
  v       += vNoise(px*8.17,  py*8.17,  pz*8.17 ) * 0.0625;
  return v;
}
`;

// ── Shared vertex shader ──────────────────────────────────────────────────────
const CLOUD_VERT = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
uniform mat4 world;
varying vec3 v_wpos;
void main() {
  v_wpos      = (world * vec4(position, 1.0)).xyz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

// ── Cirrus fragment shader ────────────────────────────────────────────────────
const CIRRUS_FRAG = `
precision highp float;
` + NOISE_HELPERS + `
uniform float u_Time;
uniform vec2  u_WindDir;
uniform float u_WindSpeed;
uniform float u_DayFactor;
uniform float u_HorizonGlow;
uniform float u_Overcast;

varying vec3 v_wpos;

void main() {
  float cirrusPresence = smoothstep(0.05, 0.30, u_Overcast);
  if (cirrusPresence < 0.01) { discard; }

  float tt   = mod(u_Time, 1200.0);
  float dftX = u_WindDir.x * u_WindSpeed * tt * 0.003;
  float dftZ = u_WindDir.y * u_WindSpeed * tt * 0.003;

  float wx =  u_WindDir.x;
  float wz =  u_WindDir.y;
  float cx = -wz;
  float cz =  wx;

  float alng  = (v_wpos.x * wx + v_wpos.z * wz) / 18000.0 + dftX * 0.35;
  float crss  = (v_wpos.x * cx + v_wpos.z * cz) / 2000.0  + dftZ * 0.05;

  float fibre = vNoise(alng,       0.5, crss * 2.5) * 0.500
              + vNoise(alng * 2.8, 0.5, crss * 5.5) * 0.300
              + vNoise(alng * 6.5, 0.5, crss * 9.8) * 0.150;

  float sheetMask = cloudFBM(alng * 0.28, 0.5, crss * 0.38) * 1.35 - 0.20;
  sheetMask = clamp(sheetMask, 0.0, 1.0);

  float dens   = sheetMask * (fibre * 1.55 - 0.30);
  float cAlpha = smoothstep(0.08, 0.55, clamp(dens, 0.0, 1.0)) * 0.50;
  cAlpha *= cirrusPresence;
  if (cAlpha < 0.02) { discard; }

  vec3 cCol = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.82, 0.60), u_HorizonGlow * 0.45);
  cCol   *= mix(0.05, 1.0, u_DayFactor);
  cAlpha *= mix(0.12, 1.0, u_DayFactor);

  gl_FragColor = vec4(cCol, cAlpha);
}
`;

// ─────────────────────────────────────────────────────────────────────────────

const CIRRUS_ALTS       = [7000, 7500, 8000, 8500, 9000, 9500];
const CIRRUS_PLANE_SIZE = 90_000;

// Cloud particle parameters
const CLOUD_BASE_ALT    = 1100;    // m — lowest puff altitude
const CLOUD_TOP_ALT     = 2850;    // m — highest puff altitude
const CLUSTER_COUNT     = 55;      // number of cloud clusters
const PUFFS_PER_CLUSTER = 16;      // billboard puffs per cluster
const CLOUD_AREA_RADIUS = 13_000;  // cluster spread radius (world units)

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class CloudService {
  private sceneService = inject(SceneService);

  // Cirrus — procedural GLSL horizontal planes (kept as-is; look great)
  private cirrusMat!:  ShaderMaterial;
  private cirrusPlanes: Mesh[] = [];

  // Cumulus — replaced with SolidParticleSystem cloud puffs
  private cloudSPS!: SolidParticleSystem;
  private cloudPuffAlpha  = 0.0;   // 0=clear sky  →  1=fully overcast
  private cloudBrightness = 1.0;   // 0=night       →  1=noon
  private readonly puffBaseAlphas = new Float32Array(CLUSTER_COUNT * PUFFS_PER_CLUSTER);

  // Rain particle system
  private rainSystem: ParticleSystem | null = null;
  private rainPos = new Vector3(0, 30, 0);

  // Weather state
  private elapsed      = 0;
  private windDirX     = 0.0;
  private windDirZ     = 1.0;
  private windSpeed    = 8.0;
  private overcast     = 0.2;
  private spsFrameTick = 0;   // throttle counter for setParticles()

  // ── Init ──────────────────────────────────────────────────────────────────

  init(): void {
    const scene = this.sceneService.scene;
    this.buildCirrusMaterial(scene);
    this.buildCirrusLayer(scene);
    this.buildCloudParticles(scene);
    this.buildRainSystem(scene);

    scene.registerBeforeRender(() => {
      const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
      this.tick(dt);
    });
  }

  // ── Cloud puff SPS ────────────────────────────────────────────────────────

  /**
   * Builds a 128×128 soft radial-gradient texture for cloud puffs.
   * Centre is opaque white; edge fades to transparent — gives a round,
   * volumetric-looking puff when many are overlaid.
   */
  private buildCloudPuffTexture(scene: Scene): DynamicTexture {
    const SZ  = 128;
    const tex = new DynamicTexture('cloudPuffTex', { width: SZ, height: SZ }, scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, SZ, SZ);
    const cx  = SZ / 2;
    const grd = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    grd.addColorStop(0.00, 'rgba(255,255,255,1.00)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.96)');
    grd.addColorStop(0.62, 'rgba(248,252,255,0.60)');
    grd.addColorStop(0.84, 'rgba(240,245,255,0.16)');
    grd.addColorStop(1.00, 'rgba(235,242,255,0.00)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, SZ, SZ);
    tex.update();
    return tex;
  }

  /**
   * Creates CLUSTER_COUNT × PUFFS_PER_CLUSTER volumetric cloud puffs using a
   * SolidParticleSystem.  Each puff is THREE crossed vertical planes (at 0°,
   * 60°, 120° Y-rotation) merged into one mesh.  From any horizontal viewing
   * angle at least 2 planes overlap, making the puff read as a 3-D volume
   * rather than a flat billboard.  No per-frame camera-facing rotation is
   * needed — the symmetry of the cross handles all azimuths automatically.
   *
   * Clusters are placed on a golden-angle spiral for gap-free sky coverage.
   * updateParticle() only handles color/alpha; rotation is fixed at build time.
   */
  private buildCloudParticles(scene: Scene): void {
    const puffTex = this.buildCloudPuffTexture(scene);

    // Material — shared across all three planes of the cross.
    const mat = new StandardMaterial('cloudPuffMat', scene);
    mat.diffuseTexture              = puffTex;
    mat.emissiveColor               = Color3.White();    // self-lit (no scene lighting on clouds)
    (mat.diffuseTexture as DynamicTexture).hasAlpha = true;
    mat.useAlphaFromDiffuseTexture  = true;
    mat.backFaceCulling             = false;             // render both sides of every plane

    // ── Build the stacked-disc template ───────────────────────────────────────
    // Five horizontal discs at increasing Y offsets and decreasing radii model
    // a classic cumulus tower.  Viewed from sea level (always looking upward at
    // 10–60°) the overlapping translucent circles read as a soft, layered volume.
    // Vertical crossed planes look flat from below — horizontal discs do not.
    //
    // CreateDisc() produces a disc in the XY plane (upright); rotation.x = -π/2
    // lays it flat, then bakeCurrentTransformIntoVertices() commits the rotation
    // so MergeMeshes receives geometry already in world-horizontal orientation.
    const makeDisc = (yOff: number, r: number): Mesh => {
      const d = MeshBuilder.CreateDisc('_hd', { radius: r, tessellation: 16 }, scene);
      d.material   = mat;
      d.rotation.x = -Math.PI / 2;
      d.position.y = yOff;
      d.bakeCurrentTransformIntoVertices();
      return d;
    };

    const slabs = [
      makeDisc(0.00, 0.50),   // base — widest
      makeDisc(0.18, 0.48),
      makeDisc(0.36, 0.42),
      makeDisc(0.54, 0.30),
      makeDisc(0.68, 0.16),   // apex — narrowest
    ];
    const template = Mesh.MergeMeshes(slabs, true, true, undefined, false, false)!;
    template.material  = mat;
    template.isVisible = false;

    const total = CLUSTER_COUNT * PUFFS_PER_CLUSTER;

    this.cloudSPS = new SolidParticleSystem('cloudSPS', scene, {
      updatable:        true,
      useModelMaterial: true,
      // enableDepthSort intentionally omitted: sorting 880 particles + reordering
      // a 3× larger vertex buffer every frame was the primary frame-rate killer.
      // Slight back-to-front artefacts in cloud-on-cloud overlap are imperceptible
      // at cumulus distances (1–13 km) and outweighed by the perf saving.
    });

    // Deterministic seeded random: sr(seed) ∈ [0, 1)
    const sr = (s: number) => (((s * 0.6180339887) % 1) + 1) % 1;

    this.cloudSPS.addShape(template, total, {
      positionFunction: (particle: any, idx: number) => {
        const ci   = Math.floor(idx / PUFFS_PER_CLUSTER);   // cluster 0 … 54
        const norm = ci / CLUSTER_COUNT;

        // Golden-angle spiral → gap-free sky coverage
        const cRad   = 800 + Math.sqrt(norm) * (CLOUD_AREA_RADIUS - 800);
        const cAngle = ci * 2.39996322;   // ≈ 137.5° (golden angle)
        const cx     = Math.cos(cAngle) * cRad;
        const cz     = Math.sin(cAngle) * cRad;
        const cy     = CLOUD_BASE_ALT + sr(ci * 7 + 3) * (CLOUD_TOP_ALT - CLOUD_BASE_ALT) * 0.8;

        // Puff spread within the cluster — generous vertical range for 3-D depth
        const hSprd = 220 + norm * 360;
        const vSprd = 80  + sr(ci * 13 + 1) * 90;   // taller than before for volume

        particle.position.x = cx + (sr(idx * 17 + 5)  - 0.5) * 2 * hSprd;
        particle.position.y = cy + (sr(idx * 31 + 7)  - 0.5) * 2 * vSprd;
        particle.position.z = cz + (sr(idx * 23 + 11) - 0.5) * 2 * hSprd;

        // Horizontal puffs: wide in X/Z, shorter in Y (cumulus are wider than tall).
        // Random Y-rotation varies the disc orientations so clusters don't look uniform.
        const w = 160 + norm * 240 + sr(idx * 37 + 2) * 180;
        particle.scaling.x  = w;
        particle.scaling.y  = w * (0.38 + sr(idx * 41 + 6) * 0.22);  // height ≈ 40–60% of width
        particle.scaling.z  = w;

        particle.rotation.y = sr(idx * 11 + 3) * Math.PI * 2;
        particle.rotation.x = 0;
        particle.rotation.z = 0;

        this.puffBaseAlphas[idx] = 0.38 + sr(idx * 53 + 9) * 0.32;
        particle.color = new Color4(1, 1, 1, 0);   // invisible until first tick
      },
    });

    this.cloudSPS.buildMesh();
    template.dispose();

    // Particle rotations and UVs are set once at build time and never change —
    // tell the SPS to skip those recomputation passes inside setParticles().
    // Only colour updates remain, which is the cheapest path.
    this.cloudSPS.computeParticleRotation = false;
    this.cloudSPS.computeParticleTexture  = false;

    this.cloudSPS.mesh.renderingGroupId = 0;
    this.cloudSPS.mesh.alphaIndex       = 50;
    this.cloudSPS.isAlwaysVisible       = true;

    // Per-frame update: only color/alpha — rotation is fixed at init time.
    // The three-plane cross is view-invariant so no camera-facing transform needed.
    this.cloudSPS.updateParticle = (particle: SolidParticle): SolidParticle => {
      const b = this.cloudBrightness;
      if (particle.color) {
        particle.color.r = b;
        particle.color.g = b;
        particle.color.b = b + 0.04 * b;
        particle.color.a = this.puffBaseAlphas[particle.idx] * this.cloudPuffAlpha;
      }
      return particle;
    };
  }

  // ── Cirrus material / layer (unchanged) ───────────────────────────────────

  private buildCirrusMaterial(scene: Scene): void {
    this.cirrusMat = new ShaderMaterial('cirrusMat', scene,
      { vertexSource: CLOUD_VERT, fragmentSource: CIRRUS_FRAG },
      {
        attributes: ['position'],
        uniforms: [
          'worldViewProjection', 'world',
          'u_Time', 'u_WindDir', 'u_WindSpeed',
          'u_DayFactor', 'u_HorizonGlow', 'u_Overcast',
        ],
        needAlphaBlending: true,
      },
    );
    this.cirrusMat.backFaceCulling   = false;
    this.cirrusMat.disableDepthWrite = true;
  }

  private buildCirrusLayer(scene: Scene): void {
    for (let i = 0; i < CIRRUS_ALTS.length; i++) {
      const alt   = CIRRUS_ALTS[i];
      const plane = MeshBuilder.CreateGround(`cirrus_${alt}`, {
        width: CIRRUS_PLANE_SIZE, height: CIRRUS_PLANE_SIZE, subdivisions: 1,
      }, scene);
      plane.position.y       = alt;
      plane.material         = this.cirrusMat;
      plane.isPickable       = false;
      plane.renderingGroupId = 0;
      plane.alphaIndex       = 20 + (CIRRUS_ALTS.length - i);
      this.cirrusPlanes.push(plane);
    }
  }

  // ── Rain particle system (unchanged) ──────────────────────────────────────

  private buildRainSystem(scene: Scene): void {
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
    this.rainSystem.emitter    = this.rainPos;
    this.rainSystem.minEmitBox = new Vector3(-260, 0, -260);
    this.rainSystem.maxEmitBox = new Vector3( 260, 0,  260);
    this.rainSystem.color1    = new Color4(0.78, 0.88, 1.0, 0.55);
    this.rainSystem.color2    = new Color4(0.72, 0.82, 1.0, 0.35);
    this.rainSystem.colorDead = new Color4(0.72, 0.82, 1.0, 0.00);
    this.rainSystem.billboardMode = ParticleSystem.BILLBOARDMODE_ALL;
    this.rainSystem.minScaleX  = 0.10;  this.rainSystem.maxScaleX  = 0.18;
    this.rainSystem.minScaleY  = 1.8;   this.rainSystem.maxScaleY  = 3.5;
    this.rainSystem.minLifeTime = 0.28; this.rainSystem.maxLifeTime = 0.55;
    this.rainSystem.emitRate    = 0;
    this.rainSystem.direction1  = new Vector3(-1, -28, -1);
    this.rainSystem.direction2  = new Vector3( 1, -22,  1);
    this.rainSystem.minEmitPower = 4;   this.rainSystem.maxEmitPower = 8;
    this.rainSystem.updateSpeed  = 0.016;
    this.rainSystem.gravity      = new Vector3(0, -9.8, 0);
    this.rainSystem.blendMode    = ParticleSystem.BLENDMODE_STANDARD;
    this.rainSystem.start();
  }

  // ── Per-frame tick ─────────────────────────────────────────────────────────

  private tick(dt: number): void {
    this.elapsed += dt;

    // Compute sky properties from game time (same formula as SceneService)
    const gameH  = this.sceneService.gameTime();
    const elev   = Math.sin(((gameH - 6) / 12) * Math.PI);
    const dayF   = Math.max(0, elev);
    const horizG = Math.max(0, 1 - Math.abs(elev) / 0.22);

    // ── Cirrus uniforms ───────────────────────────────────────────────────────
    this.cirrusMat.setFloat('u_Time',        this.elapsed * 0.35);
    this.cirrusMat.setVector2('u_WindDir',   new Vector2(this.windDirX, this.windDirZ));
    this.cirrusMat.setFloat('u_WindSpeed',   this.windSpeed);
    this.cirrusMat.setFloat('u_DayFactor',   dayF);
    this.cirrusMat.setFloat('u_HorizonGlow', horizG);
    this.cirrusMat.setFloat('u_Overcast',    this.overcast);

    // ── Cloud puff alpha & brightness ─────────────────────────────────────────
    // Mirrors the GLSL cumulus shader logic:
    //   nightD    = mix(0.06, 1.0, dayFactor)   — brightness at night is 6%
    //   cAlpha   *= mix(0.20, 1.0, dayFactor)   — alpha at night is 20%
    // overcast threshold: no puffs below overcast 0.04.
    // Storm darkening: clouds fade from white toward dark charcoal as overcast rises
    // above 0.3.  At overcast=1.0 brightness is 35% of the day value.
    const stormDark      = 1.0 - Math.max(0, (this.overcast - 0.3) / 0.7) * 0.65;
    this.cloudBrightness = (0.06 + dayF * 0.94) * stormDark;
    const nightAlphaMod  = 0.20 + dayF * 0.80;
    this.cloudPuffAlpha  = Math.max(0, (this.overcast - 0.04) / 0.96) * nightAlphaMod;

    // ── Update cloud puff SPS — throttled to every 6 frames ──────────────────
    // Colours transition over seconds (day/night, weather), so updating every
    // 6th render frame (~10 Hz at 60 fps) is indistinguishable from every frame.
    // This eliminates 5/6 of the vertex-buffer upload cost.
    if (this.cloudSPS && ++this.spsFrameTick % 6 === 0) {
      this.cloudSPS.setParticles();
    }

    // ── Rain emitter tracks camera ────────────────────────────────────────────
    const cam = this.sceneService.camera;
    if (cam && this.rainSystem) {
      this.rainPos.set(cam.position.x, cam.position.y + 30, cam.position.z);
    }
  }

  // ── Weather response ──────────────────────────────────────────────────────

  updateWeather(weather: Weather): void {
    const spd       = Math.max(0.5, weather.wind.speed);
    this.windDirX   = weather.wind.x / spd;
    this.windDirZ   = weather.wind.z / spd;
    this.windSpeed  = spd;
    this.overcast   = weather.cloudiness;

    // Rain system
    if (this.rainSystem) {
      const wx = this.windDirX;
      const wz = this.windDirZ;

      let emitRate = 0, windBlast = 5;
      switch (weather.precipitation) {
        case 'drizzle': emitRate = 400;  windBlast = 3; break;
        case 'rain':    emitRate = 2200; windBlast = 5; break;
        case 'storm':   emitRate = 5500; windBlast = 9; break;
        default:        emitRate = 0;    break;
      }
      this.rainSystem.emitRate = emitRate;

      if (weather.precipitation === 'drizzle') {
        this.rainSystem.minScaleX = 0.05; this.rainSystem.maxScaleX = 0.09;
        this.rainSystem.minScaleY = 0.8;  this.rainSystem.maxScaleY = 1.6;
      } else {
        this.rainSystem.minScaleX = 0.10; this.rainSystem.maxScaleX = 0.18;
        this.rainSystem.minScaleY = 1.8;  this.rainSystem.maxScaleY = 3.5;
      }

      this.rainSystem.direction1.set(wx * windBlast - 1, -28, wz * windBlast - 1);
      this.rainSystem.direction2.set(wx * windBlast + 1, -22, wz * windBlast + 1);
    }
  }

  // ── Dispose ────────────────────────────────────────────────────────────────

  dispose(): void {
    this.rainSystem?.stop();
    this.rainSystem?.dispose();
    this.cloudSPS?.dispose();
    for (const p of this.cirrusPlanes) p.dispose();
    this.cirrusMat?.dispose();
    this.cirrusPlanes = [];
  }
}
