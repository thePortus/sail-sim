import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Fish swim — a vertex-displacement `MaterialPluginBase` for the authored schooling fish GLBs: a traveling
 * LATERAL body-wave so the body undulates and the tail sweeps side-to-side (Babylon lateral axis = ±Z; this
 * is the opposite of the dolphin, whose horizontal flukes pump up/down on ±Y). The sway weight is derived
 * from OBJECT-SPACE GEOMETRY — the body runs along X (nose ≈ +0.55, tail ≈ −0.5), so `sway = 1 − smoothstep(x)`
 * → calm head, full sweep at the tail (a plugin can't read COLOR_0 on our WebGPU-primary engine). A per-fish
 * phase from the instance world position (`world3`) desyncs a school; effort (instance colour alpha) scales
 * the beat so a fleeing fish thrashes harder. GLSL + WGSL. Drive it live via the static `SWIM`.
 */
export class FishSwimPlugin extends MaterialPluginBase {
  /** Live swim, set each frame by FishSchoolService: sway amplitude (m), spatial wave number, beat speed, clock. */
  static readonly SWIM = { amp: 0.13, waveK: 3.4, speed: 3.2, time: 0 };

  constructor(material: Material) {
    super(material, 'FishSwim', 214, { FISH_SWIM: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }
  override getClassName(): string { return 'FishSwimPlugin'; }

  override getUniforms() {
    return { ubo: [{ name: 'fishSwim', size: 4, type: 'vec4' }] };   // amp, waveK, speed, time
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = FishSwimPlugin.SWIM;
    uniformBuffer.updateFloat4('fishSwim', s.amp, s.waveK, s.speed, s.time);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') { return null; }
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? FishSwimPlugin.WGSL : FishSwimPlugin.GLSL };
  }

  // fishSwim = (amp, waveK, speed, time). sway weight from body axis (head calm → tail sweeps). The wave
  // travels down the body (−x·waveK phases the tail behind the head); per-fish offset from world3; effort
  // (instance colour alpha) scales amplitude + beat speed.
  private static readonly GLSL = `
    #ifdef FISH_SWIM
      float fSway = 1.0 - smoothstep(-0.45, 0.25, positionUpdated.x);   // 0 head → 1 tail
      float fPh = 0.0;
      float fEnergy = 1.0;
      #ifdef INSTANCES
        fPh = (world3.x + world3.z) * 0.7;                             // per-fish desync
      #endif
      #ifdef INSTANCESCOLOR
        fEnergy = clamp(instanceColor.a, 0.0, 1.0);                    // per-fish swim effort
      #endif
      float fW = fishSwim.z * fishSwim.w * (0.8 + 0.5 * fEnergy) - positionUpdated.x * fishSwim.y + fPh;
      positionUpdated.z += sin(fW) * fSway * fishSwim.x * (0.5 + 0.7 * fEnergy);
    #endif
  `;

  // NOTE: the WGSL path does NOT read instanceColor.a (see DolphinSwimPlugin for the full rationale): fish render
  // into the ocean refraction RTT / depth prepass, where WebGPU sets INSTANCESCOLOR without declaring the
  // `instanceColor` vertex input → a WGSL compile failure that cascades into invalid pipelines. fEnergy defaults
  // to 1.0 so the school still swims on WebGPU; only the per-fish effort variance is dropped there (kept on WebGL).
  private static readonly WGSL = `
    #ifdef FISH_SWIM
      let fSway = 1.0 - smoothstep(-0.45, 0.25, positionUpdated.x);
      var fPh = 0.0;
      let fEnergy = 1.0;
      #ifdef INSTANCES
        fPh = (vertexInputs.world3.x + vertexInputs.world3.z) * 0.7;
      #endif
      let fW = uniforms.fishSwim.z * uniforms.fishSwim.w * (0.8 + 0.5 * fEnergy) - positionUpdated.x * uniforms.fishSwim.y + fPh;
      positionUpdated.z += sin(fW) * fSway * uniforms.fishSwim.x * (0.5 + 0.7 * fEnergy);
    #endif
  `;
}
