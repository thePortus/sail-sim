import {
  MaterialPluginBase, Material, UniformBuffer, Scene, AbstractEngine, SubMesh,
  ShaderLanguage, Nullable, Vector3, AbstractMesh,
} from '@babylonjs/core';

/**
 * Procedural sail billowing — a GPU vertex-displacement plugin attached to each sail's PBRMaterial.
 * It bows the sail into a WIND-DIRECTION-CORRECT belly (bulges to leeward, flips on the other tack)
 * plus a gentle breathe, preserving the baked PBR shading. Injects at CUSTOM_VERTEX_UPDATE_POSITION
 * (after the Furl morph, before skinning) so it composes with both. Emits WGSL + GLSL.
 *
 * Matches the native sail-billow model (gltf_rig synthesizeSailBillow + vessel_anim driveBillow):
 * the belly pushes along the sail-plane normal, SIGNED by leeward = dot(downwind, sail world-normal).
 * So a square sail billows forward/leeward, a fore-and-aft sail flips its belly with the tack, and a
 * sail lying edge-on to the wind (luffing) gets dot≈0 → goes flat. Wind is scene-global; the belly
 * DIRECTION is per-sail, so it's read per draw from the rendering mesh (the material is shared).
 */
interface SailCache { min: Vector3; ext: Vector3; normal: Vector3; depth: number; }
const sailCache = new WeakMap<AbstractMesh, SailCache>();
const _tmpN = new Vector3();

export class SailBillowPlugin extends MaterialPluginBase {
  /** Global wind, set each frame by vessel.service: strength (0..~1.2), time (s), and the WORLD
   *  downwind unit vector (where the wind blows TOWARD; bearing→(sin,cos) so x=E, z=N). */
  static readonly wind = { strength: 0, time: 0, dirX: 0, dirZ: 1 };

  rippleAmp  = 0.02;   // gentle breathe amplitude (m) at full wind (was a busy 3-wave flutter)
  rippleFreq = 0.9;    // slow undulation (breathe, not flutter)

  constructor(material: Material) {
    super(material, 'SailBillow', 200, { SAIL_BILLOW: true });
    this._enable(true);
  }

  /** Kept for call-site compatibility (the controller calls it at setup); per-sail geometry is now
   *  derived per-draw in bindForSubMesh, since one shared material serves every sail. */
  configure(_min: Vector3, _max: Vector3): void { /* no-op */ }

  override isCompatible(): boolean { return true; }            // GLSL + WGSL
  override getClassName(): string { return 'SailBillowPlugin'; }

  override getUniforms() {
    return {
      ubo: [
        { name: 'sailWindStrength', size: 1, type: 'float' },
        { name: 'sailTime',         size: 1, type: 'float' },
        { name: 'sailSet',          size: 1, type: 'float' },
        { name: 'sailLee',          size: 1, type: 'float' },   // signed leeward factor (−1..+1); 0 = luffing/flat
        { name: 'sailBellyDepth',   size: 1, type: 'float' },
        { name: 'sailRipple',       size: 2, type: 'vec2'  },
        { name: 'sailBBMin',        size: 3, type: 'vec3'  },
        { name: 'sailBBExt',        size: 3, type: 'vec3'  },
      ],
    };
  }

