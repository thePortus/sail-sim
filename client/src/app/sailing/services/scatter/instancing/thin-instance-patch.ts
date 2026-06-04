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

  constructor(patchPosition: Vector3, matrixBuffer: Float32Array) {
    this.position = patchPosition;
    this.matrixBuffer = matrixBuffer;
  }

  clearInstances(): void {
    if (this.baseMesh === null) { return; }
    this.baseMesh.thinInstanceCount = 0;
    this.baseMesh.dispose();
    this.baseMesh = null;
  }

  createInstances(baseMesh: TransformNode): void {
    this.clearInstances();
    if (!(baseMesh instanceof Mesh)) {
      throw new Error('ThinInstancePatch requires a Mesh base (use a HierarchyInstancePatch for TransformNodes).');
    }
    this.baseMesh = baseMesh.clone(baseMesh.name + '_patch');
    this.baseMesh.makeGeometryUnique();
    this.baseMesh.isVisible = true;
    this.baseMesh.thinInstanceSetBuffer('matrix', this.matrixBuffer, 16);
    // The instances live at world positions but the base mesh is at the origin — without refreshing
    // the bounding info, the mesh is frustum-culled by the (offscreen) origin box and NOTHING draws.
    this.baseMesh.thinInstanceRefreshBoundingInfo(true);
    this.baseMesh.alwaysSelectAsActiveMesh = true;   // belt-and-suspenders against culling
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
