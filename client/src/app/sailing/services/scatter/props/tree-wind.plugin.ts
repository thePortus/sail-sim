import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Tree wind — a vertex-displacement `MaterialPluginBase` for the authored broadleaf GLBs (beech now;
 * any branching tree later). Two motions, matching the asset's authored two-channel wind:
 *   - **Branch sway** — slow, whole-canopy horizontal lean in the world wind direction.
 *   - **Leaf flutter** (optional, `flutter=true`) — fast, small, multi-axis local shimmer on the
 *     canopy.
 *
 * The asset bakes the per-channel weights into COLOR_0 (R sway, G phase, B leaf flutter), but a plugin
 * can't read the colour attribute on WebGPU when useVertexColors=false (the WGSL `vertexInputs` struct
 * omits it). So both weights are derived from OBJECT-SPACE HEIGHT — trunk planted, canopy flexes — with
 * a per-leaf phase from vertex position and a per-tree phase from the instance world position. Reads
 * the thin-instance matrix columns under `#ifdef INSTANCES` so every tree leans the same way in world
 * space; full PBR lighting + baked domed-canopy normals are preserved (vertex-only). GLSL + WGSL.
 *
 * Drive it live via the static `WIND`.
 */
export class TreeWindPlugin extends MaterialPluginBase {
  /** Live wind, set each frame by ScatterService: unit XZ direction, branch + leaf amplitudes (m),
   *  base oscillation speed, wind clock (seconds). */
  static readonly WIND = { dirX: 0, dirZ: 1, branchAmp: 0.35, leafAmp: 0.10, speed: 1.1, time: 0 };

  private readonly swayStart: number;   // object-space height where sway begins (root)
  private readonly swayFull: number;    // …and where it reaches full (canopy / blade tip)
  private readonly ampScale: number;    // per-material multiplier on the shared branch/leaf amplitudes

  /** @param opts.flutter add the fast leaf-flutter term. swayStart/swayFull tune the height band the
   *  sway weight ramps over (beech ≈ 1.5→8 m; grass clumps ≈ 0→0.9 m). ampScale scales the shared
   *  amplitudes per material (grass sways less in absolute metres than a whole beech). */
  constructor(material: Material, opts: { flutter?: boolean; swayStart?: number; swayFull?: number; ampScale?: number } = {}) {
    const flutter = opts.flutter ?? false;
    super(material, 'TreeWind', 216, flutter ? { TREE_WIND: true, TREE_FLUTTER: true } : { TREE_WIND: true });
    this.swayStart = opts.swayStart ?? 1.5;
    this.swayFull = opts.swayFull ?? 8.0;
    this.ampScale = opts.ampScale ?? 1.0;
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'TreeWindPlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'treeWind', size: 4, type: 'vec4' },   // dirX, dirZ, branchAmp, time
      { name: 'treeLeaf', size: 2, type: 'vec2' },   // leafAmp, speed
      { name: 'treeBand', size: 2, type: 'vec2' },   // sway height band: start, full
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const w = TreeWindPlugin.WIND;
    uniformBuffer.updateFloat4('treeWind', w.dirX, w.dirZ, w.branchAmp * this.ampScale, w.time);
    uniformBuffer.updateFloat2('treeLeaf', w.leafAmp * this.ampScale, w.speed);
    uniformBuffer.updateFloat2('treeBand', this.swayStart, this.swayFull);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') { return null; }
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? TreeWindPlugin.WGSL : TreeWindPlugin.GLSL };
  }

  // treeWind = (dirX, dirZ, branchAmp, time); treeLeaf = (leafAmp, speed). Canopy weight = smoothstep
  // on object-space height (trunk planted → canopy flexes). Branch sway = world wind projected into the
  // tree's local axes. Leaf flutter = fast multi-axis local shimmer, canopy-weighted (TREE_FLUTTER).
  private static readonly GLSL = `
    #ifdef INSTANCES
    #ifdef TREE_WIND
      float tW     = smoothstep(treeBand.x, treeBand.y, positionUpdated.y);
      float tPhase = (positionUpdated.x - positionUpdated.z) * 0.5;
      float tTree  = (world3.x + world3.z) * 0.15;
      float tT     = treeWind.w * treeLeaf.y;
      float tSb    = sin(tT + tTree + tPhase) + 0.5 * sin(tT * 2.3 + tPhase * 1.7);
      float tAmt   = treeWind.z * tW * tSb;
      vec2  tWd = vec2(treeWind.x, treeWind.y);
      vec2  tA0 = vec2(world0.x, world0.z); float tL0 = length(tA0);
      vec2  tA2 = vec2(world2.x, world2.z); float tL2 = length(tA2);
      positionUpdated.x += dot(tWd, tL0 > 1e-4 ? tA0 / tL0 : vec2(1.0, 0.0)) * tAmt;
      positionUpdated.z += dot(tWd, tL2 > 1e-4 ? tA2 / tL2 : vec2(0.0, 1.0)) * tAmt;
      #ifdef TREE_FLUTTER
        float tf1 = sin(tT * 6.0 + tPhase * 3.0 + positionUpdated.y * 2.5);
        float tf2 = sin(tT * 7.3 + tPhase * 2.1 + positionUpdated.x * 2.5);
        positionUpdated.x += tf1 * tW * treeLeaf.x;
        positionUpdated.y += tf2 * tW * treeLeaf.x * 0.8;
        positionUpdated.z += tf1 * tW * treeLeaf.x * 0.9;
      #endif
    #endif
    #endif
  `;

  private static readonly WGSL = `
    #ifdef INSTANCES
    #ifdef TREE_WIND
      let tW     = smoothstep(uniforms.treeBand.x, uniforms.treeBand.y, positionUpdated.y);
      let tPhase = (positionUpdated.x - positionUpdated.z) * 0.5;
      let tTree  = (vertexInputs.world3.x + vertexInputs.world3.z) * 0.15;
      let tT     = uniforms.treeWind.w * uniforms.treeLeaf.y;
      let tSb    = sin(tT + tTree + tPhase) + 0.5 * sin(tT * 2.3 + tPhase * 1.7);
      let tAmt   = uniforms.treeWind.z * tW * tSb;
      let tWd = vec2f(uniforms.treeWind.x, uniforms.treeWind.y);
      let tA0 = vec2f(vertexInputs.world0.x, vertexInputs.world0.z); let tL0 = length(tA0);
      let tA2 = vec2f(vertexInputs.world2.x, vertexInputs.world2.z); let tL2 = length(tA2);
      positionUpdated.x += dot(tWd, select(vec2f(1.0, 0.0), tA0 / tL0, tL0 > 1e-4)) * tAmt;
      positionUpdated.z += dot(tWd, select(vec2f(0.0, 1.0), tA2 / tL2, tL2 > 1e-4)) * tAmt;
      #ifdef TREE_FLUTTER
        let tf1 = sin(tT * 6.0 + tPhase * 3.0 + positionUpdated.y * 2.5);
        let tf2 = sin(tT * 7.3 + tPhase * 2.1 + positionUpdated.x * 2.5);
        positionUpdated.x += tf1 * tW * uniforms.treeLeaf.x;
        positionUpdated.y += tf2 * tW * uniforms.treeLeaf.x * 0.8;
        positionUpdated.z += tf1 * tW * uniforms.treeLeaf.x * 0.9;
      #endif
    #endif
    #endif
  `;
}
