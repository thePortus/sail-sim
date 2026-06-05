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
    if (this.baseMesh === null) { return; }
    this.baseMesh.thinInstanceCount = 0;
    this.baseMesh.dispose();
    this.baseMesh = null;
  }

  createInstances(baseMesh: TransformNode, fraction = 1): void {
    this.clearInstances();
    if (!(baseMesh instanceof Mesh)) {
      throw new Error('ThinInstancePatch requires a Mesh base (use a HierarchyInstancePatch for TransformNodes).');
    }
    this.baseMesh = baseMesh.clone(baseMesh.name + '_patch');
    this.baseMesh.makeGeometryUnique();
    this.baseMesh.isVisible = true;
    this.baseMesh.thinInstanceSetBuffer('matrix', this.matrixBuffer, 16);
    if (this.colorBuffer) { this.baseMesh.thinInstanceSetBuffer('color', this.colorBuffer, 4); }
    // Distant LoD tiers render only a `fraction` of the (pre-shuffled) buffer — a uniform random
    // subsample — so far patches draw far fewer blades. setBuffer reset the count to the full size.
    if (fraction < 1) {
      const total = (this.matrixBuffer.length / 16) | 0;
      this.baseMesh.thinInstanceCount = Math.max(1, Math.floor(total * fraction));
    }
    // The instances live at world positions but the base mesh sits at the origin — refresh the
    // bounding info so it encloses the instances at their REAL world extents. This both stops the
    // patch being wrongly culled by the (offscreen) origin box AND gives it a correct box so the
    // frustum can cull it when it's off-screen — essential for perf, since otherwise the whole 360°
    // ring of patches around the camera draws every frame (only a ~90° wedge is ever visible).
    this.baseMesh.thinInstanceRefreshBoundingInfo(true);

    // A patch never moves once placed: its instances live at fixed world positions and the base mesh
    // itself stays at the origin. So skip the per-frame world-matrix recompute and bounding-info sync, and
    // take it out of picking — pure CPU savings across the hundreds of live patch meshes, no visual change.
    this.baseMesh.isPickable = false;
    this.baseMesh.doNotSyncBoundingInfo = true;
    this.baseMesh.freezeWorldMatrix();
  }

  getNbInstances(): number {
    return this.baseMesh === null ? 0 : this.baseMesh.thinInstanceCount;
  }

  getPosition(): Vector3 { return this.position; }

  dispose(): void {
    this.clearInstances();
    if (this.baseMesh !== null) { this.baseMesh.dispose(); }
  }
}
