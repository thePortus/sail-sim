import { Mesh, MeshBuilder, Scene, VertexBuffer } from '@babylonjs/core';

/** Deterministic per-position hash in [0,1] — used to perturb the rock surface. */
function rhash(x: number, y: number, z: number): number {
  return ((Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1 + 1) % 1;
}

/**
 * A low-poly, irregular rock — an icosphere whose vertices are pushed in/out by a position hash
 * (shared verts move together so it stays watertight), squashed vertically so it sits, then
 * flat-shaded for a faceted stone look. Origin is moved to the BASE (min-Y = 0) so an instance
 * placed at terrain height rests on the ground. `subdivisions` is the LoD knob (2 ≈ near, 1 ≈ far).
 *
 * Unit-ish size (~0.5 m radius before instance scaling). Per-instance colour + scale come from the
 * thin-instance buffers, so one mesh yields every size and stone colour.
 */
export function createRock(scene: Scene, subdivisions: number): Mesh {
  const m = MeshBuilder.CreateIcoSphere('rock', { radius: 0.5, subdivisions: Math.max(1, subdivisions), flat: false }, scene);

  const pos = m.getVerticesData(VertexBuffer.PositionKind);
  if (pos) {
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const n = 0.62 + 0.55 * rhash(x * 4 + 1.7, y * 4 + 2.3, z * 4 + 5.1);   // 0.62 … 1.17
      pos[i]     = x * n;
      pos[i + 1] = y * n * 0.78;        // squash vertically → a sitting boulder, not a sphere
      pos[i + 2] = z * n;
    }
    // Shift so the lowest vertex sits at y = 0 (origin at the base).
    let minY = Infinity;
    for (let i = 1; i < pos.length; i += 3) { if (pos[i] < minY) { minY = pos[i]; } }
    for (let i = 1; i < pos.length; i += 3) { pos[i] -= minY; }
    m.updateVerticesData(VertexBuffer.PositionKind, pos);
  }

  m.convertToFlatShadedMesh();   // faceted, rocky shading
  return m;
}
