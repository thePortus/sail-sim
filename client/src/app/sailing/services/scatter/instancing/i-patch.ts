import { TransformNode, Vector3 } from '@babylonjs/core';

/**
 * A patch of instances — an interchangeable rendering unit (thin-instanced or regular-instanced).
 *
 * Ported from Barthélemy Paléologue's "AssetScattering" (MIT, https://github.com/BarthPaleologue/AssetScattering).
 */
export interface IPatch {
  /** Disposes the instances + the cloned base mesh, but keeps the matrix buffer for re-use. */
  clearInstances(): void;
  /** Creates instances of a clone of baseMesh, positioned by the patch's matrix buffer. `fraction`
   *  (0..1) renders only that prefix of the (pre-shuffled) buffer — a uniform random subsample used
   *  to thin out distant LoD tiers.
   *
   *  `secondary` (optional) materializes a SECOND clone bound to the SAME instance buffers — used by the
   *  tree LoD cross-dissolve to render the impostor and full mesh together across the transition ring
   *  (each fades by distance via NearFadePlugin). Pass undefined to render a single LoD (and drop any
   *  secondary from a prior call). */
  createInstances(baseMesh: TransformNode, fraction?: number, secondary?: TransformNode): void;
  getNbInstances(): number;
  getPosition(): Vector3;
  /** Terrain-occlusion cull: hide/show this patch's draw mesh(es) when a ridge blocks line-of-sight from the
   *  camera. The flag is remembered so a later LoD-swap re-clone materializes in the correct enabled state. */
  setCulled(occluded: boolean): void;
  dispose(): void;
}
