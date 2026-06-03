import {
  MaterialPluginBase, Material, UniformBuffer, ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * BakedAOPlugin — makes the vessel's baked ambient occlusion (the R channel of the glTF ORM
 * textures) actually visible in-game.
 *
 * Babylon's PBR only applies the occlusion map to AMBIENT / indirect (IBL) light. This scene
 * has no IBL environment and a black scene.ambientColor — the "ambient" is a HemisphericLight,
 * which is a DIRECT light the occlusion can't touch — so the baked AO has nothing to darken
 * and is invisible. This plugin multiplies the final lit colour by the already-sampled
 * occlusion (`aoOut.ambientOcclusionColor`, which defaults to 1.0 on materials with no AO map,
 * so glass/lantern parts are untouched), giving a clear baked-AO look regardless of lighting.
 *
 * Injected at CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR (after Babylon's ambientOcclusionBlock has run).
 * Emits both GLSL (WebGL) and WGSL (WebGPU).
 */
export class BakedAOPlugin extends MaterialPluginBase {
  /** 0 = off, 1 = full baked occlusion, >1 = exaggerated. */
  strength = 1.0;

  constructor(material: Material) {
    super(material, 'BakedAO', 210, { BAKED_AO: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'BakedAOPlugin'; }

  override getUniforms() {
    return { ubo: [{ name: 'aoStrength', size: 1, type: 'float' }] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat('aoStrength', this.strength);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'fragment') { return null; }
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return {
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR:
          'finalColor = vec4f(finalColor.rgb * mix(vec3f(1.0), aoOut.ambientOcclusionColor, uniforms.aoStrength), finalColor.a);',
      };
    }
    return {
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR:
        'finalColor.rgb *= mix(vec3(1.0), aoOut.ambientOcclusionColor, aoStrength);',
    };
  }
}
