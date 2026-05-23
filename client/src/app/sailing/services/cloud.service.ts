import { Injectable, inject } from '@angular/core';
import {
  Scene, MeshBuilder, ShaderMaterial, Mesh, Vector2, Vector3,
  Color4, ParticleSystem, DynamicTexture,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { Weather } from '../models';

// ── Shared noise helpers (prepended to both shaders) ─────────────────────────
// Rules: no WGSL reserved names, no overloads, scalar args only.
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

// 4-octave FBM — unrolled (no loop) for WGSL transpiler safety
float cloudFBM(float px, float py, float pz) {
  float v  = vNoise(px,       py,       pz      ) * 0.5000;
  v       += vNoise(px*2.03,  py*2.03,  pz*2.03 ) * 0.2500;
  v       += vNoise(px*4.09,  py*4.09,  pz*4.09 ) * 0.1250;
  v       += vNoise(px*8.17,  py*8.17,  pz*8.17 ) * 0.0625;
  return v;
}

// 2D Voronoi F1 — 9-cell unrolled; returns distance to nearest cell seed (0..~0.7)
float cloudVor(float px, float pz) {
  float ix = floor(px); float fx = fract(px);
  float iz = floor(pz); float fz = fract(pz);
  float bd = 8.0; float rx, rz, ddx, ddz;
  rx=fract(sin((ix-1.0)*127.1+(iz-1.0)*311.7)*43758.5); rz=fract(sin((ix-1.0)*269.5+(iz-1.0)*183.3)*43758.5); ddx=-1.0+rx*0.88-fx; ddz=-1.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  rx=fract(sin((ix    )*127.1+(iz-1.0)*311.7)*43758.5); rz=fract(sin((ix    )*269.5+(iz-1.0)*183.3)*43758.5); ddx= 0.0+rx*0.88-fx; ddz=-1.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  rx=fract(sin((ix+1.0)*127.1+(iz-1.0)*311.7)*43758.5); rz=fract(sin((ix+1.0)*269.5+(iz-1.0)*183.3)*43758.5); ddx= 1.0+rx*0.88-fx; ddz=-1.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  rx=fract(sin((ix-1.0)*127.1+(iz    )*311.7)*43758.5); rz=fract(sin((ix-1.0)*269.5+(iz    )*183.3)*43758.5); ddx=-1.0+rx*0.88-fx; ddz= 0.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  rx=fract(sin((ix    )*127.1+(iz    )*311.7)*43758.5); rz=fract(sin((ix    )*269.5+(iz    )*183.3)*43758.5); ddx= 0.0+rx*0.88-fx; ddz= 0.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  rx=fract(sin((ix+1.0)*127.1+(iz    )*311.7)*43758.5); rz=fract(sin((ix+1.0)*269.5+(iz    )*183.3)*43758.5); ddx= 1.0+rx*0.88-fx; ddz= 0.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  rx=fract(sin((ix-1.0)*127.1+(iz+1.0)*311.7)*43758.5); rz=fract(sin((ix-1.0)*269.5+(iz+1.0)*183.3)*43758.5); ddx=-1.0+rx*0.88-fx; ddz= 1.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  rx=fract(sin((ix    )*127.1+(iz+1.0)*311.7)*43758.5); rz=fract(sin((ix    )*269.5+(iz+1.0)*183.3)*43758.5); ddx= 0.0+rx*0.88-fx; ddz= 1.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  rx=fract(sin((ix+1.0)*127.1+(iz+1.0)*311.7)*43758.5); rz=fract(sin((ix+1.0)*269.5+(iz+1.0)*183.3)*43758.5); ddx= 1.0+rx*0.88-fx; ddz= 1.0+rz*0.88-fz; bd=min(bd,ddx*ddx+ddz*ddz);
  return sqrt(bd);
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

// ── Cumulus (stacked layer) fragment shader ───────────────────────────────────
//
// Each horizontal plane sits at a different altitude within the cloud layer.
// The fragment samples:
//   1. Voronoi at 6 km scale → discrete cloud clusters with clear gaps.
//   2. 4-octave FBM at 2 km scale → organic, billowing detail.
//   3. Height gradient → flat base, rounded puffy tops.
// The three combine into a density value, thresholded to alpha.
//
// Lighting: altitude-based shading (bright top, shadowed base) + scatter noise
// breaks up uniformity and creates the illusion of volumetric depth.
const CUMULUS_FRAG = `
precision highp float;
` + NOISE_HELPERS + `
uniform float u_Time;
uniform vec2  u_WindDir;     // normalised (X, Z) wind direction
uniform float u_WindSpeed;
uniform float u_CloudBase;   // world-Y of cloud base
uniform float u_CloudTop;    // world-Y of cloud top
uniform float u_Overcast;    // 0 = scattered  →  1 = fully overcast
uniform float u_DayFactor;   // 0 = midnight   →  1 = noon
uniform float u_HorizonGlow; // 0 = midday      →  1 = golden hour
uniform float u_StormFactor; // 0 = calm        →  1 = severe storm

varying vec3 v_wpos;

void main() {
  // ── Wind drift in noise space ─────────────────────────────────────────────
  float tt    = mod(u_Time, 1200.0);
  float dftX  = u_WindDir.x * u_WindSpeed * tt * 0.003;
  float dftZ  = u_WindDir.y * u_WindSpeed * tt * 0.003;

  // ── Altitude normalised within cloud layer ────────────────────────────────
  float altN  = clamp((v_wpos.y - u_CloudBase) / (u_CloudTop - u_CloudBase), 0.0, 1.0);

  // ── Large-scale cloud grouping (Voronoi) ──────────────────────────────────
  // Voronoi at ~5 500 m scale: sparse → 0.0 cell-edge gap, 1.0 cloud interior.
  // Overcast shrinks the gaps so more of the sky fills with cloud.
  float gx       = v_wpos.x / 5500.0 + dftX * 0.08;
  float gz       = v_wpos.z / 5500.0 + dftZ * 0.08;
  float cellDist = cloudVor(gx, gz);
  // thresh: radius of cloud existence within each Voronoi cell.
  // Clear sky → very small (only cell-center wisps or nothing).
  // Full overcast → large enough to fill nearly the whole cell.
  float thresh   = u_Overcast * 0.65 - 0.15;   // -0.15 clear → 0.50 overcast
  float grpMask  = smoothstep(thresh + 0.18, thresh, cellDist);
  grpMask       *= smoothstep(0.0, 0.12, u_Overcast);   // zero out on clear sky
  if (grpMask < 0.03) { discard; }

  // ── Height gradient: flat base, rounded puffy tops ────────────────────────
  float baseRamp = smoothstep(0.0,  0.18, altN);
  float topRamp  = smoothstep(1.0,  0.62, altN);
  float hGrad    = baseRamp * topRamp;

  // ── FBM cloud detail ──────────────────────────────────────────────────────
  float nx  = v_wpos.x / 2200.0 + dftX;
  float ny  = altN * 2.5;
  float nz  = v_wpos.z / 2200.0 + dftZ;
  float dtl = cloudFBM(nx, ny, nz);   // 0..~0.94

  // ── Combined density ──────────────────────────────────────────────────────
  float dens  = grpMask * hGrad * (dtl * 1.90 - 0.28);
  dens        = clamp(dens, 0.0, 1.0);
  float cAlpha = smoothstep(0.10, 0.66, dens) * 0.90;
  if (cAlpha < 0.01) { discard; }

  // ── Lighting ─────────────────────────────────────────────────────────────
  // Altitude shading: sun lights from above → bright tops, shadowed bases.
  float litF = mix(0.50, 1.00, altN);

  // Scatter noise breaks up flat uniform brightness and gives depth cue.
  float sctN = cloudFBM(nx * 0.52, ny * 0.38, nz * 0.52);
  litF      *= mix(0.78, 1.00, sctN);

  // Storm darkens the whole cloud mass toward grey nimbostratus.
  litF *= 1.0 - u_StormFactor * 0.48;

  // ── Colour ───────────────────────────────────────────────────────────────
  vec3 litCol    = vec3(0.97, 0.98, 1.00);
  vec3 shadCol   = mix(vec3(0.52, 0.57, 0.68), vec3(0.25, 0.28, 0.34), u_StormFactor * 0.70);

  // Warm tint on lit faces at golden hour (sunrise / sunset)
  litCol += vec3(0.28, 0.10, -0.12) * u_HorizonGlow * 0.55;
  litCol  = clamp(litCol, 0.0, 1.0);

  vec3 cCol = mix(shadCol, litCol, litF);

  // Night dimming — keep a faint moonlit silhouette (6 % at midnight)
  float nightD = mix(0.06, 1.0, u_DayFactor);
  cCol   *= nightD;
  cAlpha *= mix(0.20, 1.0, u_DayFactor);

  gl_FragColor = vec4(cCol, cAlpha);
}
`;

// ── Cirrus fragment shader ────────────────────────────────────────────────────
//
// High-altitude ice-crystal sheets at 7 000–9 500 m.
// Anisotropic noise: stretched along the wind direction to produce long fibrous
// filaments (the characteristic "mare's tails" look of real cirrus).
const CIRRUS_FRAG = `
precision highp float;
` + NOISE_HELPERS + `
uniform float u_Time;
uniform vec2  u_WindDir;
uniform float u_WindSpeed;
uniform float u_DayFactor;
uniform float u_HorizonGlow;
uniform float u_Overcast;    // shared with cumulus — 0 = clear, 1 = storm

varying vec3 v_wpos;

void main() {
  // Cirrus fades out on clear days — no wispy high cloud at cloudiness = 0.
  // Start appearing around 0.10 overcast; fully present at 0.30+.
  float cirrusPresence = smoothstep(0.05, 0.30, u_Overcast);
  if (cirrusPresence < 0.01) { discard; }

  float tt   = mod(u_Time, 1200.0);
  float dftX = u_WindDir.x * u_WindSpeed * tt * 0.003;
  float dftZ = u_WindDir.y * u_WindSpeed * tt * 0.003;

  // Axes: along wind for long axis, cross-wind for fine transverse detail
  float wx =  u_WindDir.x;
  float wz =  u_WindDir.y;
  float cx = -wz;
  float cz =  wx;

  float alng  = (v_wpos.x * wx + v_wpos.z * wz) / 18000.0 + dftX * 0.35;
  float crss  = (v_wpos.x * cx + v_wpos.z * cz) / 2000.0  + dftZ * 0.05;

  // Wispy filament: value noise at three cross-wind frequencies
  float fibre = vNoise(alng,       0.5, crss * 2.5) * 0.500
              + vNoise(alng * 2.8, 0.5, crss * 5.5) * 0.300
              + vNoise(alng * 6.5, 0.5, crss * 9.8) * 0.150;

  // Large-scale sheet mask: prevents uniform grey ceiling, creates gaps
  float sheetMask = cloudFBM(alng * 0.28, 0.5, crss * 0.38) * 1.35 - 0.20;
  sheetMask = clamp(sheetMask, 0.0, 1.0);

  float dens = sheetMask * (fibre * 1.55 - 0.30);
  float cAlpha = smoothstep(0.08, 0.55, clamp(dens, 0.0, 1.0)) * 0.50;
  cAlpha *= cirrusPresence;
  if (cAlpha < 0.02) { discard; }

  // Ice crystals: brilliant white with warm golden-hour tint
  vec3 cCol = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.82, 0.60), u_HorizonGlow * 0.45);
  cCol   *= mix(0.05, 1.0, u_DayFactor);
  cAlpha *= mix(0.12, 1.0, u_DayFactor);

  gl_FragColor = vec4(cCol, cAlpha);
}
`;

// ─────────────────────────────────────────────────────────────────────────────

const CUMULUS_ALTS = [1100, 1350, 1600, 1850, 2100, 2350, 2600, 2850];
const CIRRUS_ALTS  = [7000, 7500, 8000, 8500, 9000, 9500];
const CLOUD_BASE   = 1100;
const CLOUD_TOP    = 2850;
const PLANE_SIZE   = 90_000;

@Injectable({ providedIn: 'root' })
export class CloudService {
  private sceneService = inject(SceneService);

  private cumulusMat!: ShaderMaterial;
  private cirrusMat!:  ShaderMaterial;
  private cumulusPlanes: Mesh[] = [];
  private cirrusPlanes:  Mesh[] = [];

  private rainSystem: ParticleSystem | null = null;
  private rainPos = new Vector3(0, 30, 0);

  // ── Weather state ──────────────────────────────────────────────────────────
  private elapsed    = 0;
  private windDirX   = 0.0;
  private windDirZ   = 1.0;
  private windSpeed  = 8.0;
  private stormFactor = 0.0;
  private overcast    = 0.2;
  private cloudBase   = CLOUD_BASE;
  private cloudTop    = CLOUD_TOP;

  // ── Init ──────────────────────────────────────────────────────────────────

  init(): void {
    const scene = this.sceneService.scene;

    // Cloud planes render in group 0 — before ocean (groups 1–2) and vessel (group 2).
    // Because transparent sails don't write to the depth buffer, any group rendered
    // AFTER group 2 can bleed through the sails.  Being in group 0 means the vessel
    // always composites on top of any cloud colour, regardless of sail transparency.

    this.buildCumulusMaterial(scene);
    this.buildCirrusMaterial(scene);
    this.buildCumulusLayer(scene);
    this.buildCirrusLayer(scene);
    this.buildRainSystem(scene);

    scene.registerBeforeRender(() => {
      const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
      this.tick(dt);
    });
  }

  // ── Material builders ──────────────────────────────────────────────────────

  private buildCumulusMaterial(scene: Scene): void {
    this.cumulusMat = new ShaderMaterial('cumulusMat', scene,
      { vertexSource: CLOUD_VERT, fragmentSource: CUMULUS_FRAG },
      {
        attributes: ['position'],
        uniforms: [
          'worldViewProjection', 'world',
          'u_Time', 'u_WindDir', 'u_WindSpeed',
          'u_CloudBase', 'u_CloudTop', 'u_Overcast', 'u_StormFactor',
          'u_DayFactor', 'u_HorizonGlow',
        ],
        needAlphaBlending: true,
      },
    );
    this.cumulusMat.backFaceCulling  = false;
    this.cumulusMat.disableDepthWrite = true;
  }

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
    this.cirrusMat.backFaceCulling  = false;
    this.cirrusMat.disableDepthWrite = true;
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  private buildCumulusLayer(scene: Scene): void {
    for (let i = 0; i < CUMULUS_ALTS.length; i++) {
      const alt = CUMULUS_ALTS[i];
      const plane = MeshBuilder.CreateGround(`cumulus_${alt}`, {
        width: PLANE_SIZE, height: PLANE_SIZE, subdivisions: 1,
      }, scene);
      plane.position.y      = alt;
      plane.material        = this.cumulusMat;
      plane.isPickable      = false;
      plane.renderingGroupId = 0;
      // alphaIndex: higher = rendered last (on top). Lowest altitude plane
      // is closest to camera → renders last → appears on top.
      plane.alphaIndex = CUMULUS_ALTS.length - i;
      this.cumulusPlanes.push(plane);
    }
  }

  private buildCirrusLayer(scene: Scene): void {
    for (let i = 0; i < CIRRUS_ALTS.length; i++) {
      const alt = CIRRUS_ALTS[i];
      const plane = MeshBuilder.CreateGround(`cirrus_${alt}`, {
        width: PLANE_SIZE, height: PLANE_SIZE, subdivisions: 1,
      }, scene);
      plane.position.y       = alt;
      plane.material         = this.cirrusMat;
      plane.isPickable       = false;
      plane.renderingGroupId = 0;
      plane.alphaIndex       = 20 + (CIRRUS_ALTS.length - i);
      this.cirrusPlanes.push(plane);
    }
  }

  // ── Rain particle system ───────────────────────────────────────────────────

  private buildRainSystem(scene: Scene): void {
    // 4×32 streak texture — thin vertical gradient, bright centre, transparent caps.
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
    // BILLBOARDMODE_ALL: fully faces camera — reliable in WebGPU.
    // The 4×32 texture is already a narrow vertical streak, so it reads as
    // a rain drop regardless of camera angle.
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

    // ── Compute sky properties from game time ─────────────────────────────────
    const gameH   = this.sceneService.gameTime();
    const elev    = Math.sin(((gameH - 6) / 12) * Math.PI);   // -1 midnight → +1 noon
    const dayF    = Math.max(0, elev);                          // 0 at/below horizon
    const horizG  = Math.max(0, 1 - Math.abs(elev) / 0.22);   // golden-hour spike

    // Sun direction (same formula as SceneService, kept in sync)
    const az   = (gameH / 24) * Math.PI * 2 - Math.PI;
    const horiz = Math.sqrt(Math.max(0, 1 - elev * elev));
    const sunX = horiz * Math.sin(az);
    const sunZ = horiz * Math.cos(az);

    // ── Upload cumulus uniforms ───────────────────────────────────────────────
    this.cumulusMat.setFloat('u_Time',        this.elapsed);
    this.cumulusMat.setVector2('u_WindDir',   new Vector2(this.windDirX, this.windDirZ));
    this.cumulusMat.setFloat('u_WindSpeed',   this.windSpeed);
    this.cumulusMat.setFloat('u_CloudBase',   this.cloudBase);
    this.cumulusMat.setFloat('u_CloudTop',    this.cloudTop);
    this.cumulusMat.setFloat('u_Overcast',    this.overcast);
    this.cumulusMat.setFloat('u_StormFactor', this.stormFactor);
    this.cumulusMat.setFloat('u_DayFactor',   dayF);
    this.cumulusMat.setFloat('u_HorizonGlow', horizG);

    // ── Upload cirrus uniforms ────────────────────────────────────────────────
    this.cirrusMat.setFloat('u_Time',        this.elapsed * 0.35);   // cirrus drifts slower
    this.cirrusMat.setVector2('u_WindDir',   new Vector2(this.windDirX, this.windDirZ));
    this.cirrusMat.setFloat('u_WindSpeed',   this.windSpeed);
    this.cirrusMat.setFloat('u_DayFactor',   dayF);
    this.cirrusMat.setFloat('u_HorizonGlow', horizG);
    this.cirrusMat.setFloat('u_Overcast',    this.overcast);

    // ── Rain emitter tracks camera ────────────────────────────────────────────
    const cam = this.sceneService.camera;
    if (cam && this.rainSystem) {
      // Emitter 30 units above camera — particles fall 50–65 units in their
      // lifetime, so rain passes cleanly through the camera's field of view.
      this.rainPos.set(cam.position.x, cam.position.y + 30, cam.position.z);
    }
  }

  // ── Weather response ──────────────────────────────────────────────────────

  updateWeather(weather: Weather): void {
    const spd = Math.max(0.5, weather.wind.speed);
    this.windDirX  = weather.wind.x / spd;
    this.windDirZ  = weather.wind.z / spd;
    this.windSpeed = spd;

    // Cloudiness (0..1) directly drives overcast level and visual cloud darkness.
    // stormFactor uses a non-linear curve so light clouds stay bright white and
    // only heavy overcast pulls the base colour toward dark grey nimbostratus.
    this.overcast    = weather.cloudiness;
    this.stormFactor = Math.pow(weather.cloudiness, 1.5);

    // Clouds descend as overcast builds; ceiling drops from 2 850 m → 1 200 m at full storm
    const stormDrop   = this.stormFactor * 0.72;
    this.cloudBase    = CLOUD_BASE + stormDrop * 200;
    this.cloudTop     = CLOUD_TOP  - stormDrop * (CLOUD_TOP - CLOUD_BASE) * 0.55;

    // Reposition cloud planes to match the evolved base/top
    for (let i = 0; i < this.cumulusPlanes.length; i++) {
      const t = i / (this.cumulusPlanes.length - 1);   // 0 = base, 1 = top
      this.cumulusPlanes[i].position.y = this.cloudBase + t * (this.cloudTop - this.cloudBase);
    }

    // ── Rain ──────────────────────────────────────────────────────────────────
    // Direction follows wind; intensity and drop size scale with precipitation level.
    if (this.rainSystem) {
      const wx = this.windDirX;
      const wz = this.windDirZ;

      let emitRate  = 0;
      let windBlast = 5;
      switch (weather.precipitation) {
        case 'drizzle': emitRate = 400;  windBlast = 3; break;
        case 'rain':    emitRate = 2200; windBlast = 5; break;
        case 'storm':   emitRate = 5500; windBlast = 9; break;
        default:        emitRate = 0;    break;
      }
      this.rainSystem.emitRate = emitRate;

      // Drizzle → fine, short streaks; rain/storm → long driving streaks
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
    for (const p of this.cumulusPlanes)  p.dispose();
    for (const p of this.cirrusPlanes)   p.dispose();
    this.cumulusMat?.dispose();
    this.cirrusMat?.dispose();
    this.cumulusPlanes = [];
    this.cirrusPlanes  = [];
  }
}
