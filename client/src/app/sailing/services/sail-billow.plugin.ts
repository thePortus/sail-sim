import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable, Vector3,
} from '@babylonjs/core';

/**
 * Procedural sail billowing — a GPU vertex-displacement plugin attached to each sail's
 * PBRMaterial. It bows the sail into a wind-driven belly and adds a traveling ripple,
 * preserving the baked PBR shading. Injects at CUSTOM_VERTEX_UPDATE_POSITION (after the
 * Furl morph, before skinning) so it composes correctly with both. Emits WGSL (WebGPU)
 * and GLSL (WebGL).
 *
 * Wind is global, so it lives in a static updated once per frame by SloopController. Furl
 * is per-vessel/per-sail, so it's read per draw in bindForSubMesh from the rendering mesh's
 * own morph influence — correct even though the material is shared across vessels.
 */
export class SailBillowPlugin extends MaterialPluginBase {
  /** Global wind state, set each frame by SloopController.idleWind (wind is scene-wide). */
  static readonly wind = { strength: 0, time: 0 };

  // ── Per-sail tuning (lively & wind-reactive defaults; tweak to taste) ──────
  // Belly depth in metres at full wind; negative flips the bow side (leeward vs windward).
  bellyDepth = 0.4;
  rippleAmp  = 0.035;  // per-wave ripple amplitude (m) at full wind (3 waves stack)
  rippleFreq = 7.0;    // ripple temporal frequency (flutter speed)

  // Object-space bounding box of this sail mesh (for the belly mask). Set via configure().
  private bbMin = new Vector3(-1, -1, -1);
  private bbExt = new Vector3(2, 2, 2);

  constructor(material: Material) {
    super(material, 'SailBillow', 200, { SAIL_BILLOW: true });
    this._enable(true);
  }

  /** Provide the sail mesh's local bounding box so the shader can build the belly mask. */
  configure(min: Vector3, max: Vector3): void {
    this.bbMin.copyFrom(min);
    this.bbExt.copyFrom(max).subtractInPlace(min);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'SailBillowPlugin'; }

