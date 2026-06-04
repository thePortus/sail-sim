import { TransformNode, Vector3 } from '@babylonjs/core';

/**
 * A patch of instances — an interchangeable rendering unit (thin-instanced or regular-instanced).
 *
 * Ported from Barthélemy Paléologue's "AssetScattering" (MIT, https://github.com/BarthPaleologue/AssetScattering).
 */
export interface IPatch {
  /** Disposes the instances + the cloned base mesh, but keeps the matrix buffer for re-use. */
  clearInstances(): void;
  /** Creates instances of a clone of baseMesh, positioned by the patch's matrix buffer. */
  createInstances(baseMesh: TransformNode): void;
  getNbInstances(): number;
  getPosition(): Vector3;
  dispose(): void;
}
