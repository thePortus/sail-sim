/**
 * OceanFFTMaterial — PBR ocean surface that samples the 3 FFT cascades, ported faithfully
 * from Popov72's OceanDemo `oceanMaterial.ts`. The displacement maps move the vertices; the
 * derivative maps give per-pixel normals that exactly match the geometry; the turbulence
 * (Jacobian) maps drive foam where waves pinch/break. Adds subsurface scattering on wave
 * backs, Fresnel, and depth-based contact foam.
 *
 * GLSL injections (transpiled to WGSL by Babylon on WebGPU). Three LOD variants are built:
 * close (all 3 cascades), mid (2), and far (1), selected per ring by OceanGeometry.
 *
 * Phase 3 = base deep-water look. Coastal shallows (Phase 4) and reflections / wake / splash
 * (Phase 5) are grafted into these same hooks afterwards.
 */
import {
  Scene, Camera, Vector2, Vector3, Vector4, Texture, DynamicTexture, BaseTexture,
} from '@babylonjs/core';
import { PBRCustomMaterial } from '@babylonjs/materials';
import type { OceanFFTEngine } from '../ocean-fft-engine.service';
import { WAKE_POINTS, WAKE_MAX_BOATS, WAKE_LIFE } from './wake-tracker';

export interface OceanMaterialDeps {
  scene: Scene;
  camera: Camera;
  fft: OceanFFTEngine;
  /** Linear scene depth (ocean excluded) for contact foam; null disables contact foam. */
  depthTexture: BaseTexture | null;
  /** Current sun/light direction (world). */
  getSunDir: () => Vector3;
  /** Shared ocean elapsed-time seconds. */
  getTime: () => number;
  /** Planar reflection RTT (skybox + islands + vessels), sampled by screen UV. Null = none. */
  reflectionTexture: BaseTexture | null;
  /** Live shore/elevation map for shoaling + shallow shading (R = clamp((elev+15)/20)). */
  getShore: (() => { map: BaseTexture; center: Vector2; size: number }) | null;
  /** Seabed colour RTT (scene minus ocean) for shallow-water transparency. Null = none. */
  refractionTexture: BaseTexture | null;
  /** Live boat pose for the wake (dir = heading unit vector, speed scaled). Null = no wake. */
  getBoatWake: (() => { x: number; z: number; dirX: number; dirZ: number; speed: number }) | null;
  /** Per-vessel wake paths (local + remotes): flat `paths` (vec4 ×WAKE_MAX_BOATS·WAKE_POINTS),
   *  `meta` (vec4 ×WAKE_MAX_BOATS: x,z,count,speed), and active boat count. Curved wakes for all. */
  getWakePaths: (() => { paths: Float32Array; meta: Float32Array; count: number }) | null;
  /** Active cannonball water impacts (vec4×8: x,z,age,_) + count, for splash displacement. */
  getSplashData: (() => { data: Float32Array; count: number }) | null;
  /** Active cannon muzzle flashes (vec4×6: x,z,age,_) + count + life, for a brief warm emissive glow. */
  getCannonFlash: (() => { data: Float32Array; count: number; life: number }) | null;
  /** Island shadow mask + transform + strength + cloud cover, for shadows on the water. */
  getWaterShadow: (() => { map: BaseTexture; center: Vector2; size: number; strength: number; cloud: number; cloudDrift: Vector2; cloudCovThresh: number; cloudBase: number }) | null;
  /** All vessel positions (local + remote) for boat shadows: vec4×8 (x,z,_,_) + count. */
  getBoatShadows: (() => { data: Float32Array; count: number }) | null;
  /** Rain intensity 0..1 — peppers the near surface with raindrop ripples. */
  getRain: (() => number) | null;
  /** Sea choppiness 0..1 — trims whitecap foam in heavy seas so it doesn't over-foam. */
  getChoppiness?: (() => number) | null;
}

export class OceanFFTMaterial {
  private _deps: OceanMaterialDeps;
  private _foamTexture: Texture;

  constructor(deps: OceanMaterialDeps) {
    this._deps = deps;
    this._foamTexture = this._makeFoamTexture(deps.scene);
  }

