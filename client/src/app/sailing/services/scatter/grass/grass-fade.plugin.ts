import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Vertex plugin for the camera-following grass patches — handles BOTH wind sway and the draw-radius
 * dissolve, in one injected block so they compose cleanly.
 *
 * - Wind sway: bends each blade in the world wind direction, scaling toward the tip (base planted),
 *   with a per-blade phase so they don't all wave in unison. Because instances are yaw-rotated, the
 *   world wind is projected into each blade's own axes (its thin-instance matrix columns) so they
 *   all lean the same way in world space.
 * - Distance fade: the patch grid ends in a hard ring at the draw radius; this shrinks each blade to
 *   nothing as it nears that radius (per-frame from the live camera position, so it's stable as the
 *   camera moves — blades dissolve at the far edge and grow back as you approach).
 *
 * Attaches to the grass StandardMaterial. Injects at CUSTOM_VERTEX_UPDATE_POSITION. Uses the raw
 * thin-instance matrix attributes (world0/world2 = local axes, world3 = world position) under
 * `#ifdef INSTANCES` — NOT `finalWorld`, which isn't in scope here on every StandardMaterial variant
 * (referencing it black-screens the scene). Emits WGSL (WebGPU) and GLSL (WebGL).
 */
export class GrassFadePlugin extends MaterialPluginBase {
  /** Live camera XZ, set each frame by ScatterService (the grass material is scene-wide). */
  static readonly camera = { x: 0, z: 0 };
  /** Fade band in metres: full size up to `start`, shrunk to zero by `end`. */
  static readonly fade = { start: 220, end: 320 };
  /** Live wind, set each frame by ScatterService: unit XZ direction, sway amplitude (m), elapsed s. */
  static readonly wind = { dirX: 0, dirZ: 1, strength: 0.08, time: 0 };

  /** Per-material sway multiplier — e.g. seaweed undulates more (in a "current") than stiff grass.
   *  0 disables wind entirely (rocks): the whole sway block is then compiled out of the shader. */
  private readonly swayMul: number;
  /** This material's draw-radius fade band (by REFERENCE so live updates flow through). Defaults to the shared
   *  grass band; layers with a DIFFERENT draw radius (e.g. palms reach ~320 m vs grass ~180 m) pass their own. */
  private readonly _fade: { start: number; end: number };

  constructor(material: Material, swayMul = 1, fade: { start: number; end: number } = GrassFadePlugin.fade) {
    // GRASS_WIND gates the per-vertex sway maths — omitted when swayMul is 0 so static props (rocks)
    // don't pay for wind they never use.
    super(material, 'GrassFade', 210, swayMul > 0 ? { GRASS_FADE: true, GRASS_WIND: true } : { GRASS_FADE: true });
    this.swayMul = swayMul;
    this._fade = fade;
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'GrassFadePlugin'; }

  override getUniforms() {
    return {
      ubo: [
        { name: 'grassCam',  size: 2, type: 'vec2' },
        { name: 'grassFade', size: 2, type: 'vec2' },
        { name: 'grassWind', size: 4, type: 'vec4' },
        { name: 'grassSway', size: 1, type: 'float' },
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const c = GrassFadePlugin.camera, f = this._fade, w = GrassFadePlugin.wind;
    uniformBuffer.updateFloat2('grassCam', c.x, c.z);
    uniformBuffer.updateFloat2('grassFade', f.start, f.end);
    uniformBuffer.updateFloat4('grassWind', w.dirX, w.dirZ, w.strength, w.time);
    uniformBuffer.updateFloat('grassSway', this.swayMul);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') return null;
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? GrassFadePlugin.WGSL : GrassFadePlugin.GLSL };
  }

  // Blades are modelled base-at-origin (y=0) to tip (y=1). Wind bends the blade (scaled by height²
  // so the base stays planted), then the fade scales the whole object-space position toward 0 so the
  // blade collapses into its own base (sinks into the ground) — a clean dissolve, not a pop.
  private static readonly GLSL = `
    #ifdef INSTANCES
      #ifdef GRASS_WIND
        // Wind sway — world wind projected into this blade's local axes (it's yaw-rotated), so all
        // blades lean the same way in world space. Bend grows toward the tip; per-blade phase desync.
        float gH = clamp(positionUpdated.y, 0.0, 1.0);
        float gBend = gH * gH;
        float gPhase = (world3.x + world3.z) * 0.25;
        float gT = grassWind.w;
        float gSway = sin(gT * 1.5 + gPhase) + 0.35 * sin(gT * 3.3 + gPhase * 1.7);
        float gAmt = grassWind.z * grassSway * gBend * gSway;
        vec2 gWind = vec2(grassWind.x, grassWind.y);
        // Guard the axis normalize against zero-length axes — a NaN here would discard the instance.
        vec2 gA0 = vec2(world0.x, world0.z); float gL0 = length(gA0);
        vec2 gA2 = vec2(world2.x, world2.z); float gL2 = length(gA2);
        positionUpdated.x += dot(gWind, gL0 > 1e-4 ? gA0 / gL0 : vec2(1.0, 0.0)) * gAmt;
        positionUpdated.z += dot(gWind, gL2 > 1e-4 ? gA2 / gL2 : vec2(0.0, 1.0)) * gAmt;
      #endif
      // Distance fade (after any sway).
      float gFadeAmt = 1.0 - smoothstep(grassFade.x, grassFade.y, distance(vec2(world3.x, world3.z), grassCam));
      positionUpdated *= gFadeAmt;
    #endif
  `;

  private static readonly WGSL = `
    #ifdef INSTANCES
      #ifdef GRASS_WIND
        let gH = clamp(positionUpdated.y, 0.0, 1.0);
        let gBend = gH * gH;
        let gPhase = (vertexInputs.world3.x + vertexInputs.world3.z) * 0.25;
        let gT = uniforms.grassWind.w;
        let gSway = sin(gT * 1.5 + gPhase) + 0.35 * sin(gT * 3.3 + gPhase * 1.7);
        let gAmt = uniforms.grassWind.z * uniforms.grassSway * gBend * gSway;
        let gWind = vec2f(uniforms.grassWind.x, uniforms.grassWind.y);
        // Guard the axis normalize against zero-length axes.
        let gA0 = vec2f(vertexInputs.world0.x, vertexInputs.world0.z); let gL0 = length(gA0);
        let gA2 = vec2f(vertexInputs.world2.x, vertexInputs.world2.z); let gL2 = length(gA2);
        positionUpdated.x += dot(gWind, select(vec2f(1.0, 0.0), gA0 / gL0, gL0 > 1e-4)) * gAmt;
        positionUpdated.z += dot(gWind, select(vec2f(0.0, 1.0), gA2 / gL2, gL2 > 1e-4)) * gAmt;
      #endif
      let gFadeAmt = 1.0 - smoothstep(uniforms.grassFade.x, uniforms.grassFade.y, distance(vec2f(vertexInputs.world3.x, vertexInputs.world3.z), uniforms.grassCam));
      positionUpdated *= gFadeAmt;
    #endif
  `;
}