  /** Local bbox → plane normal (thinnest axis) + realistic belly depth (~11% of chord). Cached per
   *  mesh; the geometry never changes, only the per-frame world orientation does. */
  private cacheFor(mesh: AbstractMesh): SailCache {
    let c = sailCache.get(mesh);
    if (c) return c;
    const bb = mesh.getBoundingInfo().boundingBox;
    const min = bb.minimum.clone(), ext = bb.maximum.subtract(bb.minimum);
    const e = [ext.x, ext.y, ext.z];
    let thin = 0; if (e[1] < e[thin]) thin = 1; if (e[2] < e[thin]) thin = 2;
    const a1 = (thin + 1) % 3, a2 = (thin + 2) % 3;
    const normal = new Vector3(thin === 0 ? 1 : 0, thin === 1 ? 1 : 0, thin === 2 ? 1 : 0);
    const depth = 0.11 * Math.min(e[a1], e[a2]);          // realistic working-sail belly
    c = { min, ext, normal, depth };
    sailCache.set(mesh, c);
    return c;
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const w = SailBillowPlugin.wind;
    const mesh = subMesh.getRenderingMesh();
    const c = this.cacheFor(mesh);
    // Sail-plane normal in WORLD space → its horizontal projection dotted with the downwind vector
    // gives the signed leeward factor (which face bellies, and how squarely the wind fills the sail).
    Vector3.TransformNormalToRef(c.normal, mesh.getWorldMatrix(), _tmpN);
    _tmpN.y = 0;
    const len = Math.hypot(_tmpN.x, _tmpN.z);
    const lee = len > 1e-4 ? Math.max(-1, Math.min(1, (_tmpN.x * w.dirX + _tmpN.z * w.dirZ) / len)) : 0;
    // Per-draw: this sail mesh's own furl → billow scales with canvas out (1 = set, 0 = furled).
    const mgr = (mesh as { morphTargetManager?: { getTarget(i: number): { influence: number } | null } }).morphTargetManager;
    const furl = mgr?.getTarget(0)?.influence ?? 0;
    uniformBuffer.updateFloat('sailWindStrength', w.strength);
    uniformBuffer.updateFloat('sailTime', w.time);
    uniformBuffer.updateFloat('sailSet', Math.max(0, 1 - furl));
    uniformBuffer.updateFloat('sailLee', lee);
    uniformBuffer.updateFloat('sailBellyDepth', c.depth);
    uniformBuffer.updateFloat2('sailRipple', this.rippleAmp, this.rippleFreq);
    uniformBuffer.updateFloat3('sailBBMin', c.min.x, c.min.y, c.min.z);
    uniformBuffer.updateFloat3('sailBBExt', c.ext.x, c.ext.y, c.ext.z);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'vertex') return null;
    return { CUSTOM_VERTEX_UPDATE_POSITION:
      shaderLanguage === ShaderLanguage.WGSL ? SailBillowPlugin.WGSL : SailBillowPlugin.GLSL };
  }

  // Belly mask: 4·t·(1−t) per axis (≈0 at the sail's edges, max in the belly). The steady belly is
  // pushed along the sail normal, SIGNED by sailLee so it bulges to leeward and flips on the other
  // tack; scaled by wind response × canvas-out. A single slow wave adds a gentle breathe. The normal
  // is tilted by the breathe slope so the moving cloth catches the light.
  private static readonly GLSL = `
    vec3 sbExt = max(sailBBExt, vec3(0.001));
    vec3 sbT = clamp((positionUpdated - sailBBMin) / sbExt, 0.0, 1.0);
    float sbBelly = (4.0*sbT.x*(1.0-sbT.x)) * (4.0*sbT.y*(1.0-sbT.y)) * (4.0*sbT.z*(1.0-sbT.z));
    float sbW = pow(sailWindStrength, 1.6) * sailSet;   // near-still in calm, fills as wind builds
    float sbPush = sbBelly * sailBellyDepth * sbW * sailLee;   // signed by leeward
    float sbPh = sailTime * sailRipple.y;
    vec3 sbK = vec3(4.0, 3.0, 5.0);
    float sbP = dot(positionUpdated, sbK) + sbPh;
    float sbRip = sin(sbP);
    float sbAmt = sailRipple.x * sbBelly * sbW;   // gentle breathe, only in the belly
    positionUpdated += normalUpdated * (sbPush + sbRip * sbAmt);
    normalUpdated = normalize(normalUpdated - (cos(sbP) * sbAmt) * sbK * 0.3);
  `;

  private static readonly WGSL = `
    let sbExt = max(uniforms.sailBBExt, vec3f(0.001));
    let sbT = clamp((positionUpdated - uniforms.sailBBMin) / sbExt, vec3f(0.0), vec3f(1.0));
    let sbBelly = (4.0*sbT.x*(1.0-sbT.x)) * (4.0*sbT.y*(1.0-sbT.y)) * (4.0*sbT.z*(1.0-sbT.z));
    let sbW = pow(uniforms.sailWindStrength, 1.6) * uniforms.sailSet;
    let sbPush = sbBelly * uniforms.sailBellyDepth * sbW * uniforms.sailLee;
    let sbPh = uniforms.sailTime * uniforms.sailRipple.y;
    let sbK = vec3f(4.0, 3.0, 5.0);
    let sbP = dot(positionUpdated, sbK) + sbPh;
    let sbRip = sin(sbP);
    let sbAmt = uniforms.sailRipple.x * sbBelly * sbW;
    positionUpdated += normalUpdated * (sbPush + sbRip * sbAmt);
    normalUpdated = normalize(normalUpdated - (cos(sbP) * sbAmt) * sbK * 0.3);
  `;
}