  /** Build one LOD variant. close → 3 cascades, mid → 2, far → 1. */
  getMaterial(useMid: boolean, useClose: boolean): PBRCustomMaterial {
    const { scene, camera, fft } = this._deps;
    const mat = new PBRCustomMaterial(`oceanFFT${useMid ? '1' : '0'}${useClose ? '1' : '0'}`, scene);

    mat.metallic = 0;
    mat.roughness = 0.311;
    mat.forceIrradianceInFragment = true;
    // Our scene is left-handed (demo was right-handed); disable culling so the surface
    // isn't culled from above by reversed winding. (Revisit once handedness is confirmed.)
    mat.backFaceCulling = false;

    const color = new Vector3(0.011126082368383245, 0.05637409755197975, 0.09868919754109445);

    mat.AddUniform('_Color', 'vec3', color);
    mat.AddUniform('_MaxGloss', 'float', 0.91);
    mat.AddUniform('_RoughnessScale', 'float', 0.0044);
    mat.AddUniform('_LOD_scale', 'float', 7.13);

    mat.AddUniform('_FoamColor', 'vec3', new Vector3(1, 1, 1));
    mat.AddUniform('_FoamScale', 'float', 2.6);   // whitecap contrast (between demo 2.4 and 2.8)
    mat.AddUniform('_ContactFoam', 'float', this._deps.depthTexture ? 1 : 0);
    mat.AddUniform('_FoamBiasLOD0', 'float', 0.895);   // caps form on moderate seas
    mat.AddUniform('_FoamBiasLOD1', 'float', 1.905);
    mat.AddUniform('_FoamBiasLOD2', 'float', 2.80);
    mat.AddUniform('_Choppiness', 'float', 0.3);   // sea state 0..1 — trims foam in heavy seas

    mat.AddUniform('_SSSColor', 'vec3', new Vector3(0.1541919, 0.8857628, 0.990566));
    mat.AddUniform('_SSSStrength', 'float', 0.205);   // back-lit glow (between demo 0.15 and 0.26)
    mat.AddUniform('_SSSBase', 'float', -0.261);
    mat.AddUniform('_SSSScale', 'float', 4.7);

    mat.AddUniform('lightDirection', 'vec3', '');
    mat.AddUniform('_WorldSpaceCameraPos', 'vec3', '');
    mat.AddUniform('LengthScale0', 'float', fft.getLengthScale(0));
    mat.AddUniform('LengthScale1', 'float', fft.getLengthScale(1));
    mat.AddUniform('LengthScale2', 'float', fft.getLengthScale(2));
    mat.AddUniform('_Displacement_c0', 'sampler2D', fft.getDisplacementTex(0));
    mat.AddUniform('_Derivatives_c0', 'sampler2D', fft.getDerivativesTex(0));
    mat.AddUniform('_Turbulence_c0', 'sampler2D', fft.getTurbulenceTex(0));
    mat.AddUniform('_Displacement_c1', 'sampler2D', fft.getDisplacementTex(1));
    mat.AddUniform('_Derivatives_c1', 'sampler2D', fft.getDerivativesTex(1));
    mat.AddUniform('_Turbulence_c1', 'sampler2D', fft.getTurbulenceTex(1));
    mat.AddUniform('_Displacement_c2', 'sampler2D', fft.getDisplacementTex(2));
    mat.AddUniform('_Derivatives_c2', 'sampler2D', fft.getDerivativesTex(2));
    mat.AddUniform('_Turbulence_c2', 'sampler2D', fft.getTurbulenceTex(2));
    mat.AddUniform('_Time', 'float', 0);
    mat.AddUniform('_CameraData', 'vec4', new Vector4(camera.minZ, camera.maxZ, camera.maxZ - camera.minZ, 0));
    mat.AddUniform('_FoamTexture', 'sampler2D', this._foamTexture);
    if (this._deps.depthTexture) {
      mat.AddUniform('_CameraDepthTexture', 'sampler2D', this._deps.depthTexture);
    }
    if (this._deps.reflectionTexture) {
      mat.AddUniform('_Reflection', 'sampler2D', this._deps.reflectionTexture);
      mat.AddUniform('_ReflStrength', 'float', 0.9);
    }
    const shore0 = this._deps.getShore?.() ?? null;
    if (shore0) {
      mat.AddUniform('_ShoreMap', 'sampler2D', shore0.map);
      mat.AddUniform('_ShoreCenter', 'vec2', shore0.center);
      mat.AddUniform('_ShoreSize', 'float', shore0.size);
    }
    const hasRefraction = !!(shore0 && this._deps.refractionTexture);
    if (hasRefraction) {
      mat.AddUniform('_Refraction', 'sampler2D', this._deps.refractionTexture);
    }
    const hasWake = !!(this._deps.getBoatWake && this._deps.getWakePaths);
    if (hasWake) {
      mat.AddUniform('_BoatPos', 'vec2', new Vector2(0, 0));   // local boat (calm + deep-water transparency halo)
      mat.AddUniform(`_WakePaths[${WAKE_MAX_BOATS * WAKE_POINTS}]`, 'vec4', '');   // x,z,age,_ per point
      mat.AddUniform(`_WakeMeta[${WAKE_MAX_BOATS}]`, 'vec4', '');                  // x,z,count,speed per boat
      mat.AddUniform('_WakeBoatCount', 'float', '');
    }
    const hasSplash = !!this._deps.getSplashData;
    if (hasSplash) {
      mat.AddUniform('_SplashData[8]', 'vec4', '');   // x, z, age, _
      mat.AddUniform('_SplashCount', 'float', '');
    }
    const hasFlash = !!this._deps.getCannonFlash;
    if (hasFlash) {
      mat.AddUniform('_FlashData[6]', 'vec4', '');    // x, z, age, _
      mat.AddUniform('_FlashCount', 'float', '');
      mat.AddUniform('_FlashLife', 'float', '');
    }
    const shadow0 = this._deps.getWaterShadow?.() ?? null;
    const hasShadows = !!shadow0;
    if (shadow0) {
      mat.AddUniform('_TerrainShadowMask', 'sampler2D', shadow0.map);
      mat.AddUniform('_TShadowCenter', 'vec2', shadow0.center);
      mat.AddUniform('_TShadowSize', 'float', shadow0.size);
      mat.AddUniform('_TShadowStrength', 'float', 0);
      mat.AddUniform('_CloudCover', 'float', 0);
      mat.AddUniform('_SunDir', 'vec3', new Vector3(0, 1, 0));
      // Live cloud-shadow state (matches the volumetric clouds: wind drift, coverage threshold,
      // base altitude) so the water's cloud shadows trace and drift with the real clouds.
      mat.AddUniform('_CloudDrift', 'vec2', new Vector2(0, 0));
      mat.AddUniform('_CloudCovThresh', 'float', 999.0);
      mat.AddUniform('_CloudBaseH', 'float', 900.0);
    }
    const hasBoatShadows = !!(shadow0 && this._deps.getBoatShadows);
    if (hasBoatShadows) {
      mat.AddUniform('_BoatShadowData[8]', 'vec4', '');   // x, z, _, _
      mat.AddUniform('_BoatShadowCount', 'float', '');
    }
    const hasRain = !!this._deps.getRain;
    if (hasRain) {
      mat.AddUniform('_RainIntensity', 'float', 0);
    }

    const defines: string[] = [];
    if (useMid) { defines.push('#define MID'); }
    if (useClose) { defines.push('#define CLOSE'); }
    const depthDef = this._deps.depthTexture ? '#define HAS_DEPTH' : '';
    const reflDef = this._deps.reflectionTexture ? '#define HAS_REFLECTION' : '';
    const shoreDef = shore0 ? '#define HAS_SHORE' : '';
    const refrDef = hasRefraction ? '#define HAS_REFRACTION' : '';
    const wakeDef = hasWake ? '#define HAS_WAKE' : '';
    const splashDef = hasSplash ? '#define HAS_SPLASH' : '';
    const flashDef = hasFlash ? '#define HAS_FLASH' : '';
    const shadowDef = hasShadows ? '#define HAS_SHADOWS' : '';
    const boatShadowDef = hasBoatShadows ? '#define HAS_BOATSHADOWS' : '';
    const rainDef = hasRain ? '#define HAS_RAIN' : '';
    // Raindrop ripples: one jittered drop per cell — a sharp central plip + an expanding ring
    // — whose gradient dimples the surface normal so the rain reads as impacts on the water.
    const rainFn = hasRain ? `
      float _rvHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float _rainField(vec2 p, float t){
        vec2 cell = floor(p);
        vec2 f = fract(p);
        float h1 = _rvHash(cell), h2 = _rvHash(cell + 5.7), h3 = _rvHash(cell + 11.3), h4 = _rvHash(cell + 19.1);
        vec2 center = vec2(0.2 + h1 * 0.6, 0.2 + h2 * 0.6);
        float rate = mix(1.0, 3.2, h3);
        float life = fract(t * rate + h1 * 7.0);
        float r = length(f - center);
        float sz = mix(0.16, 0.42, h4);
        float impact = (1.0 - smoothstep(0.0, sz * 0.55, r)) * (1.0 - smoothstep(0.0, 0.22, life));
        float ringR = life * sz * 1.6;
        float ring = 1.0 - smoothstep(0.0, sz * 0.34, abs(r - ringR));
        ring *= smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.5, 1.0, life));
        return impact + ring * 0.6;
      }
    ` : '';
    // Island + cloud shadows on the water (world-space, so they darken our emissive water
    // which PBR's own shadow path can't reach). Cloud shadows: drifting value noise projected
    // down-sun. Plus a soft round shadow under the local boat.
    const shadowFn = hasShadows ? `
      float _hashS(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float _vnoiseS(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = _hashS(i), b = _hashS(i + vec2(1.,0.)), c = _hashS(i + vec2(0.,1.)), d = _hashS(i + vec2(1.,1.));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float _waterShadow(vec2 wxz) {
        float sh = 0.0;
        float halfSize = max(1.0, _TShadowSize * 0.5);
        vec2 tuv = (wxz - _TShadowCenter) / (halfSize * 2.0) + 0.5;
        // Sample unconditionally (uniform control flow) — texture2D inside a branch is an
        // illegal non-uniform textureSample on WebGPU and kills the fragment pipeline.
        // Mask the result to the in-bounds region instead of gating the sample itself.
        float inBounds = step(0.0, tuv.x) * step(tuv.x, 1.0) * step(0.0, tuv.y) * step(tuv.y, 1.0);
        sh = texture2D(_TerrainShadowMask, clamp(tuv, 0.0, 1.0)).r * _TShadowStrength * inBounds;
        if (_SunDir.y > 0.03 && _CloudCover > 0.02) {
          // Cloud shadow: project the surface point up-sun to the cloud layer, then sample a
          // cloud-scaled coverage noise that DRIFTS in sync with the real clouds (_CloudDrift)
          // and at the real base altitude (_CloudBaseH). Threshold falls with coverage → more
          // cloud, more & darker dappling.
          vec2 cloudXZ = wxz + _SunDir.xz / max(_SunDir.y, 0.15) * _CloudBaseH;
          vec2 sp = cloudXZ + _CloudDrift;
          float cf = _vnoiseS(sp * 0.0013) * 0.65 + _vnoiseS(sp * 0.0037) * 0.35;
          float cs = smoothstep(0.58 - _CloudCover * 0.45, 0.70 - _CloudCover * 0.30, cf);
          cs *= smoothstep(0.05, 0.35, _CloudCover) * smoothstep(0.03, 0.18, _SunDir.y);
          sh = max(sh, cs * 0.85);
        }
        #ifdef HAS_BOATSHADOWS
          // Soft shadow under every vessel (local + remote), cast down-sun.
          if (_SunDir.y > 0.03 && _BoatShadowCount > 0.5) {
            vec2 off = _SunDir.xz / max(_SunDir.y, 0.35) * 2.0;
            float gate = smoothstep(0.03, 0.22, _SunDir.y) * 0.5;
            for (int i = 0; i < 8; i++) {
              if (float(i) >= _BoatShadowCount) break;
              float bd = length(wxz - (_BoatShadowData[i].xy - off));
              sh = max(sh, (1.0 - smoothstep(5.5, 11.0, bd)) * gate);
            }
          }
        #endif
        return sh;
      }
    ` : '';
    // Cannonball water impact: crater punches down (~0.16s), rebounds into a geyser column
    // (~0.62s), and an expanding ring ripples out — fading over ~1.6s. Pure vertical
    // displacement, added on top of the swell so the spout rides the waves.
    const splashFn = hasSplash ? `
      float _splashDisp(vec2 wxz) {
        if (_SplashCount < 0.5) return 0.0;
        float sum = 0.0;
        for (int i = 0; i < 8; i++) {
          if (float(i) >= _SplashCount) break;
          vec2 c = _SplashData[i].xy;
          float age = _SplashData[i].z;
          float life = 1.0 - age / 1.6;
          if (life <= 0.0) continue;
          float r = length(wxz - c);
          float qc = (age - 0.16) / 0.22;
          float qg = (age - 0.62) / 0.24;
          float crater = -exp(-(r * r) / 5.0)  * exp(-qc * qc) * 3.0;
          float geyser =  exp(-(r * r) / 2.56) * exp(-qg * qg) * 2.6;
          float ringR  = age * 6.0;
          float ring   =  exp(-((r - ringR) * (r - ringR)) / 2.56) * life * 0.5;
          sum += crater + geyser + ring;
        }
        return sum;
      }
      float _splashFoam(vec2 wxz) {
        if (_SplashCount < 0.5) return 0.0;
        float f = 0.0;
        for (int i = 0; i < 8; i++) {
          if (float(i) >= _SplashCount) break;
          vec2 c = _SplashData[i].xy;
          float age = _SplashData[i].z;
          float life = 1.0 - age / 1.6;
          if (life <= 0.0) continue;
          float r = length(wxz - c);
          float col  = exp(-(r * r) / 4.0) * smoothstep(0.0, 0.25, age) * life;   // churned column
          float ringR = age * 6.0;
          float ring  = exp(-((r - ringR) * (r - ringR)) / 3.0) * life * 0.8;      // foam ring
          f = max(f, max(col, ring));
        }
        return f;
      }
    ` : '';
    // Cannon muzzle-flash: a brief, local warm glow added to the sea's emissive colour, so the
    // water lights up when a broadside fires (a scene point light can't light the emissive ocean).
    const flashFn = hasFlash ? `
      vec3 _cannonFlashGlow(vec2 wxz) {
        if (_FlashCount < 0.5) return vec3(0.0);
        vec3 sum = vec3(0.0);
        for (int i = 0; i < 6; i++) {
          if (float(i) >= _FlashCount) break;
          vec2 c = _FlashData[i].xy;
          float age = _FlashData[i].z;
          float t01 = age / max(_FlashLife, 0.001);
          if (t01 >= 1.0) continue;
          // Instant onset, quick fade (sharp at ignition, gone within FLASH_LIFE).
          float env = (1.0 - t01) * (1.0 - t01);
          float r = length(wxz - c);
          // ~16 m soft pool of light, fading with distance — stays local to the firing ship.
          float fall = exp(-(r * r) / 110.0);
          // Hull occlusion: the muzzle sits on the firing side, the keel runs perpendicular to the
          // beam direction D. Mask the glow to the firing side of the keel centreline (~2.5 m
          // inboard of the muzzle) so the hull blocks the far side — port fire doesn't light stbd.
          vec2 D = vec2(cos(_FlashData[i].w), sin(_FlashData[i].w));
          float sFrag = dot(wxz - c, D) + 2.5;   // >0 firing side, ramps negative across the keel
          float sideMask = mix(0.08, 1.0, smoothstep(-1.5, 1.5, sFrag));
          sum += vec3(1.0, 0.52, 0.18) * env * fall * sideMask;
        }
        return sum;
      }
    ` : '';
    // Wake along the boat's actual (curved) CPU track: find the nearest point on the path
    // polyline, then build a turbulent core + a pair of diverging bow-wave edges that spread
    // as the wake ages. Following the track means the wake bends through turns. Returns
    // (core, edge); both fade with the track point's age.
    const wakeFn = hasWake ? `
      vec2 _wakeCV(vec2 wxz) {
        vec2 res = vec2(0.0);
        for (int b = 0; b < ${WAKE_MAX_BOATS}; b++) {
          if (float(b) >= _WakeBoatCount) break;
          vec4 bmeta = _WakeMeta[b];                                    // x, z, count, speed
          if (dot(wxz - bmeta.xy, wxz - bmeta.xy) > 45000.0) continue;  // ~210 m cull per ship
          if (bmeta.z < 2.0) continue;
          int base = b * ${WAKE_POINTS};
          float bestD = 1.0e9;
          float bestAge = 0.0;
          float bestSpd = 0.0;
          for (int i = 0; i < ${WAKE_POINTS - 1}; i++) {
            if (float(i) >= bmeta.z - 1.0) break;
            vec2 a = _WakePaths[base + i].xy;
            vec2 c = _WakePaths[base + i + 1].xy;
            vec2 ab = c - a;
            float L2 = max(dot(ab, ab), 1.0e-3);
            float t = clamp(dot(wxz - a, ab) / L2, 0.0, 1.0);
            float d = length(wxz - (a + ab * t));
            if (d < bestD) {
              bestD = d;
              bestAge = mix(_WakePaths[base + i].z, _WakePaths[base + i + 1].z, t);
              bestSpd = mix(_WakePaths[base + i].w, _WakePaths[base + i + 1].w, t);   // laydown speed
            }
          }
          float ageFade = 1.0 - smoothstep(0.0, ${(WAKE_LIFE - 1).toFixed(1)}, bestAge);
          if (ageFade <= 0.001) continue;
          // Strength + width scale with how fast the ship was when it laid this segment
          // (bestSpd = abs(m/s)×4): a crawling ship leaves a faint, narrow trail; one at
          // speed a broad, bright one. Old fast wakes stay strong even after the ship slows.
          float speedFac = mix(0.08, 1.0, smoothstep(3.0, 16.0, bestSpd));
          float width = 1.6 + min(9.0, bestAge * 1.1) + min(6.0, bestSpd * 0.30);
          float coreW = max(1.5, width * 0.40);
          float core = exp(-(bestD * bestD) / (coreW * coreW)) * ageFade * speedFac;
          float edge = exp(-((bestD - width) * (bestD - width)) / 5.0) * ageFade * speedFac;
          res = max(res, vec2(core, edge));
        }
        return res;
      }
    ` : '';
    // Shared shore-proximity helper (R = land elevation; ~0.75 = waterline). 0 outside the map.
    const shoreFn = shore0 ? `
      float _shoreProx(vec2 wxz) {
        vec2 uv = (wxz - _ShoreCenter) / _ShoreSize + 0.5;
        // Sample unconditionally (uniform control flow) then mask — texture2D after an early
        // return is an illegal non-uniform textureSample on WebGPU (same trap as _waterShadow).
        float inB = step(0.001, uv.x) * step(uv.x, 0.999) * step(0.001, uv.y) * step(uv.y, 0.999);
        return texture2D(_ShoreMap, clamp(uv, 0.001, 0.999)).r * inB;
      }
    ` : '';
    // Drifting fish silhouettes on the seabed (ported from the procedural ocean): one fish
    // per ~12 m cell wandering a Lissajous path, body aligned to its heading.
    const fishFn = hasRefraction ? `
      float fishHash(vec2 id) { return fract(sin(dot(id, vec2(41.3, 289.1))) * 43758.5453); }
      float fishField(vec2 p, float t) {
        float scale = 0.15;                     // smaller cells (~6.7 m) → many more fish
        vec2  id  = floor(p * scale);
        float rnd = fishHash(id);
        if (rnd <= 0.45) return 0.0;            // ~55% of cells hold a fish (was ~24%)
        float szr = fishHash(id + 31.7);
        float ph  = rnd * 53.0;
        float sp1 = 0.30 + rnd * 0.55;
        float sp2 = 0.40 + fract(rnd * 7.3) * 0.60;
        vec2  cellC = (id + 0.5) / scale;
        vec2  fishC = cellC + vec2(sin(t * sp1 + ph), sin(t * sp2 + ph * 1.7)) * 2.6;
        vec2  vel   = vec2(sp1 * cos(t * sp1 + ph), sp2 * cos(t * sp2 + ph * 1.7));
        vec2  fwd   = normalize(vel + vec2(1e-4, 0.0));
        vec2  rel   = p - fishC;
        vec2  local = vec2(dot(rel, fwd), dot(rel, vec2(-fwd.y, fwd.x)));
        local /= (0.22 + szr * 0.30);   // much smaller fish (< half the old size)
        float fx = local.x;
        float fy = abs(local.y);
        float shape = 0.0;
        if (fx > -0.45 && fx < 0.85) {
          float bs = (fx + 0.45) / 1.30;
          float w  = max(0.045, 0.34 * sin(bs * 3.14159));
          shape = max(shape, 1.0 - smoothstep(w * 0.45, w, fy));
        }
        if (fx > -1.15 && fx <= -0.35) {
          float ts = (-0.35 - fx) / 0.80;
          float tw = 0.05 + ts * 0.34;
          shape = max(shape, (1.0 - smoothstep(tw * 0.45, tw, fy)) * 0.88);
        }
        return shape * (0.70 + rnd * 0.30);
      }
    ` : '';

    // WebGPU caps vertex→fragment varyings at 16 (PBR already uses ~11), so keep these
    // minimal: per-cascade UVs are recomputed in the fragment. vClipCoords (4th) feeds the
    // screen-space reflection + depth foam → 4 custom = 15 total, under the limit.
    const varyings = `
      varying vec2 vWorldUV;
      varying vec3 vViewVector;
      varying vec4 vLodScales;
      varying vec4 vClipCoords;
    `;

    const allDefs = `${defines.join('\n')}\n${depthDef}\n${reflDef}\n${shoreDef}\n${refrDef}\n${wakeDef}\n${splashDef}\n${flashDef}\n${shadowDef}\n${boatShadowDef}\n${rainDef}`;
    mat.Vertex_Definitions(`${allDefs}\n${varyings}\n${shoreFn}\n${wakeFn}\n${splashFn}`);
    mat.Fragment_Definitions(`${allDefs}\n${varyings}\n${shoreFn}\n${fishFn}\n${wakeFn}\n${splashFn}\n${flashFn}\n${shadowFn}\n${rainFn}`);

    mat.Vertex_After_WorldPosComputed(`
      vWorldUV = worldPos.xz;

      vViewVector = _WorldSpaceCameraPos - worldPos.xyz;
      float viewDist = length(vViewVector);

      float lod_c0 = min(_LOD_scale * LengthScale0 / viewDist, 1.0);
      float lod_c1 = min(_LOD_scale * LengthScale1 / viewDist, 1.0);
      float lod_c2 = min(_LOD_scale * LengthScale2 / viewDist, 1.0);

      vec3 displacement = vec3(0.);
      float largeWavesBias = 0.;

      vec2 uv0 = vWorldUV / LengthScale0;
      vec2 uv1 = vWorldUV / LengthScale1;
      vec2 uv2 = vWorldUV / LengthScale2;

      displacement += texture2D(_Displacement_c0, uv0).xyz * lod_c0;
      largeWavesBias = displacement.y;

      #if defined(MID) || defined(CLOSE)
        displacement += texture2D(_Displacement_c1, uv1).xyz * lod_c1;
      #endif
      #if defined(CLOSE)
        displacement += texture2D(_Displacement_c2, uv2).xyz * lod_c2;
      #endif

      #ifdef HAS_SHORE
        // Shoaling: flatten the swell into the beach. Full height in deep water, →0 at the
        // waterline (~0.73) — this also stops wave crests popping up through low-lying land.
        float shoal = 1.0 - smoothstep(0.52, 0.73, _shoreProx(vWorldUV));
        displacement *= shoal;
        largeWavesBias *= shoal;
      #endif

      #ifdef HAS_WAKE
        // Boat-footprint calming: damp the swell right around the hull so wave crests can't
        // rise up through the deck. Matched on the CPU (height provider) so buoyancy agrees.
        displacement *= (0.45 + 0.55 * smoothstep(6.0, 16.0, length(vWorldUV - _BoatPos)));

        // Wake riding on the swell: flatten the FFT chop in the churned core (the boat
        // smooths the water), carve a trough there, and raise the diverging bow-wave crests.
        vec2 wcv = _wakeCV(vWorldUV);
        displacement *= (1.0 - 0.65 * wcv.x);
        displacement.y += -0.80 * wcv.x + 0.70 * wcv.y;
      #endif

      #ifdef HAS_SPLASH
        // Transient cannonball impacts ride on top of the swell (not flattened by wake/shore).
        displacement.y += _splashDisp(vWorldUV);
      #endif

      worldPos.xyz += displacement;

      vLodScales = vec4(lod_c0, lod_c1, lod_c2, max(displacement.y - largeWavesBias * 0.8 - _SSSBase, 0.) / _SSSScale);
    `);

    mat.Vertex_MainEnd(`
      vClipCoords = gl_Position;
    `);

    mat.Fragment_Before_Lights(`
      vec2 uv0 = vWorldUV / LengthScale0;
      vec2 uv1 = vWorldUV / LengthScale1;
      vec2 uv2 = vWorldUV / LengthScale2;

      vec4 derivatives = texture2D(_Derivatives_c0, uv0);
      #if defined(MID) || defined(CLOSE)
        derivatives += texture2D(_Derivatives_c1, uv1) * vLodScales.y;
      #endif
      #if defined(CLOSE)
        derivatives += texture2D(_Derivatives_c2, uv2) * vLodScales.z;
      #endif

      vec2 slope = vec2(derivatives.x / (1.0 + derivatives.z), derivatives.y / (1.0 + derivatives.w));
      normalW = normalize(vec3(-slope.x, 1.0, -slope.y));

      #ifdef HAS_RAIN
        // Dimple the normal with raindrop ripples near the camera, scaled by rain intensity.
        if (_RainIntensity > 0.01) {
          float nearF = 1.0 - smoothstep(25.0, 180.0, length(vViewVector));
          if (nearF > 0.001) {
            float rt = _Time * 10.0;
            vec2  rp = vWorldUV * 2.2;
            float e  = 0.18;
            float n0 = _rainField(rp, rt);
            vec2  grad = vec2(_rainField(rp + vec2(e, 0.0), rt) - n0,
                              _rainField(rp + vec2(0.0, e), rt) - n0) / e;
            normalW = normalize(normalW + vec3(grad.x, 0.0, grad.y) * (0.65 * _RainIntensity * nearF));
          }
        }
      #endif

      // Choppy seas have far more turbulence variance, so a wide area dips below the foam
      // bias → whitecaps everywhere. Trim the bias as choppiness rises so heavy seas don't
      // over-foam; calm water (chop≈0) is left exactly as before. (Lower bias ⇒ less foam.)
      float foamChop = 1.0 - _Choppiness * 0.32;
      #if defined(CLOSE)
        float jacobian = texture2D(_Turbulence_c0, uv0).x + texture2D(_Turbulence_c1, uv1).x + texture2D(_Turbulence_c2, uv2).x;
        jacobian = min(1.0, max(0.0, (-jacobian + _FoamBiasLOD2 * foamChop) * _FoamScale));
      #elif defined(MID)
        float jacobian = texture2D(_Turbulence_c0, uv0).x + texture2D(_Turbulence_c1, uv1).x;
        jacobian = min(1.0, max(0.0, (-jacobian + _FoamBiasLOD1 * foamChop) * _FoamScale));
      #else
        float jacobian = texture2D(_Turbulence_c0, uv0).x;
        jacobian = min(1.0, max(0.0, (-jacobian + _FoamBiasLOD0 * foamChop) * _FoamScale));
      #endif

      #ifdef HAS_DEPTH
        vec2 screenUV = vClipCoords.xy / vClipCoords.w;
        screenUV = screenUV * 0.5 + 0.5;
        float backgroundDepth = texture2D(_CameraDepthTexture, screenUV).r * _CameraData.y;
        float surfaceDepth = vClipCoords.z;
        float depthDifference = max(0.0, (backgroundDepth - surfaceDepth) - 0.5);
        float foam = texture2D(_FoamTexture, vWorldUV * 0.5 + _Time * 2.).r;
        jacobian += _ContactFoam * saturate(max(0.0, foam - depthDifference) * 5.0) * 0.9;
      #endif

      // (Shoreline foam removed — the coast is handled by a water→sand transparency runoff
      //  in the colour-composition stage instead.)

      #ifdef HAS_WAKE
        // Wake foam: bright churned core + thin diverging bow-wave lines, broken up by a
        // scrolling foam texture so it reads as turbulent froth rather than a painted band.
        vec2 wcvF = _wakeCV(vWorldUV);
        float wakeFoam = wcvF.x * 0.95 + wcvF.y * 0.85;
        float wfTex = texture2D(_FoamTexture, vWorldUV * 0.09 + _Time * 1.4).r
                    * texture2D(_FoamTexture, vWorldUV * 0.21 - _Time * 0.9).r;
        wakeFoam *= smoothstep(0.05, 0.45, wfTex + 0.18);
        jacobian = max(jacobian, clamp(wakeFoam, 0.0, 1.0));
      #endif

      #ifdef HAS_SPLASH
        // Foam at the geyser column + the expanding rebound ring.
        jacobian = max(jacobian, clamp(_splashFoam(vWorldUV), 0.0, 1.0));
      #endif

      #ifdef HAS_SHORE
        // Calm the whitecap foam across the whole shallow zone so the shoreline isn't ringed by
        // a bright foamy band — the shallows are shoal-calmed clear water, so no whitecaps.
        jacobian *= 1.0 - smoothstep(0.12, 0.48, _shoreProx(vWorldUV)) * 0.96;
      #endif

      // (Rain reads purely as the dimpled surface NORMAL — see HAS_RAIN above — no white foam.)

      surfaceAlbedo = mix(vec3(0.0), _FoamColor, jacobian);

      vec3 viewDir = normalize(vViewVector);
      vec3 H = normalize(-normalW + lightDirection);
      // Back-lit subsurface glow is SUN-driven — fade it out as the sun sets so the sea
      // doesn't keep glowing turquoise after dark (lightDirection.y > 0 ⇒ sun above horizon,
      // same convention the shadow pass uses).
      float sunUp = smoothstep(0.0, 0.12, lightDirection.y);
      float ViewDotH = pow5(saturate(dot(viewDir, -H))) * 30.0 * _SSSStrength * sunUp;
      vec3 color = mix(_Color, saturate(_Color + _SSSColor.rgb * ViewDotH * vLodScales.w), vLodScales.z);

      float fresnel = dot(normalW, viewDir);
      fresnel = saturate(1.0 - fresnel);
      fresnel = pow5(fresnel);
    `);

    mat.Fragment_Custom_MetallicRoughness(`
      float distanceGloss = mix(1.0 - metallicRoughness.g, _MaxGloss, 1.0 / (1.0 + length(vViewVector) * _RoughnessScale));
      metallicRoughness.g = 1.0 - mix(distanceGloss, 0.0, jacobian);
      #ifdef HAS_SHORE
        // Drive the shoal-calmed shallows fully MATTE so the sun/sky specular can't form a
        // bright band along the shore — the glossy default (roughness ~0.09 at distance) was
        // mirroring the sky at the grazing angle. Reaches full roughness by the outer shallows.
        metallicRoughness.g = mix(metallicRoughness.g, 1.0, smoothstep(0.0, 0.28, _shoreProx(vWorldUV)));
      #endif
    `);

    mat.Fragment_Before_FinalColorComposition(`
      vec3 waterCol = color * (1.0 - fresnel);
      // Water→sand runoff: 0 in open water, ramping to 1 right at the shoreline so the water
      // dissolves into the seabed and there's no obvious line where it starts/ends.
      float shoreFade = 0.0;
      float shoalReveal = 0.0;   // how much seabed shows (set in the refraction stage) — dims surface glint
      float shoreReflCut = 1.0;  // cuts sky reflection across the shallows (kills the blue ring offshore)
      #ifdef HAS_SHORE
        float prox = _shoreProx(vWorldUV);
        shoreFade = smoothstep(0.70, 0.95, prox);
        shoreReflCut = 1.0 - smoothstep(0.0, 0.40, prox) * 0.99;   // suppress the sky glint across the shallows
        // Shallow turquoise water-column tint as the seabed rises toward the beach. It's
        // emissive (unaffected by scene lighting), so without a day factor it glows brightly
        // (Shallow turquoise water-column tint removed — the shallows now read purely from the
        //  revealed seabed below, for a clear-water look.)
        #ifdef HAS_REFRACTION
          // True transparency: blend in the seabed colour (scene-minus-ocean RTT), revealed
          // more as the water shallows. Refracted slightly by the wave normal.
          // Shallow seabed reveal, plus a strong boost right around the hull so the submerged
          // hull/keel shows through the water near the boat (where the refraction RTT has it),
          // plus a faint global baseline.
          // Wide ramp so the whole shallow zone reads as transparent — you see the sea floor
          // (and the boat's shadow/keel on it) right across the shallows, not just at the very
          // edge — plus a strong near-hull boost and a faint deep-water baseline.
          float reveal = smoothstep(0.40, 0.82, prox);   // pulled in, but a wide ramp so the shallows' edge gives way gradually
          #ifdef HAS_WAKE
            reveal = max(reveal, 0.75 * (1.0 - smoothstep(2.0, 14.0, length(vWorldUV - _BoatPos))));
          #endif
          reveal = max(reveal, 0.06);
          vec2 refrUV = clamp(vClipCoords.xy / vClipCoords.w * 0.5 + 0.5 + normalW.xz * 0.02, vec2(0.002), vec2(0.998));
          vec3 refr = texture2D(_Refraction, refrUV).rgb;
          // Only reveal where there's actually a seabed behind the water — the refraction RTT
          // clears to black where the seabed has dropped off, so gate by its brightness to
          // avoid a band there (the water just shows its own deep colour instead).
          reveal *= smoothstep(0.02, 0.16, max(refr.r, max(refr.g, refr.b)));
          shoalReveal = reveal;   // shared with the reflection stage to dim glint over the shallows
          // Drifting fish on the seabed — only with the camera above water (_Time is /10, so ×10).
          if (_WorldSpaceCameraPos.y > 0.05) {
            float fish = fishField(vWorldUV, _Time * 10.0);
            refr *= (1.0 - fish * 0.5);
          }
          // Broad shallows: reveal the sandy bottom so you can SEE the sea floor through the
          // water. Kept on the wet/darker side so the submerged sand matches the wet sand the
          // terrain paints at the waterline (rather than reading lighter).
          // The revealed seabed is emissive; the lit terrain darkens with the scene but the
          // refraction's flat tan clear-colour does not, so it glows after dark. Day-gate it
          // (sunUp: 0 below horizon → 1 in daylight) so the shallows fade to dark at night.
          vec3 seabedSand = refr * vec3(0.62, 0.62, 0.55) * (0.08 + 0.92 * sunUp);
          // Reveal the sandy bottom across the shallows; at the very shoreline ramp it to full
          // so the water dissolves into the matching beach sand — no hard line, no teal ring.
          waterCol = mix(waterCol, seabedSand, max(reveal * 0.85, shoreFade));
        #endif
        // Subtle turquoise ring at the OUTER edge of the shallows (deep → shallow transition),
        // sun-gated so it doesn't glow at night.
        float shoalRing = smoothstep(0.16, 0.30, prox) * (1.0 - smoothstep(0.34, 0.52, prox));
        waterCol = mix(waterCol, vec3(0.10, 0.48, 0.50) * (1.0 - fresnel), shoalRing * 0.16 * sunUp);
      #endif
      #ifdef HAS_REFLECTION
        // Planar mirror reflection (skybox + islands + vessels), rippled by the wave normal,
        // strongest at grazing angles (Fresnel). Sampled in screen space.
        vec2 reflUV = vClipCoords.xy / vClipCoords.w * 0.5 + 0.5;
        reflUV += normalW.xz * 0.04;
        reflUV = clamp(reflUV, vec2(0.002), vec2(0.998));
        vec3 planarRefl = texture2D(_Reflection, reflUV).rgb;
        // Strongly dim the surface glint over the clear shallows so the wet sandy bottom shows
        // through as SAND, not a turquoise sky reflection — this is what makes the dissolved
        // shoreline blend to sand rather than reading teal.
        waterCol += planarRefl * fresnel * _ReflStrength * (1.0 - shoreFade) * shoreReflCut;
      #endif
      #ifdef HAS_SHADOWS
        waterCol *= (1.0 - _waterShadow(vWorldUV) * 0.8);
      #endif
      finalEmissive = mix(waterCol, vec3(0.0), jacobian);
      #ifdef HAS_FLASH
        // Warm muzzle-flash glow on the sea — added on top (lights foam too) so a broadside
        // visibly illuminates the surrounding water.
        finalEmissive += _cannonFlashGlow(vWorldUV);
      #endif
    `);

    // Per-frame uniforms (camera pos, ping-ponged turbulence, time, light dir).
    mat.onBindObservable.add(() => {
      const eff = mat.getEffect();
      if (!eff) { return; }
      eff.setVector3('_WorldSpaceCameraPos', camera.position);
      // Re-bind ALL cascade textures every frame so a live grid-size change (Ultra toggle,
      // which rebuilds the generator) is picked up transparently.
      for (let c = 0; c < 3; c++) {
        const d = fft.getDisplacementTex(c); if (d) { eff.setTexture('_Displacement_c' + c, d as Texture); }
        const dv = fft.getDerivativesTex(c); if (dv) { eff.setTexture('_Derivatives_c' + c, dv as Texture); }
        const tb = fft.getTurbulenceTex(c); if (tb) { eff.setTexture('_Turbulence_c' + c, tb as Texture); }
      }
      eff.setFloat('_Time', this._deps.getTime() / 10);
      eff.setVector3('lightDirection', this._deps.getSunDir());
      // Keep the shore map live (terrain may restream as you sail).
      const shore = this._deps.getShore?.();
      if (shore) {
        eff.setTexture('_ShoreMap', shore.map as Texture);
        eff.setFloat2('_ShoreCenter', shore.center.x, shore.center.y);
        eff.setFloat('_ShoreSize', shore.size);
      }
      const wake = this._deps.getBoatWake?.();
      if (wake) { eff.setFloat2('_BoatPos', wake.x, wake.z); }
      const wp = this._deps.getWakePaths?.();
      if (wp) {
        eff.setArray4('_WakePaths', wp.paths as unknown as number[]);
        eff.setArray4('_WakeMeta', wp.meta as unknown as number[]);
        eff.setFloat('_WakeBoatCount', wp.count);
      }
      const splash = this._deps.getSplashData?.();
      if (splash) {
        eff.setArray4('_SplashData', splash.data as unknown as number[]);
        eff.setFloat('_SplashCount', splash.count);
      }
      const flash = this._deps.getCannonFlash?.();
      if (flash) {
        eff.setArray4('_FlashData', flash.data as unknown as number[]);
        eff.setFloat('_FlashCount', flash.count);
        eff.setFloat('_FlashLife', flash.life);
      }
      const sh = this._deps.getWaterShadow?.();
      if (sh) {
        eff.setTexture('_TerrainShadowMask', sh.map as Texture);
        eff.setFloat2('_TShadowCenter', sh.center.x, sh.center.y);
        eff.setFloat('_TShadowSize', sh.size);
        eff.setFloat('_TShadowStrength', sh.strength);
        eff.setFloat('_CloudCover', sh.cloud);
        eff.setVector3('_SunDir', this._deps.getSunDir());
        eff.setFloat2('_CloudDrift', sh.cloudDrift.x, sh.cloudDrift.y);
        eff.setFloat('_CloudCovThresh', sh.cloudCovThresh);
        eff.setFloat('_CloudBaseH', sh.cloudBase);
      }
      const boats = this._deps.getBoatShadows?.();
      if (boats) {
        eff.setArray4('_BoatShadowData', boats.data as unknown as number[]);
        eff.setFloat('_BoatShadowCount', boats.count);
      }
      const rain = this._deps.getRain?.();
      if (rain !== undefined && rain !== null) { eff.setFloat('_RainIntensity', rain); }
      const chop = this._deps.getChoppiness?.();
      if (chop !== undefined && chop !== null) { eff.setFloat('_Choppiness', chop); }
    });

    return mat;
  }

  dispose(): void {
    this._foamTexture.dispose();
  }

  /** Soft tiling foam mask (replaces the demo's external PNG). */
  private _makeFoamTexture(scene: Scene): Texture {
    const S = 256;
    const tex = new DynamicTexture('oceanFFTFoam', { width: S, height: S }, scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    // Scatter soft blobs of foam.
    for (let i = 0; i < 220; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 4 + Math.random() * 14;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.35 + Math.random() * 0.5;
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.update();
    return tex;
  }
}
