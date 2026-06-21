import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Soft LoD cross-fade for the camera-following tree layers (palms / beeches), killing the hard pop when a
 * 40 m patch flips between its full-3D mesh and its baked cross-impostor.
 *
 * A patch swaps LoD as a whole when its CENTRE crosses `near` (PatchManager), so per-tree fading can't be a
 * true cross-fade (only one LoD renders per patch). Instead — exactly like FarFadePlugin — we SCALE-COLLAPSE
 * each instance toward its own base (sinks into the ground) by distance, with the two representations
 * collapsing to zero at the SAME distance (`near`):
 *   - full mesh (fadeIn=false): full inside, shrinks to 0 over [near-band, near]
 *   - impostor (fadeIn=true):    0 at near, grows to full over [near, near+band]
 * So every instance in the swap zone is tiny in BOTH the full and the impostor form — the patch flip lands on
 * near-invisible geometry and reads as a dissolve, never a pop. Trees well inside stay full-3D; trees well
 * past `near` stay full impostors; only a thin shrinking ring straddles the boundary (and at `near` ≈ 260 m
 * that ring is small on screen).
 *
 * Vertex-only (no fragment/dither/varyings → WebGPU-safe). Injects at CUSTOM_VERTEX_UPDATE_POSITION using the
 * raw thin-instance world position (world3) under #ifdef INSTANCES. GLSL + WGSL.
 */
export class NearFadePlugin extends MaterialPluginBase {
  /** Live camera XZ, set each frame by ScatterService (shared by all palm/beech materials). */
  static readonly camera = { x: 0, z: 0 };
  /** `near` = the layer's full→impostor swap distance; `band` = collapse/grow width on each side (m). */
  static readonly params = { near: 260, band: 55 };

  private readonly fadeIn: boolean;

  constructor(material: Material, fadeIn: boolean) {
    super(material, 'NearFade', 214, { NEAR_FADE: true });
    this.fadeIn = fadeIn;
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }
  override getClassName(): string { return 'NearFadePlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'nearCam',    size: 2, type: 'vec2' },
      { name: 'nearParams', size: 2, type: 'vec2' },   // x = near, y = band
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const c = NearFadePlugin.camera, p = NearFadePlugin.params;
    uniformBuffer.updateFloat2('nearCam', c.x, c.z);
    uniformBuffer.updateFloat2('nearParams', p.near, p.band);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') return null;
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    return { CUSTOM_VERTEX_UPDATE_POSITION: wgsl ? this.wgsl() : this.glsl() };
  }

  private glsl(): string {
    // fadeIn (impostor): 0 at near → 1 at near+band.  fadeOut (full): 1 → 0 over [near-band, near].
    const f = this.fadeIn
      ? 'smoothstep(nearParams.x, nearParams.x + nearParams.y, dN)'
      : '1.0 - smoothstep(nearParams.x - nearParams.y, nearParams.x, dN)';
    return `
    #ifdef INSTANCES
      float dN = distance(vec2(world3.x, world3.z), nearCam);
      positionUpdated *= ${f};
    #endif
  `;
  }

  private wgsl(): string {
    const f = this.fadeIn
      ? 'smoothstep(uniforms.nearParams.x, uniforms.nearParams.x + uniforms.nearParams.y, dN)'
      : '1.0 - smoothstep(uniforms.nearParams.x - uniforms.nearParams.y, uniforms.nearParams.x, dN)';
    return `
    #ifdef INSTANCES
      let dN = distance(vec2f(vertexInputs.world3.x, vertexInputs.world3.z), uniforms.nearCam);
      positionUpdated *= ${f};
    #endif
  `;
  }
}
