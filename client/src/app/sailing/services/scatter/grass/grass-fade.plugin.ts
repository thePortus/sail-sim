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

  constructor(material: Material) {
    super(material, 'GrassFade', 210, { GRASS_FADE: true });
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
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const c = GrassFadePlugin.camera, f = GrassFadePlugin.fade, w = GrassFadePlugin.wind;
    uniformBuffer.updateFloat2('grassCam', c.x, c.z);
    uniformBuffer.updateFloat2('grassFade', f.start, f.end);
    uniformBuffer.updateFloat4('grassWind', w.dirX, w.dirZ, w.strength, w.time);
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
      // Wind sway — world wind projected into this blade's local axes (it's yaw-rotated), so all
      // blades lean the same way in world space. Bend grows toward the tip; per-blade phase desync.
      float gH = clamp(positionUpdated.y, 0.0, 1.0);
      float gBend = gH * gH;
      float gPhase = (world3.x + world3.z) * 0.25;
      float gT = grassWind.w;
      float gSway = sin(gT * 1.5 + gPhase) + 0.35 * sin(gT * 3.3 + gPhase * 1.7);
      float gAmt = grassWind.z * gBend * gSway;
      vec2 gWind = vec2(grassWind.x, grassWind.y);
      positionUpdated.x += dot(gWind, normalize(vec2(world0.x, world0.z))) * gAmt;
      positionUpdated.z += dot(gWind, normalize(vec2(world2.x, world2.z))) * gAmt;
      // Distance fade (after sway).
      float gFadeAmt = 1.0 - smoothstep(grassFade.x, grassFade.y, distance(vec2(world3.x, world3.z), grassCam));
      positionUpdated *= gFadeAmt;
    #endif
  `;

  private static readonly WGSL = `
    #ifdef INSTANCES
      let gH = clamp(positionUpdated.y, 0.0, 1.0);
      let gBend = gH * gH;
      let gPhase = (vertexInputs.world3.x + vertexInputs.world3.z) * 0.25;
      let gT = uniforms.grassWind.w;
      let gSway = sin(gT * 1.5 + gPhase) + 0.35 * sin(gT * 3.3 + gPhase * 1.7);
      let gAmt = uniforms.grassWind.z * gBend * gSway;
      let gWind = vec2f(uniforms.grassWind.x, uniforms.grassWind.y);
      positionUpdated.x += dot(gWind, normalize(vec2f(vertexInputs.world0.x, vertexInputs.world0.z))) * gAmt;
      positionUpdated.z += dot(gWind, normalize(vec2f(vertexInputs.world2.x, vertexInputs.world2.z))) * gAmt;
      let gFadeAmt = 1.0 - smoothstep(uniforms.grassFade.x, uniforms.grassFade.y, distance(vec2f(vertexInputs.world3.x, vertexInputs.world3.z), uniforms.grassCam));
      positionUpdated *= gFadeAmt;
    #endif
  `;
}
