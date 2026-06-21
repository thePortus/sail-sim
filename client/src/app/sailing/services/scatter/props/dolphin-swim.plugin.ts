import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Dolphin swim — a vertex-displacement `MaterialPluginBase` for the authored bottlenose GLBs: a
 * traveling vertical body-wave so the body undulates and the horizontal flukes pump up/down (not
 * side-to-side like a fish). The asset bakes the pump weight into COLOR_0.r (0 over the head → 1 at the
 * flukes), but — exactly as with the gull flap — a plugin can't read the colour attribute on our
 * WebGPU-primary engine when useVertexColors=false. So the weight is derived from OBJECT-SPACE GEOMETRY:
 * the body runs along X (nose ≈ +0.82, flukes ≈ −1.14), so `pump = 1 − smoothstep(x)` → calm head, full
 * pump at the tail. A per-dolphin phase from the instance world position (`world3`) desyncs the pod.
 * GLSL + WGSL. Drive it live via the static `SWIM`.
 */
export class DolphinSwimPlugin extends MaterialPluginBase {
  /** Live swim, set each frame by DolphinService: tail-pump amplitude (m), spatial wave number, beat
   *  speed, swim clock (seconds). */
  static readonly SWIM = { amp: 0.10, waveK: 2.2, speed: 2.4, time: 0 };

  constructor(material: Material) {
    super(material, 'DolphinSwim', 213, { DOLPHIN_SWIM: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'DolphinSwimPlugin'; }

  override getUniforms() {
    return { ubo: [{ name: 'dolSwim', size: 4, type: 'vec4' }] };   // amp, waveK, speed, time
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = DolphinSwimPlugin.SWIM;
    uniformBuffer.updateFloat4('dolSwim', s.amp, s.waveK, s.speed, s.time);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') { return null; }
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? DolphinSwimPlugin.WGSL : DolphinSwimPlugin.GLSL };
  }

  // dolSwim = (amp, waveK, speed, time). pump weight from |body axis| (head calm → flukes pump). The wave
  // travels down the body (−x·waveK phases the tail behind the head); per-dolphin offset from world3.
  private static readonly GLSL = `
    #ifdef DOLPHIN_SWIM
      float dPump = 1.0 - smoothstep(-0.9, 0.3, positionUpdated.x);   // 0 head → 1 flukes
      float dPh   = 0.0;
      float dEnergy = 1.0;
      #ifdef INSTANCES
        dPh = (world3.x + world3.z) * 0.6;                            // per-dolphin desync
      #endif
      #ifdef INSTANCESCOLOR
        dEnergy = clamp(instanceColor.a, 0.0, 1.0);                   // D1: per-dolphin tail EFFORT (darts pump hard)
      #endif
      // Effort scales both the pump amplitude and the beat speed — a darting dolphin thrashes faster + wider.
      float dW = dolSwim.z * dolSwim.w * (0.7 + 0.6 * dEnergy) - positionUpdated.x * dolSwim.y + dPh;
      positionUpdated.y += sin(dW) * dPump * dolSwim.x * (0.4 + 0.85 * dEnergy);
    #endif
  `;

  // NOTE: unlike GLSL, the WGSL path does NOT read instanceColor.a for per-dolphin effort. The dolphins are
  // rendered into the ocean refraction RTT + (intermittently) the depth prepass, and in those passes WebGPU
  // sets the INSTANCESCOLOR define WITHOUT actually declaring `instanceColor` in the vertex-input struct — so
  // `vertexInputs.instanceColor` fails to compile ("struct member instanceColor not found"), which invalidates
  // the pipeline and floods an invalid-RenderPipeline cascade (oceanRefraction / sceneprePassRT). Defaulting
  // dEnergy to 1.0 keeps the swim animation everywhere on WebGPU; only the per-instance effort nuance is lost.
  private static readonly WGSL = `
    #ifdef DOLPHIN_SWIM
      let dPump = 1.0 - smoothstep(-0.9, 0.3, positionUpdated.x);
      var dPh = 0.0;
      let dEnergy = 1.0;
      #ifdef INSTANCES
        dPh = (vertexInputs.world3.x + vertexInputs.world3.z) * 0.6;
      #endif
      let dW = uniforms.dolSwim.z * uniforms.dolSwim.w * (0.7 + 0.6 * dEnergy) - positionUpdated.x * uniforms.dolSwim.y + dPh;
      positionUpdated.y += sin(dW) * dPump * uniforms.dolSwim.x * (0.4 + 0.85 * dEnergy);
    #endif
  `;
}
