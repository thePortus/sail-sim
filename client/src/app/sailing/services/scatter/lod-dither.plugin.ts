import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Screen-door (DITHER) LoD dissolve for the impostor billboards — the alpha-test alternative to the
 * scale-collapse fades (NearFade/FarFade), so impostors DISSOLVE in/out by distance instead of growing /
 * shrinking (which the user explicitly disliked). Because it only ever `discard`s fragments, the impostor
 * stays in the opaque / alpha-test pass — NO transparency sorting, NO size change.
 *
 * Distance comes from `vFogDistance` (Babylon's view-space fog varying), read in the FRAGMENT exactly like
 * ImpostorHazePlugin — these unlit impostor StandardMaterials keep fog enabled, so it's present under
 * `#ifdef FOG`. The per-pixel keep/discard threshold is interleaved-gradient noise (IGN) of the framebuffer
 * position — a cheap, stable, low-clumping ordered dither. Injected at CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR.
 *
 * Visibility curve: appear[lo,hi] = OPAQUE beyond `hi`, dithered to nothing by `lo` (the near cross-dissolve
 * with the full mesh, or the far billboards growing in with distance); cull[lo,hi] = dithered back OUT past
 * the patch-cull edge (set huge to disable). fade = smoothstep(appear) · (1 − smoothstep(cull)).
 *
 * GLSL (WebGL) + WGSL (WebGPU). Vertex untouched (full size always).
 */
export class LodDitherPlugin extends MaterialPluginBase {
  /** Live camera XZ unused here (distance is per-pixel from vFogDistance); bands are per-material. */
  private readonly appear: { start: number; end: number };
  private readonly cull: { start: number; end: number };

  /** @param appear opaque beyond `end`, gone by `start`. @param cull dithered out past the cull edge (by ref;
   *  default disables it with a huge band). Pass the SAME object the layer mutates so quality changes flow. */
  constructor(material: Material, appear: { start: number; end: number },
              cull: { start: number; end: number } = { start: 1e9, end: 1e9 + 1 }) {
    super(material, 'LodDither', 215, { LOD_DITHER: true });   // before ImpostorHaze (216)
    this.appear = appear;
    this.cull = cull;
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'LodDitherPlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'ditherAppear', size: 2, type: 'vec2' },
      { name: 'ditherCull',   size: 2, type: 'vec2' },
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    uniformBuffer.updateFloat2('ditherAppear', this.appear.start, this.appear.end);
    uniformBuffer.updateFloat2('ditherCull', this.cull.start, this.cull.end);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'fragment') return null;
    return { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR:
      shaderLanguage === ShaderLanguage.WGSL ? LodDitherPlugin.WGSL : LodDitherPlugin.GLSL };
  }

  private static readonly GLSL = `
    #ifdef FOG
      float ldD = length(vFogDistance);
      float ldFade = smoothstep(ditherAppear.x, ditherAppear.y, ldD) * (1.0 - smoothstep(ditherCull.x, ditherCull.y, ldD));
      // Interleaved-gradient noise of the framebuffer pixel → a stable, low-clumping ordered dither threshold.
      float ldIGN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (ldFade < ldIGN) { discard; }
    #endif
  `;

  private static readonly WGSL = `
    #ifdef FOG
      let ldD = length(fragmentInputs.vFogDistance);
      let ldFade = smoothstep(uniforms.ditherAppear.x, uniforms.ditherAppear.y, ldD) * (1.0 - smoothstep(uniforms.ditherCull.x, uniforms.ditherCull.y, ldD));
      let ldIGN = fract(52.9829189 * fract(dot(fragmentInputs.position.xy, vec2f(0.06711056, 0.00583715))));
      if (ldFade < ldIGN) { discard; }
    #endif
  `;
}