  override getUniforms() {
    return {
      ubo: [
        { name: 'sailWindStrength', size: 1, type: 'float' },
        { name: 'sailTime',         size: 1, type: 'float' },
        { name: 'sailSet',          size: 1, type: 'float' },
        { name: 'sailBellyDepth',   size: 1, type: 'float' },
        { name: 'sailRipple',       size: 2, type: 'vec2'  },
        { name: 'sailBBMin',        size: 3, type: 'vec3'  },
        { name: 'sailBBExt',        size: 3, type: 'vec3'  },
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const w = SailBillowPlugin.wind;
    uniformBuffer.updateFloat('sailWindStrength', w.strength);
    uniformBuffer.updateFloat('sailTime', w.time);
    // Per-draw: this sail mesh's own furl → billow scales with canvas out (1=set, 0=furled).
    const mgr = (subMesh.getRenderingMesh() as { morphTargetManager?: { getTarget(i: number): { influence: number } | null } }).morphTargetManager;
    const furl = mgr?.getTarget(0)?.influence ?? 0;
    uniformBuffer.updateFloat('sailSet', Math.max(0, 1 - furl));
    uniformBuffer.updateFloat('sailBellyDepth', this.bellyDepth);
    uniformBuffer.updateFloat2('sailRipple', this.rippleAmp, this.rippleFreq);
    uniformBuffer.updateFloat3('sailBBMin', this.bbMin.x, this.bbMin.y, this.bbMin.z);
    uniformBuffer.updateFloat3('sailBBExt', this.bbExt.x, this.bbExt.y, this.bbExt.z);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') return null;
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? SailBillowPlugin.WGSL : SailBillowPlugin.GLSL };
  }

  // Belly mask: 4·t·(1−t) per axis (≈0 at the sail's edges, max in the belly). Steady belly
  // curve + THREE higher-frequency traveling waves (small, busy ripples), all scaled by wind
  // × canvas-out. The surface normal is tilted by the analytic wave SLOPE so the ripples
  // catch the light (without this, the displaced cloth still shades flat and looks uniform).
  private static readonly GLSL = `
    vec3 sbExt = max(sailBBExt, vec3(0.001));
    vec3 sbT = clamp((positionUpdated - sailBBMin) / sbExt, 0.0, 1.0);
    float sbBelly = (4.0*sbT.x*(1.0-sbT.x)) * (4.0*sbT.y*(1.0-sbT.y)) * (4.0*sbT.z*(1.0-sbT.z));
    float sbW = pow(sailWindStrength, 2.2) * sailSet;   // wind-response curve: near-still in calm, lively as wind builds
    float sbPush = sbBelly * sailBellyDepth * sbW;
    float sbPh = sailTime * sailRipple.y;
    vec3 sbK1 = vec3( 7.0,  5.0,  6.0);
    vec3 sbK2 = vec3(-5.0,  9.0,  4.0);
    vec3 sbK3 = vec3( 6.0, -4.0, 11.0);
    float sbP1 = dot(positionUpdated, sbK1) + sbPh;
    float sbP2 = dot(positionUpdated, sbK2) - sbPh * 1.3;
    float sbP3 = dot(positionUpdated, sbK3) + sbPh * 0.7;
    float sbRip  = sin(sbP1)*0.5 + sin(sbP2)*0.35 + sin(sbP3)*0.25;
    vec3  sbGrad = cos(sbP1)*0.5*sbK1 + cos(sbP2)*0.35*sbK2 + cos(sbP3)*0.25*sbK3;
    float sbAmt = sailRipple.x * mix(0.45, 1.0, sbBelly) * sbW;   // ripples reach the edges, not just the belly
    positionUpdated += normalUpdated * (sbPush + sbRip * sbAmt);
    normalUpdated = normalize(normalUpdated - sbGrad * sbAmt * 0.4);
  `;

  private static readonly WGSL = `
    let sbExt = max(uniforms.sailBBExt, vec3f(0.001));
    let sbT = clamp((positionUpdated - uniforms.sailBBMin) / sbExt, vec3f(0.0), vec3f(1.0));
    let sbBelly = (4.0*sbT.x*(1.0-sbT.x)) * (4.0*sbT.y*(1.0-sbT.y)) * (4.0*sbT.z*(1.0-sbT.z));
    let sbW = pow(uniforms.sailWindStrength, 2.2) * uniforms.sailSet;   // wind-response curve: near-still in calm, lively as wind builds
    let sbPush = sbBelly * uniforms.sailBellyDepth * sbW;
    let sbPh = uniforms.sailTime * uniforms.sailRipple.y;
    let sbK1 = vec3f( 7.0,  5.0,  6.0);
    let sbK2 = vec3f(-5.0,  9.0,  4.0);
    let sbK3 = vec3f( 6.0, -4.0, 11.0);
    let sbP1 = dot(positionUpdated, sbK1) + sbPh;
    let sbP2 = dot(positionUpdated, sbK2) - sbPh * 1.3;
    let sbP3 = dot(positionUpdated, sbK3) + sbPh * 0.7;
    let sbRip  = sin(sbP1)*0.5 + sin(sbP2)*0.35 + sin(sbP3)*0.25;
    let sbGrad = (cos(sbP1)*0.5)*sbK1 + (cos(sbP2)*0.35)*sbK2 + (cos(sbP3)*0.25)*sbK3;
    let sbAmt = uniforms.sailRipple.x * mix(0.45, 1.0, sbBelly) * sbW;
    positionUpdated += normalUpdated * (sbPush + sbRip * sbAmt);
    normalUpdated = normalize(normalUpdated - sbGrad * (sbAmt * 0.4));
  `;
}
