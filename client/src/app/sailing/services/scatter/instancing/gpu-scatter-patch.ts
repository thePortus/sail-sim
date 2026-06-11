import {
  Mesh, TransformNode, Vector3, BoundingInfo,
  Buffer as BabylonBuffer, StorageBuffer, Constants, WebGPUEngine,
} from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { IPatch } from './i-patch';

/**
 * A scatter patch whose instance matrices/colours live ONLY on the GPU (WebGPU-compute roadmap P3).
 *
 * A compute kernel (see grass-compute.ts) atomically compacts accepted instances into `mats`/`cols`;
 * the same GPU buffers then back the thin-instance vertex buffers directly (StorageBuffer created
 * with VERTEX usage → wrapped in a Buffer → world0..3 + color vertex buffers). No CPU placement
 * loop, no Float32Array, no upload. The instance COUNT arrives via a tiny async readback of the
 * kernel's atomic counter — until it lands the patch renders 0 instances (a 1–2 frame pop-in).
 *
 * Verified end-to-end in the P3 spike (see webgpu-compute roadmap memory): Buffer accepts a
 * DataBuffer, mat4x4f column-major storage layout matches Babylon's row-major float[16] with the
 * translation at floats 12–14, and zero-scale degenerates rasterise to nothing.
 */
export class GpuScatterPatch implements IPatch {
  /** 1-instance dummy used to bootstrap Babylon's thin-instance plumbing before rebinding. */
  private static readonly BOOTSTRAP = new Float32Array(16);

  private baseMesh: Mesh | null = null;
  private readonly position: Vector3;
  readonly capacity: number;

  readonly mats: StorageBuffer;
  readonly cols: StorageBuffer;
  /** The kernel's atomic append counter — per patch, so a counter readback can never race a later
   *  patch's dispatch resetting a shared one. */
  readonly counter: StorageBuffer;
  private readonly matsBuf: BabylonBuffer;
  private readonly colsBuf: BabylonBuffer;

  /** Compacted instance count (clamped to capacity) — set by the dispatcher's counter readback.
   *  -1 = readback still pending (no mesh exists yet — see setCount). */
  private count = -1;
  /** The base mesh the LoD manager last asked for — materialized once the count says non-empty. */
  private pendingBase: Mesh | null = null;
  private buffersFreed = false;
  /** Vertical bounds of the patch's terrain (sampled by the builder) for the culling box. */
  private readonly yMin: number;
  private readonly yMax: number;
  private readonly halfExtent: number;

  /** When false, the color buffer still exists for the kernel binding but is NOT attached as a
   *  vertex buffer — layers whose materials ignore instance colors (trees, palms, shadow discs)
   *  must not gain a 'color' kind, which would flip material defines. */
  private readonly withColor: boolean;

  constructor(engine: WebGPUEngine, position: Vector3, capacity: number,
              halfExtent: number, yMin: number, yMax: number, withColor = true) {
    this.position = position;
    this.capacity = capacity;
    this.halfExtent = halfExtent;
    this.yMin = yMin;
    this.yMax = yMax;
    this.withColor = withColor;
    const flags = Constants.BUFFER_CREATIONFLAG_VERTEX
      | Constants.BUFFER_CREATIONFLAG_STORAGE
      | Constants.BUFFER_CREATIONFLAG_WRITE;
    this.mats = new StorageBuffer(engine, capacity * 16 * 4, flags);
    this.cols = new StorageBuffer(engine, capacity * 4 * 4, flags);
    this.counter = new StorageBuffer(engine, 4,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_WRITE | Constants.BUFFER_CREATIONFLAG_READ);
    this.matsBuf = new BabylonBuffer(engine, this.mats.getBuffer(), false, 16, false, true);
    this.colsBuf = new BabylonBuffer(engine, this.cols.getBuffer(), false, 4, false, true);
  }

