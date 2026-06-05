import {
  MaterialPluginBase, Material, UniformBuffer, ShaderLanguage, Nullable, Scene, SubMesh, Vector3,
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

  /** Camera distances (m) over which the AO fades out. The occlusion map's coarse mips average much
   *  darker than the sharp close-up, so at range the AO multiply drives the ship toward black. Fading
   *  it out with distance kills that darkening — and crevice AO is invisible on a far, tiny boat anyway.
   *  Full AO within nearFade, gone by farFade. */
  nearFade = 28;
  farFade  = 70;

  /** Hard lower bound on the occlusion multiply (0..1). The AO can darken a surface to at most this
   *  fraction — so even when the occlusion texture mips down to a near-black average (the cause of the
   *  boat going black on zoom-out, FOV or dolly), the ship can never read fully unlit. 1 = AO off. */
  aoFloor = 0.45;

  /** Occlusion contrast multiplier applied BEFORE the floor (1 - (1-ao)*boost). NOTE: keep this at 1
   *  (raw bake). The deck's baked AO is already heavy while the hull's is near-zero, so a global >1
   *  boost crushes the deck flat into the floor (uniform dark deck) without helping the hull. To make
   *  AO read more, prefer LOWERING aoFloor — it deepens wherever real occlusion exists without crushing. */
  aoBoost = 1.0;

  constructor(material: Material) {
    super(material, 'BakedAO', 210, { BAKED_AO: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'BakedAOPlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'aoStrength', size: 1, type: 'float' },
      { name: 'aoFloor', size: 1, type: 'float' },
      { name: 'aoBoost', size: 1, type: 'float' },
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, _engine: unknown, subMesh: SubMesh): void {
    // Fade the AO out with camera distance (see nearFade/farFade) so the occlusion map's darker coarse
    // mips can't blacken the ship as the camera pulls back. CPU-side per-mesh — no shader/WGSL changes.
    let fade = 1;
    const cam = scene.activeCamera;
    if (cam) {
      const c = subMesh.getRenderingMesh().getBoundingInfo().boundingSphere.centerWorld;
      const dist = Vector3.Distance(c, cam.globalPosition);
      fade = 1 - Math.min(1, Math.max(0, (dist - this.nearFade) / (this.farFade - this.nearFade)));
    }
    uniformBuffer.updateFloat('aoStrength', this.strength * fade);
    uniformBuffer.updateFloat('aoFloor', this.aoFloor);
    uniformBuffer.updateFloat('aoBoost', this.aoBoost);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'fragment') { return null; }
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return {
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR:
          'finalColor = vec4f(finalColor.rgb * mix(vec3f(1.0), max(vec3f(1.0) - (vec3f(1.0) - aoOut.ambientOcclusionColor) * uniforms.aoBoost, vec3f(uniforms.aoFloor)), uniforms.aoStrength), finalColor.a);',
      };
    }
    return {
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR:
        'finalColor.rgb *= mix(vec3(1.0), max(vec3(1.0) - (vec3(1.0) - aoOut.ambientOcclusionColor) * aoBoost, vec3(aoFloor)), aoStrength);',
    };
  }
}
