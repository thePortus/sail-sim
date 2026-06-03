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
  /** The CPU wake track (vec4×24: x,z,age,_) + count — gives the wake its curved trail. */
  getWakePath: (() => { data: Float32Array; count: number }) | null;
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
    mat.AddUniform('_FoamScale', 'float', 2.4);
    mat.AddUniform('_ContactFoam', 'float', this._deps.depthTexture ? 1 : 0);
    mat.AddUniform('_FoamBiasLOD0', 'float', 0.84);
    mat.AddUniform('_FoamBiasLOD1', 'float', 1.83);
    mat.AddUniform('_FoamBiasLOD2', 'float', 2.72);

    mat.AddUniform('_SSSColor', 'vec3', new Vector3(0.1541919, 0.8857628, 0.990566));
    mat.AddUniform('_SSSStrength', 'float', 0.15);
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
    const hasWake = !!(this._deps.getBoatWake && this._deps.getWakePath);
    if (hasWake) {
      mat.AddUniform('_BoatPos', 'vec2', new Vector2(0, 0));
      mat.AddUniform('_BoatSpeed', 'float', 0);
      mat.AddUniform('_WakePath[24]', 'vec4', '');   // x, z, age, _ — set per frame via setArray4
      mat.AddUniform('_WakeCount', 'float', '');
    }

    const defines: string[] = [];
    if (useMid) { defines.push('#define MID'); }
    if (useClose) { defines.push('#define CLOSE'); }
    const depthDef = this._deps.depthTexture ? '#define HAS_DEPTH' : '';
    const reflDef = this._deps.reflectionTexture ? '#define HAS_REFLECTION' : '';
    const shoreDef = shore0 ? '#define HAS_SHORE' : '';
    const refrDef = hasRefraction ? '#define HAS_REFRACTION' : '';
    const wakeDef = hasWake ? '#define HAS_WAKE' : '';
    // Wake along the boat's actual (curved) CPU track: find the nearest point on the path
    // polyline, then build a turbulent core + a pair of diverging bow-wave edges that spread
    // as the wake ages. Following the track means the wake bends through turns. Returns
    // (core, edge); both fade with the track point's age.
    const wakeFn = hasWake ? `
      vec2 _wakeCV(vec2 wxz) {
        if (_WakeCount < 2.0) return vec2(0.0);
        if (dot(wxz - _BoatPos, wxz - _BoatPos) > 45000.0) return vec2(0.0);   // ~210 m cull
        float bestD = 1.0e9;
        float bestAge = 0.0;
        for (int i = 0; i < 23; i++) {
          if (float(i) >= _WakeCount - 1.0) break;
          vec2 a = _WakePath[i].xy;          // (x, z)
          vec2 b = _WakePath[i + 1].xy;
          vec2 ab = b - a;
          float L2 = max(dot(ab, ab), 1.0e-3);
          float t = clamp(dot(wxz - a, ab) / L2, 0.0, 1.0);
          float d = length(wxz - (a + ab * t));
          if (d < bestD) { bestD = d; bestAge = mix(_WakePath[i].z, _WakePath[i + 1].z, t); }
        }
        float ageFade = 1.0 - smoothstep(0.0, 7.0, bestAge);
        if (ageFade <= 0.001) return vec2(0.0);
        // The wake spreads as it ages → diverging V that follows the curved track.
        float width = 1.6 + bestAge * 1.5 + min(6.0, _BoatSpeed * 0.30);
        float coreW = max(1.5, width * 0.40);
        float core = exp(-(bestD * bestD) / (coreW * coreW)) * ageFade;
        float edge = exp(-((bestD - width) * (bestD - width)) / 5.0) * ageFade;
        return vec2(core, edge);
      }
    ` : '';
    // Shared shore-proximity helper (R = land elevation; ~0.75 = waterline). 0 outside the map.
    const shoreFn = shore0 ? `
      float _shoreProx(vec2 wxz) {
        vec2 uv = (wxz - _ShoreCenter) / _ShoreSize + 0.5;
        if (uv.x < 0.001 || uv.x > 0.999 || uv.y < 0.001 || uv.y > 0.999) return 0.0;
        return texture2D(_ShoreMap, uv).r;
      }
    ` : '';
    // Drifting fish silhouettes on the seabed (ported from the procedural ocean): one fish
    // per ~12 m cell wandering a Lissajous path, body aligned to its heading.
    const fishFn = hasRefraction ? `
      float fishHash(vec2 id) { return fract(sin(dot(id, vec2(41.3, 289.1))) * 43758.5453); }
      float fishField(vec2 p, float t) {
        float scale = 0.085;
        vec2  id  = floor(p * scale);
        float rnd = fishHash(id);
        if (rnd <= 0.76) return 0.0;
        float szr = fishHash(id + 31.7);
        float ph  = rnd * 53.0;
        float sp1 = 0.30 + rnd * 0.55;
        float sp2 = 0.40 + fract(rnd * 7.3) * 0.60;
        vec2  cellC = (id + 0.5) / scale;
        vec2  fishC = cellC + vec2(sin(t * sp1 + ph), sin(t * sp2 + ph * 1.7)) * 4.5;
        vec2  vel   = vec2(sp1 * cos(t * sp1 + ph), sp2 * cos(t * sp2 + ph * 1.7));
        vec2  fwd   = normalize(vel + vec2(1e-4, 0.0));
        vec2  rel   = p - fishC;
        vec2  local = vec2(dot(rel, fwd), dot(rel, vec2(-fwd.y, fwd.x)));
        local /= (0.5 + szr * 0.7);
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

    const allDefs = `${defines.join('\n')}\n${depthDef}\n${reflDef}\n${shoreDef}\n${refrDef}\n${wakeDef}`;
    mat.Vertex_Definitions(`${allDefs}\n${varyings}\n${shoreFn}\n${wakeFn}`);
    mat.Fragment_Definitions(`${allDefs}\n${varyings}\n${shoreFn}\n${fishFn}\n${wakeFn}`);

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
        // Wake riding on the swell: flatten the FFT chop in the churned core (the boat
        // smooths the water), carve a trough there, and raise the diverging bow-wave crests.
        vec2 wcv = _wakeCV(vWorldUV);
        displacement *= (1.0 - 0.65 * wcv.x);
        displacement.y += -0.80 * wcv.x + 0.70 * wcv.y;
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

      #if defined(CLOSE)
        float jacobian = texture2D(_Turbulence_c0, uv0).x + texture2D(_Turbulence_c1, uv1).x + texture2D(_Turbulence_c2, uv2).x;
        jacobian = min(1.0, max(0.0, (-jacobian + _FoamBiasLOD2) * _FoamScale));
      #elif defined(MID)
        float jacobian = texture2D(_Turbulence_c0, uv0).x + texture2D(_Turbulence_c1, uv1).x;
        jacobian = min(1.0, max(0.0, (-jacobian + _FoamBiasLOD1) * _FoamScale));
      #else
        float jacobian = texture2D(_Turbulence_c0, uv0).x;
        jacobian = min(1.0, max(0.0, (-jacobian + _FoamBiasLOD0) * _FoamScale));
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

      #ifdef HAS_SHORE
        // Breaking-wave surf hugging the waterline — but broken up by two scrolling foam
        // samples so it reads as textured foam, not a flat white band, and kept subtle.
        float proxF = _shoreProx(vWorldUV);
        float surfBand = smoothstep(0.60, 0.71, proxF) * (1.0 - smoothstep(0.73, 0.85, proxF));
        float fA = texture2D(_FoamTexture, vWorldUV * 0.06 + _Time * 0.6).r;
        float fB = texture2D(_FoamTexture, vWorldUV * 0.13 - _Time * 0.4).r;
        float surf = surfBand * smoothstep(0.45, 0.95, fA * 0.6 + fB * 0.6);
        jacobian = max(jacobian, surf * 0.45);
      #endif

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

      surfaceAlbedo = mix(vec3(0.0), _FoamColor, jacobian);

      vec3 viewDir = normalize(vViewVector);
      vec3 H = normalize(-normalW + lightDirection);
      float ViewDotH = pow5(saturate(dot(viewDir, -H))) * 30.0 * _SSSStrength;
      vec3 color = mix(_Color, saturate(_Color + _SSSColor.rgb * ViewDotH * vLodScales.w), vLodScales.z);

      float fresnel = dot(normalW, viewDir);
      fresnel = saturate(1.0 - fresnel);
      fresnel = pow5(fresnel);
    `);

    mat.Fragment_Custom_MetallicRoughness(`
      float distanceGloss = mix(1.0 - metallicRoughness.g, _MaxGloss, 1.0 / (1.0 + length(vViewVector) * _RoughnessScale));
      metallicRoughness.g = 1.0 - mix(distanceGloss, 0.0, jacobian);
    `);

    mat.Fragment_Before_FinalColorComposition(`
      vec3 waterCol = color * (1.0 - fresnel);
      #ifdef HAS_SHORE
        float prox = _shoreProx(vWorldUV);
        // Shallow turquoise water-column tint as the seabed rises toward the beach.
        float shallowF = smoothstep(0.42, 0.70, prox);
        waterCol = mix(waterCol, vec3(0.10, 0.48, 0.50) * (1.0 - fresnel), shallowF * 0.55);
        #ifdef HAS_REFRACTION
          // True transparency: blend in the seabed colour (scene-minus-ocean RTT), revealed
          // more as the water shallows. Refracted slightly by the wave normal.
          float reveal = smoothstep(0.50, 0.78, prox);
          vec2 refrUV = clamp(vClipCoords.xy / vClipCoords.w * 0.5 + 0.5 + normalW.xz * 0.02, vec2(0.002), vec2(0.998));
          vec3 seabed = texture2D(_Refraction, refrUV).rgb * vec3(0.42, 0.52, 0.58);
          // Drifting fish on the seabed — only with the camera above water (_Time is /10, so ×10).
          if (_WorldSpaceCameraPos.y > 0.05) {
            float fish = fishField(vWorldUV, _Time * 10.0);
            seabed *= (1.0 - fish * 0.5);
          }
          waterCol = mix(waterCol, seabed, reveal * 0.92);
        #endif
      #endif
      #ifdef HAS_REFLECTION
        // Planar mirror reflection (skybox + islands + vessels), rippled by the wave normal,
        // strongest at grazing angles (Fresnel). Sampled in screen space.
        vec2 reflUV = vClipCoords.xy / vClipCoords.w * 0.5 + 0.5;
        reflUV += normalW.xz * 0.04;
        reflUV = clamp(reflUV, vec2(0.002), vec2(0.998));
        vec3 planarRefl = texture2D(_Reflection, reflUV).rgb;
        waterCol += planarRefl * fresnel * _ReflStrength;
      #endif
      finalEmissive = mix(waterCol, vec3(0.0), jacobian);
    `);

    // Per-frame uniforms (camera pos, ping-ponged turbulence, time, light dir).
    mat.onBindObservable.add(() => {
      const eff = mat.getEffect();
      if (!eff) { return; }
      eff.setVector3('_WorldSpaceCameraPos', camera.position);
      const t0 = fft.getTurbulenceTex(0); if (t0) { eff.setTexture('_Turbulence_c0', t0 as Texture); }
      const t1 = fft.getTurbulenceTex(1); if (t1) { eff.setTexture('_Turbulence_c1', t1 as Texture); }
      const t2 = fft.getTurbulenceTex(2); if (t2) { eff.setTexture('_Turbulence_c2', t2 as Texture); }
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
      const path = this._deps.getWakePath?.();
      if (wake && path) {
        eff.setFloat2('_BoatPos', wake.x, wake.z);
        eff.setFloat('_BoatSpeed', wake.speed);
        eff.setArray4('_WakePath', path.data as unknown as number[]);
        eff.setFloat('_WakeCount', path.count);
      }
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
