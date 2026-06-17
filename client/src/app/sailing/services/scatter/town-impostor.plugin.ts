import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Vertex plugin for the distant-town BUILDING IMPOSTORS: turns each thin-instanced quad into a camera-facing,
 * upright BILLBOARD (so a single baked 3/4 view reads from any heading) AND fades it within a distance BAND so
 * the layer only shows in the mid-distance: hidden up close (real streamed buildings own that), grown to full
 * past the mesh-drop range, and collapsed back into its base point beyond the far cutoff (the "~3-5 km" town
 * visibility). Out-of-band instances shrink to a degenerate zero-area quad → no fragments, ~free.
 *
 * Injects at CUSTOM_VERTEX_UPDATE_POSITION. Each instance's world position is world3 (the thin-instance matrix
 * translation, like FarFadePlugin); the quad corner is the local position (x = ±halfWidth, y = 0..height baked
 * base-at-0). Billboard basis: world up + a per-frame camera-right uniform (cylindrical, no tilt). GLSL + WGSL.
 */
export class TownImpostorPlugin extends MaterialPluginBase {
  /** Live camera XZ + horizontal right vector, set each frame by the town-impostor layer. */
  static readonly cam = { x: 0, z: 0, rx: 1, rz: 0 };
  /** Fade band (m): grows 0→full over [nearStart,nearFull]; full→0 over [farStart,farEnd]. nearFull sits just
   *  past the real-mesh DROP_RANGE (800 m) so impostors reach full as the 3-D buildings drop — no gap. */
  static readonly band = { nearStart: 600, nearFull: 850, farStart: 4200, farEnd: 5200 };

  constructor(material: Material) {
    super(material, 'TownImpostor', 210, { TOWN_IMPOSTOR: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }
  override getClassName(): string { return 'TownImpostorPlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'tiCam',  size: 4, type: 'vec4' },   // (camX, camZ, rightX, rightZ)
      { name: 'tiBand', size: 4, type: 'vec4' },   // (nearStart, nearFull, farStart, farEnd)
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const c = TownImpostorPlugin.cam, b = TownImpostorPlugin.band;
    uniformBuffer.updateFloat4('tiCam', c.x, c.z, c.rx, c.rz);
    uniformBuffer.updateFloat4('tiBand', b.nearStart, b.nearFull, b.farStart, b.farEnd);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') return null;
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? TownImpostorPlugin.WGSL : TownImpostorPlugin.GLSL };
  }

  private static readonly GLSL = `
    #ifdef INSTANCES
      vec2 tiRight = vec2(tiCam.z, tiCam.w);
      // Camera-facing upright billboard: horizontal along the camera-right vector, vertical = world up.
      vec3 tiPos = vec3(tiRight.x * positionUpdated.x, positionUpdated.y, tiRight.y * positionUpdated.x);
      // Distance band: in near where real meshes hand off, out past the far cutoff.
      float tiD = distance(vec2(world3.x, world3.z), tiCam.xy);
      float tiF = smoothstep(tiBand.x, tiBand.y, tiD) * (1.0 - smoothstep(tiBand.z, tiBand.w, tiD));
      positionUpdated = tiPos * tiF;
    #endif
  `;

  private static readonly WGSL = `
    #ifdef INSTANCES
      let tiRight = vec2f(uniforms.tiCam.z, uniforms.tiCam.w);
      var tiPos = vec3f(tiRight.x * positionUpdated.x, positionUpdated.y, tiRight.y * positionUpdated.x);
      let tiD = distance(vec2f(vertexInputs.world3.x, vertexInputs.world3.z), uniforms.tiCam.xy);
      let tiF = smoothstep(uniforms.tiBand.x, uniforms.tiBand.y, tiD) * (1.0 - smoothstep(uniforms.tiBand.z, uniforms.tiBand.w, tiD));
      positionUpdated = tiPos * tiF;
    #endif
  `;
}
