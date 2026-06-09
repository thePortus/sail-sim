import { Mesh, MeshBuilder, Scene, VertexBuffer } from '@babylonjs/core';

/** Deterministic per-position hash in [0,1] — perturbs the log surface. */
function whash(x: number, y: number, z: number): number {
  return ((Math.sin(x * 23.17 + y * 41.9 + z * 11.7) * 24634.6345) % 1 + 1) % 1;
}

/**
 * A weathered driftwood log — a tapered low-poly cylinder laid on its side (axis along local X),
 * gnarled by a position hash and flat-shaded for a worn, faceted look. Origin at the BASE (min-Y = 0)
 * so an instance placed at terrain height rests on the sand. `detail` is the LoD knob (length
 * segments). Per-instance length/thickness + bleached colour come from the thin-instance buffers.
 */
export function createDriftwood(scene: Scene, detail: number): Mesh {
  const m = MeshBuilder.CreateCylinder('driftwood', {
    height: 1.6, diameterBottom: 0.34, diameterTop: 0.20, tessellation: 7,
    subdivisions: Math.max(1, detail),
  }, scene);

  // Lay the log on its side (cylinder is built along Y → rotate so its axis runs along X).
  m.rotation.z = Math.PI / 2;
  m.bakeCurrentTransformIntoVertices();

  const pos = m.getVerticesData(VertexBuffer.PositionKind);
  if (pos) {
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const n = 0.78 + 0.34 * whash(x * 5 + 1.3, y * 5 + 4.1, z * 5 + 2.7);   // gnarl the cross-section
      pos[i + 1] = y * n + 0.05 * x * x;     // squash + a gentle bend along the length
      pos[i + 2] = z * n;
    }
    let minY = Infinity;
    for (let i = 1; i < pos.length; i += 3) { if (pos[i] < minY) { minY = pos[i]; } }
    for (let i = 1; i < pos.length; i += 3) { pos[i] -= minY; }
    m.updateVerticesData(VertexBuffer.PositionKind, pos);
  }

  m.convertToFlatShadedMesh();
  return m;
}
