import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * TRUE LoD cross-dissolve for the camera-following tree layers (palms / beeches): a billboard impostor that
 * morphs into the full-3D mesh (and back) across a transition RING, with no pop and no vanish.
 *
 * The trick: in the ring [near-band, near+band] the patch renders BOTH its impostor clone AND its full clone
 * (they share the same GPU instance matrices — see ScatterService.makeGlbLayer's 3-state LoD + the patches'
 * secondary-clone support). Each clone carries this plugin and SCALE-COLLAPSES per-instance by distance, but
 * each stays FULL-SIZE across its own domain and shrinks out only on the side where the OTHER is already full:
 *   - full mesh (fadeIn=false): 1 inside `near`, shrinks 1→0 over the OUTER half [near, near+band]
 *   - impostor (fadeIn=true):   1 outside `near`, shrinks 1→0 over the INNER half [near-band, near]
 * So at every distance at least one representation is at full height (they OVERLAP at full size around `near`)
 * — the billboard sinks away as the 3D tree is already there beside it, and vice versa. No height dip, no gap,
 * no pop. Inside near-band only the full mesh renders; past near+band only the impostor. With the dual-render
 * OFF (legacy/opt-out) only one LoD renders per patch, so the same curves degrade to the old shrink-at-swap.
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
    // Each curve is full across its own domain, shrinking out only on the far side so the two OVERLAP at
    // full size around `near` (no height dip). impostor: 1→0 over inner half [near-band, near]; full: 1→0
    // over outer half [near, near+band].
    const f = this.fadeIn
      ? 'smoothstep(nearParams.x - nearParams.y, nearParams.x, dN)'
      : '1.0 - smoothstep(nearParams.x, nearParams.x + nearParams.y, dN)';
    return `
    #ifdef INSTANCES
      float dN = distance(vec2(world3.x, world3.z), nearCam);
      positionUpdated *= ${f};
    #endif
  `;
  }

  private wgsl(): string {
    const f = this.fadeIn
      ? 'smoothstep(uniforms.nearParams.x - uniforms.nearParams.y, uniforms.nearParams.x, dN)'
      : '1.0 - smoothstep(uniforms.nearParams.x, uniforms.nearParams.x + uniforms.nearParams.y, dN)';
    return `
    #ifdef INSTANCES
      let dN = distance(vec2f(vertexInputs.world3.x, vertexInputs.world3.z), uniforms.nearCam);
      positionUpdated *= ${f};
    #endif
  `;
  }
}
