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
  /** Live sky-reflection state: the colour the water reflects when the planar reflection is off, and
   *  the planar reflection strength (0 → reflections off → analytic sky only, no flat-dark water). */
  getSkyReflect?: (() => { color: Vector3; strength: number }) | null;
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
    mat.AddUniform('_ContactFoam', 'float', 0);   // contact foam kept off; the depth tex is used only for the hull-reveal cutoff
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
    // NOTE: the scene depth map (_CameraDepthTexture) was removed — Metal caps a fragment stage at 16
    // samplers and the ocean was at the limit. Contact foam + the seabed reveal now both read the TRUE
    // seabed depth from the terrain heightfield (_TerrainHeightTex, below) via _seabedWaterDepth(), so
    // the depth map is no longer needed (it rendered the displaced clipmap flat anyway).
    // Depth-based transparency reach: how far (metres of through-water path) you can see down into the
    // water before it reads fully opaque. Drives the unified seabed/hull reveal (replaces the old
    // coastal-proximity ramp + boat oval). ~8 m ≈ 26 ft of visibility.
    mat.AddUniform('_SeeDepth', 'float', 8.0);
    // Terrain heightfield (R32F metres, published by TerrainService via scene.metadata) — gives the
    // TRUE seabed depth per water fragment. The clipmap displaces in its vertex shader, which the
    // depth renderer can't see (it renders the seabed flat at y=0), so the depth-map dz reads all
    // water as shallow; sampling the heightfield directly fixes that. Placeholder until published.
    mat.AddUniform('_TerrainHeightTex', 'sampler2D', this._foamTexture);
    mat.AddUniform('_TerrainBounds', 'vec4', new Vector4(0, 0, 1, 1));   // minX, minZ, sizeX, sizeZ
    mat.AddUniform('_TerrainTexSize', 'vec2', new Vector2(1, 1));
    mat.AddUniform('_TerrainHasField', 'float', 0);
    if (this._deps.reflectionTexture) {
      mat.AddUniform('_Reflection', 'sampler2D', this._deps.reflectionTexture);
      mat.AddUniform('_ReflStrength', 'float', 0.9);
      // Colour the water reflects when the planar reflection is off (reflections toggled off / the
      // mirror RTT stops rendering). Driven per-frame from the sky/fog hue so it stays day-night aware.
      mat.AddUniform('_SkyColor', 'vec3', new Vector3(0.45, 0.62, 0.82));
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
      mat.AddUniform('_BoatDir', 'vec2', new Vector2(0, 1));   // local boat heading (for the hull-shaped hull-reveal ellipse)
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

    // TRUE vertical water depth (metres, ≥0) at a world XZ, read straight from the terrain heightfield
    // — the single source of seabed depth for BOTH contact foam and the see-into-water reveal, now that
    // the scene depth map is gone (Metal's 16-sampler cap). Returns 1e4 (= deep/opaque, no foam) when
    // there's no field or the point is outside it. R32F isn't HW-filterable on WebGPU → manual bilinear.
    const seabedFn = `
      float _seabedWaterDepth(vec2 worldXZ) {
        if (_TerrainHasField <= 0.5) return 1.0e4;
        vec2 sUV = vec2((worldXZ.x - _TerrainBounds.x) / _TerrainBounds.z,
                        (_TerrainBounds.y + _TerrainBounds.w - worldXZ.y) / _TerrainBounds.w);
        if (sUV.x < 0.0 || sUV.x > 1.0 || sUV.y < 0.0 || sUV.y > 1.0) return 1.0e4;
        vec2 stc = sUV * _TerrainTexSize - 0.5; vec2 sf = fract(stc);
        ivec2 si = ivec2(floor(stc)); ivec2 smx = ivec2(_TerrainTexSize) - 1;
        float b00 = texelFetch(_TerrainHeightTex, clamp(si,            ivec2(0), smx), 0).r;
        float b10 = texelFetch(_TerrainHeightTex, clamp(si+ivec2(1,0), ivec2(0), smx), 0).r;
        float b01 = texelFetch(_TerrainHeightTex, clamp(si+ivec2(0,1), ivec2(0), smx), 0).r;
        float b11 = texelFetch(_TerrainHeightTex, clamp(si+ivec2(1,1), ivec2(0), smx), 0).r;
        float seabedY = mix(mix(b00, b10, sf.x), mix(b01, b11, sf.x), sf.y);
        return max(0.0, -seabedY);
      }
    `;

    const allDefs = `${defines.join('\n')}\n${depthDef}\n${reflDef}\n${shoreDef}\n${refrDef}\n${wakeDef}\n${splashDef}\n${flashDef}\n${shadowDef}\n${boatShadowDef}\n${rainDef}`;
    mat.Vertex_Definitions(`${allDefs}\n${varyings}\n${shoreFn}\n${wakeFn}\n${splashFn}`);
    mat.Fragment_Definitions(`${allDefs}\n${varyings}\n${seabedFn}\n${shoreFn}\n${fishFn}\n${wakeFn}\n${splashFn}\n${flashFn}\n${shadowFn}\n${rainFn}`);

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

      // Contact foam where the water shoals against the shore, from the true seabed depth (the scene
      // depth map is gone). Small depthDifference means foam; 1e4 (open ocean) means none. Off with no field.
      {
        float depthDifference = max(0.0, _seabedWaterDepth(vWorldUV) - 0.5);
        float foam = texture2D(_FoamTexture, vWorldUV * 0.5 + _Time * 2.).r;
        jacobian += _ContactFoam * saturate(max(0.0, foam - depthDifference) * 5.0) * 0.9;
      }

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

      // ── Depth-based transparency ─────────────────────────────────────────────────
      // One unified rule, now that the seabed is real geometry: you can see ~_SeeDepth metres DOWN
      // into the water everywhere. reveal (0 = opaque deep water -> 1 = bottom fully visible) is
      // driven purely by how close the opaque geometry behind the surface is — the real seabed in the
      // shallows OR the hull right by the boat — so it replaces BOTH the old coastal-proximity
      // transparency ramp AND the boat-shaped reveal oval with a single physical depth fade.
      float reveal = 0.0;
      float shallow = 0.0;   // broad shallow-water factor (1 in the shallows → 0 in deep water);
                             // suppresses the blue water terms (sky reflection, shoal tint) over sand
      #ifdef HAS_REFRACTION
        // TRUE vertical water depth from the heightfield (the clipmap displaces in its vertex shader,
        // which a depth renderer can't see — it'd render the seabed flat and read ALL water as shallow).
        float dz = _seabedWaterDepth(vWorldUV);                   // vertical water depth in metres (1e4 is open ocean)
        // Visibility falls off with VIEW distance too (scattering/haze through the water column), so
        // far water always reads opaque — this also kills false reveals at the grazing horizon where
        // the background depth gets unreliable. Full reach up close, gone by ~400 m.
        float distFade = 1.0 - smoothstep(150.0, 400.0, vClipCoords.w);
        reveal = (1.0 - smoothstep(0.0, _SeeDepth, dz)) * distFade;
        shallow = (1.0 - smoothstep(0.0, _SeeDepth * 2.2, dz)) * distFade;   // wider than the crisp reveal
        vec2 refrUV = clamp(vClipCoords.xy / vClipCoords.w * 0.5 + 0.5 + normalW.xz * 0.02, vec2(0.002), vec2(0.998));
        vec3 refr = texture2D(_Refraction, refrUV).rgb;
        // NOTE: the reveal is now driven purely by the TRUE seabed depth (dz). The old refraction-
        // brightness gate is gone: it killed the reveal wherever the refraction was dark, so the boat
        // (hull, mast and rigging, all dark in the refraction RTT) punched the deep-water BLUE through
        // the shallows in a boat-shaped ghost. With true depth we just trust dz, so the boat now reads
        // as its dark refraction (a natural shadow over the tan sand).
        // Revealed seabed is emissive (the refraction clear-colour doesn't darken with the scene),
        // so day-gate it (sunUp) to fade the bottom to dark at night.
        vec3 seabedSand = refr * vec3(0.62, 0.62, 0.55) * (0.08 + 0.92 * sunUp);
        waterCol = mix(waterCol, seabedSand, reveal * 0.9);

        // Shoal water-column tint: a turquoise ring in the band just BEYOND the clear-view depth
        // (deep enough that the bottom has faded out, so it never tints the visible sand — that was
        // reading as a blue glow over the shadowed shallows). Gated past the reveal, sun-gated.
        float shoal = smoothstep(_SeeDepth, _SeeDepth * 1.8, dz)
                    * (1.0 - smoothstep(_SeeDepth * 1.8, _SeeDepth * 3.5, dz)) * distFade * (1.0 - reveal);
        waterCol = mix(waterCol, vec3(0.10, 0.48, 0.50) * (1.0 - fresnel), shoal * 0.10 * sunUp);

        // Drifting fish across the shallows — dark shapes in the water column, visible through the
        // whole shoal band (not just where the sand is crisply revealed). Camera above water only.
        if (_WorldSpaceCameraPos.y > 0.05) {
          float shallowsVis = (1.0 - smoothstep(0.0, _SeeDepth * 2.2, dz)) * distFade;
          float fish = fishField(vWorldUV, _Time * 10.0);
          waterCol *= 1.0 - fish * 0.35 * shallowsVis * sunUp;
        }
      #endif
      #ifdef HAS_REFLECTION
        // Planar mirror reflection (skybox + islands + vessels), rippled by the wave normal,
        // strongest at grazing angles (Fresnel). Sampled in screen space.
        vec2 reflUV = vClipCoords.xy / vClipCoords.w * 0.5 + 0.5;
        reflUV += normalW.xz * 0.04;
        reflUV = clamp(reflUV, vec2(0.002), vec2(0.998));
        vec3 planarRefl = texture2D(_Reflection, reflUV).rgb;
        // Kill the surface glint ENTIRELY across the shallows (not just dim it): transparent shallow
        // water reads as wet sand, never mirroring the sky. The old 0.9 factor left ~10% of bright
        // sky-blue, which traced a blue halo around the boat (the planar reflection of its silhouette
        // peeking out in screen space). Over-drive the cut so it hits 0 once the water is clearly
        // shallow, while open/deep water (reveal=shallow=0) keeps full reflection.
        float reflCut = clamp(1.0 - max(reveal, shallow) * 1.6, 0.0, 1.0);
        waterCol += planarRefl * fresnel * _ReflStrength * reflCut;
        // Analytic sky fallback — fades in as the planar reflection fades out (reflections off / RTT
        // dead) so the water still catches sky light at grazing angles instead of reading flat-dark.
        waterCol += _SkyColor * fresnel * (1.0 - _ReflStrength) * reflCut;
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
      // Sky reflection state — colour the water reflects + planar strength (0 when reflections off).
      const sky = this._deps.getSkyReflect?.();
      if (sky) { eff.setVector3('_SkyColor', sky.color); eff.setFloat('_ReflStrength', sky.strength); }
      // Terrain heightfield for the TRUE seabed depth (published by TerrainService via scene.metadata).
      const thf = (scene.metadata as { terrainHeightField?: {
        tex: Texture; bounds: Vector4; texSize: Vector2; maxAlt: number } } | null)?.terrainHeightField;
      if (thf && thf.tex?.isReady()) {
        eff.setTexture('_TerrainHeightTex', thf.tex);
        eff.setVector4('_TerrainBounds', thf.bounds);
        eff.setVector2('_TerrainTexSize', thf.texSize);
        eff.setFloat('_TerrainHasField', 1);
      } else {
        eff.setTexture('_TerrainHeightTex', this._foamTexture);   // placeholder (not sampled)
        eff.setFloat('_TerrainHasField', 0);
      }
      // Keep the shore map live (terrain may restream as you sail).
      const shore = this._deps.getShore?.();
      if (shore) {
        eff.setTexture('_ShoreMap', shore.map as Texture);
        eff.setFloat2('_ShoreCenter', shore.center.x, shore.center.y);
        eff.setFloat('_ShoreSize', shore.size);
      }
      const wake = this._deps.getBoatWake?.();
      if (wake) { eff.setFloat2('_BoatPos', wake.x, wake.z); eff.setFloat2('_BoatDir', wake.dirX, wake.dirZ); }
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
