import { Mesh, MeshBuilder, Scene, VertexBuffer } from '@babylonjs/core';

/** Paint every vertex of a mesh a single RGB colour (baked vertex colours → trunk vs canopy). */
function paint(mesh: Mesh, r: number, g: number, b: number): void {
  const n = mesh.getTotalVertices();
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { colors[i * 4] = r; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = 1; }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

/**
 * A stylised low-poly tree — a tapered brown trunk topped by a couple of overlapping green canopy
 * blobs, merged into ONE mesh with baked vertex colours (trunk brown, canopy green) so a single
 * white material renders both. Origin at the base (trunk foot at y=0) so an instance placed at
 * terrain height stands on the ground. `detail` is the LoD knob (canopy subdivisions).
 */
export function createTree(scene: Scene, detail: number): Mesh {
  const sub = Math.max(1, Math.min(2, detail));

  const trunk = MeshBuilder.CreateCylinder('tree_trunk',
    { height: 2.6, diameterBottom: 0.42, diameterTop: 0.26, tessellation: 6 }, scene);
  trunk.position.y = 1.3;                       // base → y=0
  paint(trunk, 0.32, 0.22, 0.13);              // bark brown

  const c1 = MeshBuilder.CreateIcoSphere('tree_c1', { radius: 1.55, subdivisions: sub }, scene);
  c1.position.set(0, 3.1, 0); c1.scaling.set(1, 0.82, 1);
  paint(c1, 0.15, 0.33, 0.12);                 // canopy green (lower)

  const c2 = MeshBuilder.CreateIcoSphere('tree_c2', { radius: 1.05, subdivisions: sub }, scene);
  c2.position.set(0.35, 3.95, -0.2); c2.scaling.set(1, 0.9, 1);
  paint(c2, 0.20, 0.41, 0.15);                 // canopy green (upper, lighter)

  const merged = Mesh.MergeMeshes([trunk, c1, c2], true, true, undefined, false, false);
  if (!merged) { return trunk; }               // merge shouldn't fail, but never return null
  merged.name = 'tree';
  return merged;
}
