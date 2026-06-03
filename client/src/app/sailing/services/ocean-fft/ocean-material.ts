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
  Scene, Camera, Vector3, Vector4, Texture, DynamicTexture, BaseTexture,
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

    const defines: string[] = [];
    if (useMid) { defines.push('#define MID'); }
    if (useClose) { defines.push('#define CLOSE'); }
    const depthDef = this._deps.depthTexture ? '#define HAS_DEPTH' : '';

    // WebGPU caps vertex→fragment varyings at 16 (PBR already uses ~11), so keep these
    // minimal: per-cascade UVs are recomputed in the fragment; clip coords only when depth
    // contact-foam is on.
    const varyings = `
      varying vec2 vWorldUV;
      varying vec3 vViewVector;
      varying vec4 vLodScales;
      #ifdef HAS_DEPTH
        varying vec4 vClipCoords;
      #endif
    `;

    mat.Vertex_Definitions(`${defines.join('\n')}\n${depthDef}\n${varyings}`);
    mat.Fragment_Definitions(`${defines.join('\n')}\n${depthDef}\n${varyings}`);

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

      worldPos.xyz += displacement;

      vLodScales = vec4(lod_c0, lod_c1, lod_c2, max(displacement.y - largeWavesBias * 0.8 - _SSSBase, 0.) / _SSSScale);
    `);

    mat.Vertex_MainEnd(`
      #ifdef HAS_DEPTH
        vClipCoords = gl_Position;
      #endif
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
      finalEmissive = mix(color * (1.0 - fresnel), vec3(0.0), jacobian);
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
