import { Mesh, TransformNode } from '@babylonjs/core';
import { IPatch } from './i-patch';

/**
 * Manages a set of patches that share a base mesh with multiple LoD levels. Each frame `update()`
 * recomputes each patch's LoD (cheap) and swaps a rate-limited number of patches to their new LoD
 * mesh (the expensive thin-instance rebuild), so LoD transitions don't cause frame spikes.
 *
 * Ported from Barthélemy Paléologue's "AssetScattering" (MIT).
 *
 * @param meshesFromLod  base meshes, index 0 = lowest detail … last = highest detail.
 * @param computeLodLevel returns the LoD index for a patch (e.g. by distance to camera).
 */
export class PatchManager {
  private readonly meshesFromLod: TransformNode[];
  private readonly lodFractions: number[];
  private readonly patches: [IPatch, number][] = [];
  private readonly queue: Array<{ newLOD: number; patch: IPatch }> = [];
  private readonly computeLodLevel: (patch: IPatch) => number;
  private patchUpdateRate = 1;
  private _lodTick = 0;
  /** Re-evaluate distance-based LoD only every Nth frame — a few frames of swap lag is invisible, and the
   *  per-patch distance scan was running every frame for every layer. */
  private readonly lodEvalEvery = 4;

  /** @param lodFractions per-LoD instance fraction (0..1) — thins distant tiers. Defaults to all 1. */
  constructor(meshesFromLod: Mesh[], computeLodLevel: (patch: IPatch) => number = () => 0, lodFractions?: number[]) {
    this.meshesFromLod = meshesFromLod;
    this.computeLodLevel = computeLodLevel;
    this.lodFractions = lodFractions ?? meshesFromLod.map(() => 1);
  }

  addPatch(patch: IPatch): void {
    const lod = this.computeLodLevel(patch);
    this.patches.push([patch, lod]);
    this.queue.push({ newLOD: lod, patch });
  }

  addPatches(patches: IPatch[]): void {
    for (const patch of patches) { this.addPatch(patch); }
  }

  removePatch(patch: IPatch): void {
    const index = this.patches.findIndex((p) => p[0] === patch);
    if (index !== -1) { this.patches.splice(index, 1); }
    const qi = this.queue.findIndex((p) => p.patch === patch);
    if (qi !== -1) { this.queue.splice(qi, 1); }
  }

  update(): void {
    this.reevaluateLod();
    this.drainQueue(this.patchUpdateRate);
  }

  /** Re-scan patch distances and queue any LoD changes (multi-LoD layers only, every Nth frame).
   *  Split out from the queue drain so the (GPU-heavy) drain can run on a budget shared across ALL
   *  layers — otherwise N layers each draining independently spikes into N× geometry clones per frame. */
  reevaluateLod(): void {
    if (this.meshesFromLod.length > 1 && (this._lodTick++ % this.lodEvalEvery) === 0) {
      for (let i = 0; i < this.patches.length; i++) {
        const [patch, patchLod] = this.patches[i];
        const newLod = this.computeLodLevel(patch);
        if (newLod === patchLod) { continue; }
        this.queue.push({ newLOD: newLod, patch });
        this.patches[i] = [patch, newLod];
      }
    }
  }

  /** Commit up to `n` queued patches (the expensive clone + thin-instance-buffer upload). Returns how
   *  many it actually committed, so a caller can spread a global budget across layers round-robin. */
  drainQueue(n: number): number {
    let done = 0;
    for (let i = 0; i < n; i++) {
      const head = this.queue.shift();
      if (head === undefined) { break; }
      head.patch.createInstances(this.meshesFromLod[head.newLOD], this.lodFractions[head.newLOD]);
      done++;
    }
    return done;
  }

  /** Number of patches awaiting a (GPU) commit. */
  get pendingCommits(): number { return this.queue.length; }

  /** Build all queued instances immediately (e.g. after the initial patch set is added). */
  initInstances(): void { this.drainQueue(this.queue.length); }

  setLodUpdateCadence(cadence: number): void { this.patchUpdateRate = cadence; }

  getNbInstances(): number {
    let count = 0;
    for (const [patch] of this.patches) { count += patch.getNbInstances(); }
    return count;
  }

  dispose(): void {
    for (const [patch] of this.patches) { patch.dispose(); }
    this.patches.length = 0;
    this.queue.length = 0;
  }
}
