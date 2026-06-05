import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Shadow blob — a vertex-displacement `MaterialPluginBase` on the flat ground-disc material that fakes
 * a cast shadow under each static land scatter asset (palms / beeches / rocks / driftwood). The disc is
 * thin-instanced once at each asset's base (a round soft-edged decal); this plugin STRETCHES that round
 * disc into an ellipse pointing AWAY from the sun, lengthening as the sun lowers — so the per-instance
 * matrices stay baked (cheap) while the shadow direction/length tracks the sun live via one global
 * uniform. Night fade is handled separately by the material's per-frame `alpha`.
 *
 * The disc base mesh is a unit ground quad in the XZ plane (local x,z ∈ [-0.5, 0.5], y = 0) and the
 * instance matrix carries only translation + uniform scale (NO rotation), so the disc's local axes line
 * up with world X/Z — meaning the world-space sun azimuth can be applied directly in object space here.
 * We split the local position into a component ALONG the (unit) shadow direction and a PERPENDICULAR
 * one, scale the along-component by `stretch`, and shift it so the sun-side edge stays anchored under the
 * trunk while the far edge reaches out away from the sun.
 *
 * Emits BOTH GLSL (WebGL) and WGSL (WebGPU — primary). Drive it live via the static `SHADOW`.
 */
export class ShadowBlobPlugin extends MaterialPluginBase {
  /** Live sun-shadow params, set each frame by ScatterService: unit XZ direction the shadow points
   *  (away from the sun) + a length multiplier that grows as the sun lowers. */
  static readonly SHADOW = { dirX: 0, dirZ: 1, stretch: 1 };

  constructor(material: Material) {
    super(material, 'ShadowBlob', 220, { SHADOW_BLOB: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'ShadowBlobPlugin'; }

  override getUniforms() {
    return { ubo: [{ name: 'shadowBlob', size: 4, type: 'vec4' }] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = ShadowBlobPlugin.SHADOW;
    uniformBuffer.updateFloat4('shadowBlob', s.dirX, s.dirZ, s.stretch, 0);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') { return null; }
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? ShadowBlobPlugin.WGSL : ShadowBlobPlugin.GLSL };
  }

  // shadowBlob = (dirX, dirZ, stretch, _). Anchor: sun-side edge (along = -0.5) stays put under the
  // trunk; far edge (along = +0.5) reaches out to (stretch - 0.5), so the disc elongates away from the sun.
  private static readonly GLSL = `
    #ifdef INSTANCES
    #ifdef SHADOW_BLOB
      vec2  sDir    = vec2(shadowBlob.x, shadowBlob.y);
      float sStr    = shadowBlob.z;
      vec2  sLocal  = vec2(positionUpdated.x, positionUpdated.z);
      float sAlong  = dot(sLocal, sDir);
      vec2  sPerp   = sLocal - sAlong * sDir;
      float sNew    = sAlong * sStr + (sStr - 1.0) * 0.5;
      vec2  sXZ     = sPerp + sNew * sDir;
      positionUpdated.x = sXZ.x;
      positionUpdated.z = sXZ.y;
    #endif
    #endif
  `;

  private static readonly WGSL = `
    #ifdef INSTANCES
    #ifdef SHADOW_BLOB
      let sDir   = vec2f(uniforms.shadowBlob.x, uniforms.shadowBlob.y);
      let sStr   = uniforms.shadowBlob.z;
      let sLocal = vec2f(positionUpdated.x, positionUpdated.z);
      let sAlong = dot(sLocal, sDir);
      let sPerp  = sLocal - sAlong * sDir;
      let sNew   = sAlong * sStr + (sStr - 1.0) * 0.5;
      let sXZ    = sPerp + sNew * sDir;
      positionUpdated.x = sXZ.x;
      positionUpdated.z = sXZ.y;
    #endif
    #endif
  `;
}