  /** Counter readback landed. DEFERRED MATERIALIZATION: the clone mesh is only created once we
   *  know there is something to draw — the CPU path never creates a mesh for an empty patch, and
   *  with ~20 GPU layers an up-front clone per candidate patch was ~1500 mostly-empty scene meshes
   *  (measured as a multi-FPS regression). Empty patches become tombstones: no mesh, GPU buffers
   *  freed, harmless to the LoD manager. */
  setCount(n: number): void {
    this.count = Math.max(0, Math.min(n, this.capacity));
    if (this.count === 0) {
      this.clearInstances();
      this.freeBuffers();
      return;
    }
    if (this.baseMesh) { this.applyCount(); }
    else if (this.pendingBase) { this.materialize(this.pendingBase); }
  }

  private applyCount(): void {
    if (!this.baseMesh) { return; }
    (this.baseMesh as unknown as { _thinInstanceDataStorage: { instancesCount: number } })
      ._thinInstanceDataStorage.instancesCount = Math.max(0, this.count);
  }

  clearInstances(): void {
    if (this.baseMesh === null) { return; }
    this.baseMesh.dispose();
    this.baseMesh = null;
  }

  /** LoD swaps re-call this with the other base mesh — the GPU buffers (and count) persist and are
   *  simply rebound onto the new clone, so a swap costs no dispatch and no readback. Before the
   *  count readback lands (count < 0) this only RECORDS the base mesh; known-empty patches
   *  (count 0, buffers freed) never materialize at all. */
  createInstances(baseMesh: TransformNode, _fraction = 1): void {
    this.clearInstances();
    if (!(baseMesh instanceof Mesh)) {
      throw new Error('GpuScatterPatch requires a Mesh base.');
    }
    this.pendingBase = baseMesh;
    if (this.count > 0 && !this.buffersFreed) { this.materialize(baseMesh); }
  }

  private materialize(base: Mesh): void {
    this.baseMesh = base.clone(base.name + '_gpatch');
    this.baseMesh.makeGeometryUnique();
    this.baseMesh.isVisible = true;

    // Bootstrap the thin-instance plumbing (renderer flags, instanced state), then point the
    // world0..3 + color kinds at the compute-written buffers.
    this.baseMesh.thinInstanceSetBuffer('matrix', GpuScatterPatch.BOOTSTRAP, 16, true);
    for (let i = 0; i < 4; i++) {
      this.baseMesh.setVerticesBuffer(this.matsBuf.createVertexBuffer('world' + i, i * 4, 4));
    }
    if (this.withColor) {
      this.baseMesh.setVerticesBuffer(this.colsBuf.createVertexBuffer('color', 0, 4));
    }
    this.applyCount();

    // Instances sit at world positions inside the patch square while the clone stays at the origin —
    // give the mesh the patch's real world AABB so frustum culling works (CPU can't derive it from
    // GPU-resident matrices; ThinInstancePatch's refreshBoundingInfo equivalent).
    const p = this.position, h = this.halfExtent;
    this.baseMesh.setBoundingInfo(new BoundingInfo(
      new Vector3(p.x - h, this.yMin, p.z - h),
      new Vector3(p.x + h, this.yMax, p.z + h),
    ));
    this.baseMesh.isPickable = false;
    this.baseMesh.doNotSyncBoundingInfo = true;
    this.baseMesh.freezeWorldMatrix();
  }

  /** Drop the GPU buffers of a confirmed-empty (or disposed) patch. Idempotent. */
  private freeBuffers(): void {
    if (this.buffersFreed) { return; }
    this.buffersFreed = true;
    this.matsBuf.dispose();
    this.colsBuf.dispose();
    this.mats.dispose();
    this.cols.dispose();
    this.counter.dispose();
  }

  getNbInstances(): number { return this.baseMesh === null ? 0 : Math.max(0, this.count); }

  getPosition(): Vector3 { return this.position; }

  dispose(): void {
    this.clearInstances();
    this.pendingBase = null;
    this.freeBuffers();
  }
}
