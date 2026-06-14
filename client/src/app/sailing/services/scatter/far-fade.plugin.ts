import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Distance fade for the STATIC far-forest impostor layer — the INVERSE of GrassFadePlugin. The impostors
 * blanket the whole island's forested slopes, but near the camera the camera-following scatter ring owns the
 * (full-3D + near-impostor) trees, so this hides the static billboards up close and grows them in only at
 * distance: each instance is scaled from 0 (within `start` m) to full size (beyond `end` m), collapsing into
 * its own base (sinks into the ground) for a clean dissolve, never a pop. Far fog takes the very distant ones.
 *
 * Attaches to the impostor StandardMaterial; injects at CUSTOM_VERTEX_UPDATE_POSITION using the raw
 * thin-instance matrix attributes (world3 = world position) under #ifdef INSTANCES. GLSL + WGSL.
 */
export class FarFadePlugin extends MaterialPluginBase {
  /** Live camera XZ, set each frame by ScatterService. */
  static readonly camera = { x: 0, z: 0 };
  /** Fade band (m): zero size up to `start`, full size by `end`. start ~ near scatter ring edge. */
  static readonly band = { start: 280, end: 470 };

  constructor(material: Material) {
    super(material, 'FarFade', 211, { FAR_FADE: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }
  override getClassName(): string { return 'FarFadePlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'farCam',  size: 2, type: 'vec2' },
      { name: 'farBand', size: 2, type: 'vec2' },
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const c = FarFadePlugin.camera, b = FarFadePlugin.band;
    uniformBuffer.updateFloat2('farCam', c.x, c.z);
    uniformBuffer.updateFloat2('farBand', b.start, b.end);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') return null;
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? FarFadePlugin.WGSL : FarFadePlugin.GLSL };
  }

  private static readonly GLSL = `
    #ifdef INSTANCES
      float fFar = smoothstep(farBand.x, farBand.y, distance(vec2(world3.x, world3.z), farCam));
      positionUpdated *= fFar;   // 0 near (hidden — ring owns near trees), full far
    #endif
  `;

  private static readonly WGSL = `
    #ifdef INSTANCES
      let fFar = smoothstep(uniforms.farBand.x, uniforms.farBand.y, distance(vec2f(vertexInputs.world3.x, vertexInputs.world3.z), uniforms.farCam));
      positionUpdated *= fFar;
    #endif
  `;
}
