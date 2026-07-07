import { Mesh, TransformNode, Vector3 } from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { IPatch } from './i-patch';

/**
 * A patch rendered with THIN instances — one draw call for all instances (fastest; no per-instance
 * collisions). Ported from Barthélemy Paléologue's "AssetScattering" (MIT).
 *
 * The matrix buffer is a flat Float32Array of N × 16 (column-major mat4 per instance).
 */
export class ThinInstancePatch implements IPatch {
  private baseMesh: Mesh | null = null;
  /** Optional SECOND clone (cross-dissolve ring) sharing this patch's matrix/colour buffers — see IPatch. */
  private secondaryMesh: Mesh | null = null;
  /** Terrain-occlusion state (see setCulled); re-applied to any freshly-cloned mesh in makeClone. */
  private culled = false;
  private readonly position: Vector3;
  readonly matrixBuffer: Float32Array;
  /** Optional per-instance colour buffer (N × 4 RGBA) — e.g. rock colour variation. */
  private readonly colorBuffer: Float32Array | null;

  constructor(patchPosition: Vector3, matrixBuffer: Float32Array, colorBuffer: Float32Array | null = null) {
    this.position = patchPosition;
    this.matrixBuffer = matrixBuffer;
    this.colorBuffer = colorBuffer;
  }

  clearInstances(): void {
    for (const m of [this.baseMesh, this.secondaryMesh]) {
      if (m) { m.thinInstanceCount = 0; m.dispose(); }
    }
    this.baseMesh = null;
    this.secondaryMesh = null;
  }

  createInstances(baseMesh: TransformNode, fraction = 1, secondary?: TransformNode): void {
    this.clearInstances();
    if (!(baseMesh instanceof Mesh)) {
      throw new Error('ThinInstancePatch requires a Mesh base (use a HierarchyInstancePatch for TransformNodes).');
    }
    this.baseMesh = this.makeClone(baseMesh, fraction);
    if (secondary instanceof Mesh) { this.secondaryMesh = this.makeClone(secondary, fraction); }
  }

  /** Clone a base LoD mesh and bind it to this patch's shared matrix/colour buffers. Both the primary and
   *  the cross-dissolve secondary go through here. */
  private makeClone(base: Mesh, fraction: number): Mesh {
    const mesh = base.clone(base.name + '_patch');
    mesh.makeGeometryUnique();
    mesh.isVisible = true;
    mesh.thinInstanceSetBuffer('matrix', this.matrixBuffer, 16);
    if (this.colorBuffer) { mesh.thinInstanceSetBuffer('color', this.colorBuffer, 4); }
    // Distant LoD tiers render only a `fraction` of the (pre-shuffled) buffer — a uniform random
    // subsample — so far patches draw far fewer blades. setBuffer reset the count to the full size.
    if (fraction < 1) {
      const total = (this.matrixBuffer.length / 16) | 0;
      mesh.thinInstanceCount = Math.max(1, Math.floor(total * fraction));
    }
    // The instances live at world positions but the base mesh sits at the origin — refresh the
    // bounding info so it encloses the instances at their REAL world extents. This both stops the
    // patch being wrongly culled by the (offscreen) origin box AND gives it a correct box so the
    // frustum can cull it when it's off-screen — essential for perf, since otherwise the whole 360°
    // ring of patches around the camera draws every frame (only a ~90° wedge is ever visible).
    mesh.thinInstanceRefreshBoundingInfo(true);

    // A patch never moves once placed: its instances live at fixed world positions and the base mesh
    // itself stays at the origin. So skip the per-frame world-matrix recompute and bounding-info sync, and
    // take it out of picking — pure CPU savings across the hundreds of live patch meshes, no visual change.
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.freezeWorldMatrix();
    if (this.culled) { mesh.setEnabled(false); }   // re-materialized while occluded → stay hidden until re-tested
    return mesh;
  }

  setCulled(occluded: boolean): void {
    if (occluded === this.culled) { return; }
    this.culled = occluded;
    const on = !occluded;
    if (this.baseMesh) { this.baseMesh.setEnabled(on); }
    if (this.secondaryMesh) { this.secondaryMesh.setEnabled(on); }
  }

  getNbInstances(): number {
    return this.baseMesh === null ? 0 : this.baseMesh.thinInstanceCount;
  }

  getPosition(): Vector3 { return this.position; }

  dispose(): void {
    this.clearInstances();
  }
}
