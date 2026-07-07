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
  /** Sun visibility 1=clear … 0=hidden behind terrain/cloud. Dims the reflected-sun glint streak. */
  getSunOcclusion?: () => number;
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
  /** Local boat interior cut for an open hull: on (>0.5), baked half-beam profile (96 stations packed
   *  as 24 vec4 = number[96]), its root-frame along range + centreline + bow sign, and floor world-Y. */
  getHullCut?: (() => {
    on: number; profile: number[]; alongMin: number; alongLen: number;
    acrossCenter: number; alongSign: number; waterY: number;
    sil: number[]; hMin: number; hMax: number; rootY: number; pitch: number; roll: number;
  }) | null;
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
  /** Live fish-startle vector (xy = recent cannon-shot pos, w = flee strength) — the drifting fish
   *  silhouettes scatter away from it. Null/undefined → no scatter. */
  getFishStartle?: (() => Vector4) | null;
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

    // Deep-water base colour (beauty pass 3, Phase C water look): richer tropical SAPPHIRE — blue lifted
    // (deeper, less muddy) with the teal undertone kept, a hair brighter overall so open water reads vivid
    // rather than near-black. (was 0.01113, 0.05637, 0.09869.) The sea is most of the screen, so this is the
    // single highest-impact knob; push B up / G down for more Pacific-blue, up G for more Caribbean-teal.
    const color = new Vector3(0.01200, 0.05850, 0.11700);

    mat.AddUniform('_Color', 'vec3', color);
    mat.AddUniform('_MaxGloss', 'float', 0.91);
    mat.AddUniform('_RoughnessScale', 'float', 0.0044);
    mat.AddUniform('_LOD_scale', 'float', 7.13);

    mat.AddUniform('_FoamColor', 'vec3', new Vector3(1, 1, 1));
    mat.AddUniform('_FoamScale', 'float', 2.78);   // whitecap contrast — nudged up (was 2.6) for slightly crisper, whiter caps
    mat.AddUniform('_ContactFoam', 'float', 0);   // contact foam kept off; the depth tex is used only for the hull-reveal cutoff
    mat.AddUniform('_FoamBiasLOD0', 'float', 0.895);   // caps form on moderate seas
    mat.AddUniform('_FoamBiasLOD1', 'float', 1.905);
    mat.AddUniform('_FoamBiasLOD2', 'float', 2.80);
    mat.AddUniform('_Choppiness', 'float', 0.3);   // sea state 0..1 — trims foam in heavy seas

    mat.AddUniform('_SSSColor', 'vec3', new Vector3(0.1541919, 0.8857628, 0.990566));
    mat.AddUniform('_SSSStrength', 'float', 0.255);   // back-lit turquoise wave-glow — up from 0.205 (the tropical signature: sun-through-the-crest)
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
    mat.AddUniform('_FishStartle', 'vec4', new Vector4(0, 0, 0, 0));   // xy = cannon-shot pos, w = flee strength
    mat.AddUniform('_CameraData', 'vec4', new Vector4(camera.minZ, camera.maxZ, camera.maxZ - camera.minZ, 0));
    mat.AddUniform('_FoamTexture', 'sampler2D', this._foamTexture);
    // NOTE: the scene depth map (_CameraDepthTexture) was removed — Metal caps a fragment stage at 16
    // samplers and the ocean was at the limit. Contact foam + the seabed reveal now both read the TRUE
    // seabed depth from the terrain heightfield (_TerrainHeightTex, below) via _seabedWaterDepth(), so
    // the depth map is no longer needed (it rendered the displaced clipmap flat anyway).
    // Depth-based transparency reach: how far (metres of through-water path) you can see down into the
    // water before it reads fully opaque. Drives the unified seabed/hull reveal (replaces the old
    // coastal-proximity ramp + boat oval). 10 m: bottom visible to ~10 m, broad shallow tint to ~22 m
    // (10 × 2.2), shoal band to ~35 m (10 × 3.5). Reads true vertical seabed depth from the heightfield;
    // higher values let you see deeper into the water so gentle shelves read as wider shallows.
    mat.AddUniform('_SeeDepth', 'float', 10.0);
    // Terrain heightfield (R32F metres, published by TerrainService via scene.metadata) — gives the
    // TRUE seabed depth per water fragment. The clipmap displaces in its vertex shader, which the
    // depth renderer can't see (it renders the seabed flat at y=0), so the depth-map dz reads all
    // water as shallow; sampling the heightfield directly fixes that. Placeholder until published.
    mat.AddUniform('_TerrainHeightTex', 'sampler2D', this._foamTexture);
    mat.AddUniform('_TerrainBounds', 'vec4', new Vector4(0, 0, 1, 1));   // minX, minZ, sizeX, sizeZ
    mat.AddUniform('_TerrainTexSize', 'vec2', new Vector2(1, 1));
    mat.AddUniform('_TerrainHasField', 'float', 0);
    // Sun visibility (1 clear → 0 hidden behind terrain/cloud). Declared unconditionally so the diagnostic
    // probe + reflected-glint dim can both use it regardless of the reflections toggle.
    mat.AddUniform('_SunOcclusion', 'float', 1.0);
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
      mat.AddUniform('_HullCutOn',      'float', 0);                       // >0.5 = local boat interior cut on
      mat.AddUniform('_HullCutProfile[24]', 'vec4', '');                   // 96 half-beam stations along the hull (NO sampler)
      mat.AddUniform('_HullCutMeta',    'vec4', new Vector4(0, 1, 0, 1));  // alongMin, alongLen, acrossCentre, alongSign
      mat.AddUniform('_HullCutWaterY',  'float', -1.0e9);                  // floor world-Y; sea above this (in hull) is cut
      // Height-aware silhouette for the DISCARD path (behind #define HULL_DISCARD): half-beam vs (along, height),
      // 48 along × 8 height = 384 floats = 96 vec4. _HullSilB = (hMin, hMax, NA, NH); _HullSilRootY = boat root world-Y.
      mat.AddUniform('_HullSil[96]',    'vec4', '');
      mat.AddUniform('_HullSilB',       'vec4', new Vector4(0, 1, 48, 8));
      mat.AddUniform('_HullSilRootY',   'float', -1.0e9);
      mat.AddUniform('_BoatTilt',       'vec2', new Vector2(0, 0));   // boat pitch (x, +bow-up) + roll (y, +stbd-down)
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
    // Height-aware interior DISCARD (SoT-style occlusion) instead of the surface carve. Opt-in + reversible:
    // localStorage.ignis_hullcut === 'discard' → use it; anything else keeps the carve. Only meaningful for a
    // boat that has the cut on (hasWake gates the boat uniforms). When set, the vertex carve is #ifndef'd out.
    const hullDiscardDef = (hasWake && typeof localStorage !== 'undefined' && localStorage.getItem('ignis_hullcut') === 'discard')
      ? '#define HULL_DISCARD' : '';
    // Raindrop ripples: one jittered drop per cell — a sharp central plip + an expanding ring
    // — whose gradient dimples the surface normal so the rain reads as impacts on the water.
    const rainFn = hasRain ? `
      // Wrap the cell coords into a small range BEFORE the sin: rp uses raw world XZ (±tens of
      // thousands), at which magnitude float32 sin(dot(...)*43758) loses all precision and collapses
      // to a few banded values — so every cell drew the SAME drop position, rate and phase (a uniform
      // grid all rippling in lockstep). mod 512 keeps the sin argument precise; the pattern repeats
      // every 512/2.2 ≈ 233 m, beyond the ~180 m rain radius, so the repeat is never visible.
      float _rvHash(vec2 p){ p = mod(p, 512.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
          sum += (crater + geyser + ring) * _SplashData[i].w;   // .w = per-impact strength (1 cannonball, small for dolphin/grape ripples)
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
          f = max(f, max(col, ring) * _SplashData[i].w);   // .w = per-impact strength (small splash → little foam)
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
        // Cannon startle: shove this fish away from a recent nearby shot (_FishStartle.xy = pos, .w = strength).
        vec2  sOff  = fishC - _FishStartle.xy;
        float sLen  = length(sOff) + 1e-4;
        float sFall = _FishStartle.w * (1.0 - smoothstep(0.0, 24.0, sLen));
        fishC += (sOff / sLen) * sFall * 8.0;
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

    // Height-aware interior DISCARD (SoT-style occlusion). Per pixel near the boat: recover the live ocean
    // surface (carried in vViewVector), take its height ON the hull relative to the boat's bob (surf.y −
    // _HullSilRootY), look up the hull's half-beam AT THAT HEIGHT from the 2-D silhouette (bilinear), and
    // discard the sea where it's inside the hull — so the exclusion outline rides up/down the flare with the
    // waves (a crest meets the hull wider, a trough narrower). Above the gunwale (u≥1) the hull has no width
    // → no discard → a tall wave genuinely washes over the rail. The OPEN SEA is never touched (no carve).
    const hullDiscardFn = hullDiscardDef ? `
      float _silAt(int a, int h) {
        int idx = a * int(_HullSilB.w) + h;
        vec4 v = _HullSil[idx / 4];
        int c = idx - (idx / 4) * 4;
        return c == 0 ? v.x : (c == 1 ? v.y : (c == 2 ? v.z : v.w));
      }
      void _hullDiscard() {
        if (_HullCutOn < 0.5) return;
        vec3 surf = _WorldSpaceCameraPos - vViewVector;          // displaced ocean surface (world)
        // Footprint test uses the BASE (undisplaced) mesh XZ, not the displaced surf.xz: on a big swell the FFT's
        // horizontal choppy displacement folds the surrounding crest's water INTO the hull footprint, so using the
        // displaced position cut that crest — and with the boat sitting below it, the hole showed the tan
        // background (the "tear around the boat"). The base XZ asks the stable question "is this sea UNDER the
        // boat's footprint", while surf.y (below) still gives the true wave height for the dry/wet decision.
        vec2 rel = vWorldUV - _BoatPos;
        if (dot(rel, rel) > 900.0) return;                       // >30 m from the boat — nothing to mask
        vec2 hf = normalize(_BoatDir + vec2(1e-5, 0.0));
        vec2 hr = vec2(hf.y, -hf.x);
        float along   = dot(rel, hf) * _HullCutMeta.w;           // signed along (root +Z, bow)
        float acrossS = dot(rel, hr) - _HullCutMeta.z;           // signed across (root +X, +stbd)
        float across  = abs(acrossS);
        float tt = (along - _HullCutMeta.x) / _HullCutMeta.y;
        if (tt <= 0.0 || tt >= 1.0) return;
        // The water's height ON THE HULL at this point, corrected for the boat's TILT: a bow-up pitch raises the
        // hull at +along, a stbd-down roll lowers it at +across — so a HEELED hull's waterline is read where it
        // actually is, not at a flat level. That mismatch was leaving slivers along the low side as it bobbed/heeled.
        float localH = (surf.y - _HullSilRootY) - _BoatTilt.x * along + _BoatTilt.y * acrossS;
        float floorLocalY = _HullCutWaterY - _HullSilRootY;
        if (localH < floorLocalY) return;                        // below the cockpit floor → hull/floor occludes it (don't cut a hole to the background)
        // Keep masking the cockpit WELL above the gunwale so it stays dry even when a swell tops the low side
        // walls (the boat dropping into a trough as a wave rises over it) — the width is capped at the wall, so
        // this can't re-slice a wave OUTSIDE the hull. Only a wave ~1.5 m over the hull top (full submersion /
        // sinking) stops the cut, so you then see the boat genuinely awash rather than a dry hole in the sea.
        if (localH > _HullSilB.y + 1.5) return;
        // Width follows the inner hull at the water's height, capped a little above the floor: at the floor-meets-
        // hull edge that closes the "ribbon", while the cap (below the gunwale FLARE) stops a tall wave NEXT TO the
        // boat from being sliced (the far-side gap). The 0.30 cap is the dial.
        float u = clamp((min(localH, floorLocalY + 0.30) - _HullSilB.x) / (_HullSilB.y - _HullSilB.x), 0.0, 0.999);
        float NA = _HullSilB.z, NH = _HullSilB.w;
        float fa = tt * NA - 0.5, fh = u * NH - 0.5;
        int a0 = int(clamp(floor(fa), 0.0, NA - 1.0)), a1 = int(min(float(a0) + 1.0, NA - 1.0));
        int h0 = int(clamp(floor(fh), 0.0, NH - 1.0)), h1 = int(min(float(h0) + 1.0, NH - 1.0));
        float wa = clamp(fa - floor(fa), 0.0, 1.0), wh = clamp(fh - floor(fh), 0.0, 1.0);
        float w = mix(mix(_silAt(a0, h0), _silAt(a1, h0), wa), mix(_silAt(a0, h1), _silAt(a1, h1), wa), wh);
        if (across < w) discard;
      }
    ` : '';

    const allDefs = `${defines.join('\n')}\n${depthDef}\n${reflDef}\n${shoreDef}\n${refrDef}\n${wakeDef}\n${splashDef}\n${flashDef}\n${shadowDef}\n${boatShadowDef}\n${rainDef}\n${hullDiscardDef}`;
    mat.Vertex_Definitions(`${allDefs}\n${varyings}\n${shoreFn}\n${wakeFn}\n${splashFn}`);
    mat.Fragment_Definitions(`${allDefs}\n${varyings}\n${seabedFn}\n${shoreFn}\n${fishFn}\n${wakeFn}\n${splashFn}\n${flashFn}\n${shadowFn}\n${rainFn}\n${hullDiscardFn}`);

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
       #ifndef HULL_DISCARD
        // ── SURFACE-CARVE path (default). HULL_DISCARD (the height-aware fragment occlusion) replaces all of
        // this when enabled; there the open sea is left completely untouched and the interior is masked per-pixel.
        // Hull water displacement: instead of cutting a hole in the sea, DEPRESS the surface under
        // the hull to just below the floor and flatten its chop, so the boat sits in its own hollow.
        // The sea still renders everywhere (no see-through), can never rise into the cockpit (it's
        // forced below the floor regardless of wave height), and laps the hull normally outside — the
        // hull's planking hides the lip of the depression. The footprint is the baked beam profile
        // (inset toward the waterline) oriented to the boat; sinkY rides the bob via _HullCutWaterY.
        // Hull interior cut: compute the footprint (fp) + the thin edge feather HERE, but APPLY the vertical
        // cut LAST — after the wake + splash below — otherwise the bow-wave crest / cannon splash get added on
        // top of the cut and lift the interior water back above the floor (the in-cockpit flooding). fp/sinkY
        // are hoisted to main scope so the final clamp (after HAS_SPLASH) can reach them.
        float fp = 0.0;
        float sinkY = -1.0e9;
        if (_HullCutOn > 0.5) {
          vec2  hf = normalize(_BoatDir + vec2(1e-5, 0.0));
          vec2  hr = vec2(hf.y, -hf.x);
          vec2  rel = vWorldUV - _BoatPos;
          float along  = dot(rel, hf) * _HullCutMeta.w;     // root-local +Z
          float across = dot(rel, hr) - _HullCutMeta.z;     // root-local +X off the centreline
          float t = (along - _HullCutMeta.x) / _HullCutMeta.y;
          float edgeCalm = 1.0;
          if (t > 0.0 && t < 1.0) {
            int bi = int(clamp(floor(t * 96.0), 0.0, 95.0));
            vec4 pv = _HullCutProfile[bi / 4];
            int pc = bi - (bi / 4) * 4;
            float halfBeam = (pc == 0 ? pv.x : (pc == 1 ? pv.y : (pc == 2 ? pv.z : pv.w))) * 1.0;
            float ends = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.96, 1.0, t));
            fp = (1.0 - smoothstep(halfBeam + 0.10, halfBeam + 0.42, abs(across))) * ends;
            // Thin HULL-CONFORMING feather: ease the swell down in a narrow band just OUTSIDE the contour so a
            // crest can't tower over the low rail and slop aboard — only ~1.2 m wide and hull-shaped, never the
            // old wide radial trough. Full waves beyond the band.
            float dOut = abs(across) - halfBeam;                          // >0 = outside the hull outline
            float band = 1.0 - smoothstep(0.0, 1.2, max(dOut, 0.0));      // 1 at the planking → 0 by 1.2 m out
            edgeCalm = 1.0 - 0.45 * band * ends;                          // down to 0.55× wave height at the hull
          }
          displacement *= edgeCalm;
          sinkY = _HullCutWaterY - 0.38;                    // hold the interior just below the floor (dry)
          displacement.x *= (1.0 - fp);                     // flatten interior chop (the y-cut runs last)
          displacement.z *= (1.0 - fp);
        }
       #endif

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

      #ifdef HAS_WAKE
       #ifndef HULL_DISCARD
        // FINAL hull interior cut (carve path only) — applied AFTER the wake bow-wave crest AND the cannon splash,
        // so neither can raise the cut water back above the floor and flood the cockpit. CAP-don't-PIN: force the
        // interior down to sinkY (below the floor → dry) but never ABOVE the real swell, so it neither floods nor
        // juts up as a shelf when the surrounding sea falls into a trough. (fp is 0 outside the hull → sea untouched.)
        if (fp > 0.0) {
          displacement.y = mix(displacement.y, min(worldPos.y + displacement.y, sinkY) - worldPos.y, fp);
        }
       #endif
      #endif

      worldPos.xyz += displacement;

      #ifdef HULL_DISCARD
        // Carry the DISPLACED surface position to the fragment (no spare varying budget for a new one): the
        // height-aware discard recovers the live wave height there via surfPos = _WorldSpaceCameraPos - vViewVector.
        vViewVector = _WorldSpaceCameraPos - worldPos.xyz;
      #endif

      vLodScales = vec4(lod_c0, lod_c1, lod_c2, max(displacement.y - largeWavesBias * 0.8 - _SSSBase, 0.) / _SSSScale);
    `);

    mat.Vertex_MainEnd(`
      vClipCoords = gl_Position;
    `);

    mat.Fragment_Before_Lights(`
      #ifdef HULL_DISCARD
        _hullDiscard();   // height-aware interior occlusion — mask the sea inside the hull at the live waterline
      #endif
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
        // Sun-glint occlusion. The reflected view ray tells us which pixels mirror the sky toward the
        // sun; where that aligns with the sun AND the sun is hidden behind terrain/cloud, kill the bright
        // reflected-sun streak (the planar RTT still shows the sun's sky-glow because the reflected
        // mountain doesn't occlude it). No-op when the sun is visible (_SunOcclusion = 1 ⇒ streakDim = 1).
        vec3  reflRay   = reflect(-viewDir, normalW);
        float sunAlign  = max(0.0, dot(reflRay, lightDirection));
        float streakDim = mix(1.0, _SunOcclusion, smoothstep(0.55, 0.96, sunAlign));
        waterCol += planarRefl * fresnel * _ReflStrength * reflCut * streakDim;
        // Analytic sky fallback — fades in as the planar reflection fades out (reflections off / RTT
        // dead) so the water still catches sky light at grazing angles instead of reading flat-dark.
        waterCol += _SkyColor * fresnel * (1.0 - _ReflStrength) * reflCut * streakDim;
      #endif
      #ifdef HAS_SHADOWS
        waterCol *= (1.0 - _waterShadow(vWorldUV) * 0.8);
      #endif
      #ifdef HAS_REFRACTION
        // Faint hull hint in DEEP water. The reveal above only fires in the shallows (it keys on seabed
        // depth), so over open water the surface fully hides submerged hulls. Blend the water toward
        // min(water, refraction) in a small disc around each boat: the refraction RTT contains the
        // hulls, and min() only ever DARKENS — so a dark submerged hull shows through a little while the
        // surrounding open water (brighter refraction) is left untouched, with no boat-shaped halo.
        // Applied AFTER reflection so the glint doesn't wash it out; distFade keeps it near the camera.
        // KNOBS: 6/14 = disc inner/outer radius (m), 0.6 = how strongly the hull shows.
        float hullHint = 0.0;
        #ifdef HAS_BOATSHADOWS
          // Every boat (local is index 0, remotes follow) — _BoatShadowData[i].xy is its world x,z.
          for (int hbi = 0; hbi < 8; hbi++) {
            if (float(hbi) >= _BoatShadowCount) break;
            float hd = length(vWorldUV - _BoatShadowData[hbi].xy);
            hullHint = max(hullHint, 1.0 - smoothstep(6.0, 14.0, hd));
          }
        #else
          // Fallback when boat shadows are off: local boat only, hull-oriented ellipse via _BoatPos/Dir.
          vec2  hf = normalize(_BoatDir + vec2(1e-5, 0.0));
          vec2  hr = vec2(hf.y, -hf.x);
          vec2  hb = vWorldUV - _BoatPos;
          hullHint = 1.0 - smoothstep(0.5, 1.0, length(vec2(dot(hb, hf) / 12.0, dot(hb, hr) / 4.0)));
        #endif
        hullHint *= distFade * (1.0 - reveal);
        waterCol = mix(waterCol, min(waterCol, refr), hullHint * 0.6);
      #endif
      finalEmissive = mix(waterCol, vec3(0.0), jacobian);
      #ifdef HAS_FLASH
        // Warm muzzle-flash glow on the sea — added on top (lights foam too) so a broadside
        // visibly illuminates the surrounding water.
        finalEmissive += _cannonFlashGlow(vWorldUV);
      #endif
      // ── Sun-glint occlusion (THE fix) ─────────────────────────────────────────────────────────────────
      // The reflected-sun STREAK is the PBR environment RADIANCE (the IBL reflection of the bright sunset
      // sun) plus the direct specular. Both are computed by the PBR core just above and summed into finalColor
      // next — and the flat-green probe proved zeroing this material's output kills the streak. So knock these
      // two mirror terms straight down by sun visibility: _SunOcclusion = 1 (sun visible) → unchanged;
      // _SunOcclusion → 0 (hidden behind terrain/cloud) → the glint vanishes. No brightness threshold, no
      // directional cone (both of which silently missed) — this dims the exact terms that ARE the streak. The
      // manual planar reflection (in finalEmissive/waterCol) is untouched, so the water keeps its sky sheen.
      #ifdef REFLECTION
        finalRadianceScaled *= _SunOcclusion;
      #endif
      #ifdef SPECULARTERM
        finalSpecularScaled *= _SunOcclusion;
      #endif
    `);

    // Sun-glint occlusion — the REAL fix, applied at the last stage where finalColor holds the fully-composed
    // pixel (the black-probe test proved this point controls the streak). The streak is the PBR environment
    // RADIANCE (IBL reflection of the bright sunset sky/sun) — a term neither the manual reflection dim nor the
    // sun.specular dim touched. Here we knock it down ONLY where the surface mirrors the sun (reflected view ray
    // aligns with lightDirection) AND the sun is occluded (_SunOcclusion → 0). No-op when the sun is visible.
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
      eff.setFloat('_SunOcclusion', this._deps.getSunOcclusion?.() ?? 1.0);
      const fishStartle = this._deps.getFishStartle?.();
      if (fishStartle) { eff.setVector4('_FishStartle', fishStartle); }
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
      const hc = this._deps.getHullCut?.();
      if (hc) {
        eff.setFloat('_HullCutOn', hc.on);
        eff.setFloat('_HullCutWaterY', hc.waterY);
        eff.setArray4('_HullCutProfile', hc.profile);
        eff.setFloat4('_HullCutMeta', hc.alongMin, hc.alongLen, hc.acrossCenter, hc.alongSign);
        // Height-aware silhouette + bob reference (used only when the shader is built with HULL_DISCARD).
        eff.setArray4('_HullSil', hc.sil);
        eff.setFloat4('_HullSilB', hc.hMin, hc.hMax, 48, 8);
        eff.setFloat('_HullSilRootY', hc.rootY);
        eff.setFloat2('_BoatTilt', hc.pitch, hc.roll);
      }
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
