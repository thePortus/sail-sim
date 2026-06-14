import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Aerial-perspective haze for the static far-forest impostors. They're unlit, pre-lit billboards
 * (StandardMaterial, emissive = baked tree image), so Babylon's built-in scene fog (FOGMODE_EXP2 at the
 * scene's tiny density) barely touches them — the distant hills they sit on fade into the sky via the
 * terrain shader's MUCH stronger custom haze, leaving the trees looking unnaturally vivid + dark against it.
 *
 * This injects the EXACT same aerial-perspective formula the terrain uses (terrain.service.ts:
 *   hazeF = clamp(pow(1 - exp(-dist * 0.00020), 1.4), 0, 0.96);  color = mix(color, skyColor, hazeF))
 * so the impostors recede into the haze in lockstep with the terrain. Distance comes from `vFogDistance`
 * (Babylon's view-space fog varying, present whenever FOG is defined — these materials keep fog enabled);
 * the tint is the live scene.fogColor (day/dusk/night/storm aware). GLSL (WebGL) + WGSL (WebGPU).
 *
 * Injected at CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR — after Babylon's own fog/image-processing, so it has the
 * final `color`. Stacks harmlessly on top of the scene's negligible EXP2 fog.
 */
export class ImpostorHazePlugin extends MaterialPluginBase {
  /** Aerial-perspective tuning — kept identical to the terrain shader so the two match exactly. */
  static density = 0.00020;   // haze build-up rate with distance (1 - exp(-dist*density))
  static power   = 1.4;       // shaping exponent (pushes the onset further out)
  static maxHaze = 0.96;      // never fully dissolve a tree into pure sky

  constructor(material: Material) {
    super(material, 'ImpostorHaze', 216, { IMPOSTOR_HAZE: true });   // after FarFade (211)
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'ImpostorHazePlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'uHazeColor',  size: 3, type: 'vec3' },
      { name: 'uHazeParams', size: 3, type: 'vec3' },   // (density, power, maxHaze)
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    uniformBuffer.updateColor3('uHazeColor', scene.fogColor);   // live sky/fog tint (day/dusk/night/storm)
    uniformBuffer.updateFloat3('uHazeParams', ImpostorHazePlugin.density, ImpostorHazePlugin.power, ImpostorHazePlugin.maxHaze);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'fragment') return null;
    return { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR:
      shaderLanguage === ShaderLanguage.WGSL ? ImpostorHazePlugin.WGSL : ImpostorHazePlugin.GLSL };
  }

  private static readonly GLSL = `
    #ifdef FOG
      float hzD = length(vFogDistance);
      float hzF = clamp(pow(1.0 - exp(-hzD * uHazeParams.x), uHazeParams.y), 0.0, uHazeParams.z);
      color.rgb = mix(color.rgb, uHazeColor, hzF);
    #endif
  `;

  private static readonly WGSL = `
    #ifdef FOG
      let hzD = length(fragmentInputs.vFogDistance);
      let hzF = clamp(pow(1.0 - exp(-hzD * uniforms.uHazeParams.x), uniforms.uHazeParams.y), 0.0, uniforms.uHazeParams.z);
      color = vec4f(mix(color.rgb, uniforms.uHazeColor, hzF), color.a);
    #endif
  `;
}
