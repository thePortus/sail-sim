import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Bird wing-flap — a vertex-displacement `MaterialPluginBase` for the authored coastal-gull GLBs. The
 * asset bakes the flap weight into COLOR_0 (R = flap, B = body-bob), but — exactly as with the palm and
 * tree wind plugins — a plugin can't read the colour attribute on our WebGPU-primary engine when the
 * material runs with useVertexColors=false (the WGSL `vertexInputs` struct omits it). So the flap is
 * derived from OBJECT-SPACE GEOMETRY instead:
 *   - **wingspan is ±Z, body ≈ z=0**, so the flap weight = smoothstep(|z|) → 0 at the body, 1 at the
 *     wingtip. The perched variant (bird_c) has its wings folded into |z| ≤ 0.13, so it barely flaps for
 *     free — only the idle body-bob plays.
 *   - **body-bob weight** = the inverse (1 near the spine → 0 at the wings) for a subtle breathing rise.
 * Per-bird desync comes from the instance world position (`world3`) under `#ifdef INSTANCES`, so a flock
 * doesn't beat its wings in unison (no custom per-instance attribute needed). `ampScale` lets bird_b
 * glide gently (low flap) while bird_a flaps fully, from one shared atlas material per variant.
 *
 * Emits GLSL (WebGL) and WGSL (WebGPU — primary). Drive it live via the static `FLAP`.
 */
export class BirdFlapPlugin extends MaterialPluginBase {
  /** Live flap, set each frame by BirdService: wingbeat speed, wingtip travel (m), body-bob (m), clock. */
  static readonly FLAP = { speed: 3.2, flapAmp: 0.26, bobAmp: 0.05, time: 0 };

  private readonly ampScale: number;   // per-variant flap multiplier (bird_a 1.0, bird_b ~0.4, bird_c 1.0)

  /** @param opts.ampScale scales the wingtip travel for this variant (gliders flap less). */
  constructor(material: Material, opts: { ampScale?: number } = {}) {
    super(material, 'BirdFlap', 214, { BIRD_FLAP: true });
    this.ampScale = opts.ampScale ?? 1.0;
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'BirdFlapPlugin'; }

  override getUniforms() {
    return { ubo: [{ name: 'birdFlap', size: 4, type: 'vec4' }] };   // flapAmp, bobAmp, speed, time
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const f = BirdFlapPlugin.FLAP;
    uniformBuffer.updateFloat4('birdFlap', f.flapAmp * this.ampScale, f.bobAmp, f.speed, f.time);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') { return null; }
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? BirdFlapPlugin.WGSL : BirdFlapPlugin.GLSL };
  }

  // birdFlap = (flapAmp, bobAmp, speed, time). Wing flap weight from |z| (span); body bob from the spine.
  // Wingtips rise/fall along +Y and sweep slightly inward along ±Z on the upstroke; the body counter-bobs.
  // Phase per bird = instance world position so a flock desyncs. PER-BIRD EFFORT (B4): the instance colour's
  // ALPHA carries a 0..1 flap "energy" written each frame from the bird's vertical speed — a climbing gull
  // flaps hard, a gliding one holds its wings nearly still — scaling amplitude continuously (the opaque material
  // discards the fragment alpha, so reusing it here is free). No INSTANCESCOLOR → energy defaults to 1.
  private static readonly GLSL = `
    #ifdef BIRD_FLAP
      float bEnergy = 1.0;
      #ifdef INSTANCESCOLOR
        bEnergy = clamp(instanceColor.a, 0.0, 1.0);                  // per-bird flap effort
      #endif
      float bWf  = smoothstep(0.10, 0.70, abs(positionUpdated.z));   // 0 body → 1 wingtip
      float bBob = 1.0 - smoothstep(0.05, 0.25, abs(positionUpdated.z));
      float bPh  = 0.0;
      #ifdef INSTANCES
        bPh = (world3.x + world3.z) * 1.7;                           // per-bird desync (instance world pos)
      #endif
      float bT = birdFlap.z * birdFlap.w + bPh;
      float bF = sin(bT);
      float bAmp = birdFlap.x * bEnergy;
      positionUpdated.y += bF * bWf * bAmp;                          // wings rise/fall
      positionUpdated.z -= sign(positionUpdated.z) * max(bF, 0.0) * bWf * bAmp * 0.18;  // inward sweep
      positionUpdated.y -= bF * bBob * birdFlap.y * (0.3 + 0.7 * bEnergy);   // body counter-bob (keeps a little life when gliding)
    #endif
  `;

  private static readonly WGSL = `
    #ifdef BIRD_FLAP
      var bEnergy = 1.0;
      #ifdef INSTANCESCOLOR
        bEnergy = clamp(vertexInputs.instanceColor.a, 0.0, 1.0);
      #endif
      let bWf  = smoothstep(0.10, 0.70, abs(positionUpdated.z));
      let bBob = 1.0 - smoothstep(0.05, 0.25, abs(positionUpdated.z));
      var bPh = 0.0;
      #ifdef INSTANCES
        bPh = (vertexInputs.world3.x + vertexInputs.world3.z) * 1.7;
      #endif
      let bT = uniforms.birdFlap.z * uniforms.birdFlap.w + bPh;
      let bF = sin(bT);
      let bAmp = uniforms.birdFlap.x * bEnergy;
      positionUpdated.y += bF * bWf * bAmp;
      positionUpdated.z -= sign(positionUpdated.z) * max(bF, 0.0) * bWf * bAmp * 0.18;
      positionUpdated.y -= bF * bBob * uniforms.birdFlap.y * (0.3 + 0.7 * bEnergy);
    #endif
  `;
}
