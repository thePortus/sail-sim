import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Palm wind — a vertex-displacement `MaterialPluginBase` attached to the authored palm GLB's PBR
 * material, so full PBR lighting (and the baked domed-canopy normals) are preserved. Modelled on the
 * grass `GrassFadePlugin`: it reads the thin-instance matrix columns (`world0/world2` = the tree's
 * local axes, `world3` = its world position) under `#ifdef INSTANCES` and bends the crown in the
 * world wind direction.
 *
 * Sway shape: the asset bakes a sway weight into COLOR_0, but on WebGPU a plugin can't read the colour
 * attribute when the material runs with useVertexColors=false (the WGSL `vertexInputs` struct omits it
 * unless VERTEXCOLOR is defined, which would tint the albedo). So we derive an equivalent weight from
 * the vertex's OBJECT-SPACE HEIGHT — the trunk (low Y) stays planted, the crown/fronds (high Y) flex —
 * with a per-frond phase from the vertex position so the fronds don't wave in lockstep, plus a
 * per-TREE phase from the instance world position so a grove desyncs. Looks the same in motion.
 *
 * Emits BOTH GLSL (WebGL) and WGSL (WebGPU — primary). Drive it live via the static `WIND`.
 */
export class PalmWindPlugin extends MaterialPluginBase {
  /** Live wind, set each frame by ScatterService: unit XZ direction, tip-travel amplitude (m),
   *  wind clock (seconds). */
  static readonly WIND = { dirX: 0, dirZ: 1, amplitude: 0.22, time: 0 };

  constructor(material: Material) {
    super(material, 'PalmWind', 215, { PALM_WIND: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'PalmWindPlugin'; }

  override getUniforms() {
    return { ubo: [{ name: 'palmWind', size: 4, type: 'vec4' }] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const w = PalmWindPlugin.WIND;
    uniformBuffer.updateFloat4('palmWind', w.dirX, w.dirZ, w.amplitude, w.time);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') { return null; }
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? PalmWindPlugin.WGSL : PalmWindPlugin.GLSL };
  }

  // World wind projected into the tree's own (yaw-rotated) local axes so every palm leans the same way
  // in world space. Bend weight = smoothstep on object-space height (trunk rigid → crown flexes); phase
  // = a per-frond offset from the vertex position + a per-tree offset from the instance world position.
  // palmWind = (dirX, dirZ, amplitude, time).
  private static readonly GLSL = `
    #ifdef INSTANCES
    #ifdef PALM_WIND
      float pSway  = smoothstep(2.0, 7.5, positionUpdated.y);          // trunk planted, crown/fronds flex
      float pPhase = (positionUpdated.x - positionUpdated.z) * 0.6;    // per-frond desync (geometry)
      float pTree  = (world3.x + world3.z) * 0.18;                     // per-tree desync (instance world pos)
      float pT     = palmWind.w;
      float pOsc   = sin(pT + pTree + pPhase) + 0.30 * sin(pT * 2.3 + pTree);
      float pAmt   = palmWind.z * pSway * pOsc;
      vec2  pW  = vec2(palmWind.x, palmWind.y);
      vec2  pA0 = vec2(world0.x, world0.z); float pL0 = length(pA0);
      vec2  pA2 = vec2(world2.x, world2.z); float pL2 = length(pA2);
      positionUpdated.x += dot(pW, pL0 > 1e-4 ? pA0 / pL0 : vec2(1.0, 0.0)) * pAmt;
      positionUpdated.z += dot(pW, pL2 > 1e-4 ? pA2 / pL2 : vec2(0.0, 1.0)) * pAmt;
    #endif
    #endif
  `;

  private static readonly WGSL = `
    #ifdef INSTANCES
    #ifdef PALM_WIND
      let pSway  = smoothstep(2.0, 7.5, positionUpdated.y);
      let pPhase = (positionUpdated.x - positionUpdated.z) * 0.6;
      let pTree  = (vertexInputs.world3.x + vertexInputs.world3.z) * 0.18;
      let pT     = uniforms.palmWind.w;
      let pOsc   = sin(pT + pTree + pPhase) + 0.30 * sin(pT * 2.3 + pTree);
      let pAmt   = uniforms.palmWind.z * pSway * pOsc;
      let pW  = vec2f(uniforms.palmWind.x, uniforms.palmWind.y);
      let pA0 = vec2f(vertexInputs.world0.x, vertexInputs.world0.z); let pL0 = length(pA0);
      let pA2 = vec2f(vertexInputs.world2.x, vertexInputs.world2.z); let pL2 = length(pA2);
      positionUpdated.x += dot(pW, select(vec2f(1.0, 0.0), pA0 / pL0, pL0 > 1e-4)) * pAmt;
      positionUpdated.z += dot(pW, select(vec2f(0.0, 1.0), pA2 / pL2, pL2 > 1e-4)) * pAmt;
    #endif
    #endif
  `;
}
