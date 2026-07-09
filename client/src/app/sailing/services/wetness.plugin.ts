import {
  MaterialPluginBase, Material, UniformBuffer, ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Hull & deck WETNESS — a fragment plugin attached to each vessel's hull/deck PBRMaterial
 * (NOT sails/flags/rigging). Port of the native client's mesh.wgsl wetness. Built in phases:
 *
 *   Phase 1 (this): a wet FILM — the hull darkens in a band around the waterline, and rain
 *     darkens up-facing surfaces. Injected at CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR (the proven
 *     point BakedAO uses), so it composes with the existing PBR + baked-AO shading. Flat
 *     waterline for now (the per-fragment wave-following seaMap comes in a later phase).
 *   Later phases: roughness drop (wet sheen), standing deck puddles, wave-following waterline,
 *     puddle sky reflections + raindrop ripples.
 *
 * Global per-frame state (sea-surface Y at the local ship, rain, time, enable) lives in a static
 * updated once per frame by VesselService — mirroring SailBillowPlugin.wind. Emits WGSL (WebGPU)
 * and GLSL (WebGL); this client supports both.
 */
export class WetnessPlugin extends MaterialPluginBase {
  /** Scene-wide wetness state, pushed once per frame by VesselService.pumpWetness(). */
  static readonly shared = {
    seaY: 0,       // sea-surface world Y at the local ship (the waterline height)
    reach: 0.35,   // splash reach (m) above the sea the wet band climbs the hull
    rain: 0,       // rain intensity [0,1]
    time: 0,       // seconds (unused in Phase 1; drives puddle ripples later)
    enabled: 1,    // 0 = off (shader no-ops), 1 = on
  };

  constructor(material: Material) {
    super(material, 'Wetness', 205, { WETNESS: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }             // GLSL + WGSL
  override getClassName(): string { return 'WetnessPlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'wetSeaY',    size: 1, type: 'float' },
      { name: 'wetReach',   size: 1, type: 'float' },
      { name: 'wetRain',    size: 1, type: 'float' },
      { name: 'wetEnabled', size: 1, type: 'float' },
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const s = WetnessPlugin.shared;
    uniformBuffer.updateFloat('wetSeaY', s.seaY);
    uniformBuffer.updateFloat('wetReach', s.reach);
    uniformBuffer.updateFloat('wetRain', s.rain);
    uniformBuffer.updateFloat('wetEnabled', s.enabled);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'fragment') { return null; }
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: WetnessPlugin.WGSL };
    }
    return { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: WetnessPlugin.GLSL };
  }

  // Wet band around the waterline (world Y vs the sea surface, climbing `reach` up the hull) +
  // a rain film on up-facing surfaces. A wet film darkens the diffuse (the sheen/reflection
  // refinements land in later phases). finalColor is the lit HDR colour at this point.
  private static readonly GLSL = `
    if (wetEnabled > 0.5) {
      float wNUp = normalize(vNormalW).y;
      float wWL  = clamp(1.0 - smoothstep(wetSeaY - 0.05, wetSeaY + wetReach, vPositionW.y), 0.0, 1.0);
      float wRainUp = clamp(wNUp * 0.45 + 0.5, 0.0, 1.0);
      float wDamp = max(wWL, wetRain * wRainUp);
      finalColor.rgb *= mix(1.0, 0.68, wDamp);
    }
  `;

  private static readonly WGSL = `
    if (uniforms.wetEnabled > 0.5) {
      let wNUp = normalize(fragmentInputs.vNormalW).y;
      let wWL  = clamp(1.0 - smoothstep(uniforms.wetSeaY - 0.05, uniforms.wetSeaY + uniforms.wetReach, fragmentInputs.vPositionW.y), 0.0, 1.0);
      let wRainUp = clamp(wNUp * 0.45 + 0.5, 0.0, 1.0);
      let wDamp = max(wWL, uniforms.wetRain * wRainUp);
      finalColor = vec4f(finalColor.rgb * mix(1.0, 0.68, wDamp), finalColor.a);
    }
  `;
}
