import { Mesh, Scene, Vector3, VertexData } from '@babylonjs/core';

/** Rodrigues' rotation — rotate `vector` around unit `axis` by `theta`. */
function rotateAround(vector: Vector3, axis: Vector3, theta: number): Vector3 {
  return vector
    .scale(Math.cos(theta))
    .addInPlace(Vector3.Cross(axis, vector).scaleInPlace(Math.sin(theta)))
    .addInPlace(axis.scale(Vector3.Dot(axis, vector) * (1.0 - Math.cos(theta))));
}

/**
 * Builds a single grass blade mesh as rows of 2 vertices stacked up to a tip. `nbStacks` is the LoD
 * knob — 4 = curved/detailed (near), 1 = a flat quad (far). Tiny vertex count → millions of thin
 * instances stay cheap. Ported from Barthélemy Paléologue's "AssetScattering" (MIT).
 */
export function createGrassBlade(scene: Scene, nbStacks: number): Mesh {
  const nbVertices = 2 * nbStacks + 1;
  const nbTriangles = 2 * (nbStacks - 1) + 1;

  const positions = new Float32Array(nbVertices * 3);
  const normals = new Float32Array(nbVertices * 3);
  const indices = new Uint32Array(nbTriangles * 3);

  const normal = new Vector3(0, 0, 1);
  const curvyNormal1 = rotateAround(normal, new Vector3(0, 1, 0), Math.PI * 0.3);
  const curvyNormal2 = rotateAround(normal, new Vector3(0, 1, 0), -Math.PI * 0.3);

  let vi = 0, ni = 0, ii = 0;
  const step = 1 / nbStacks;
  for (let i = 0; i < nbStacks; i++) {
    positions[vi++] = -0.05 * (nbStacks - i) * step;
    positions[vi++] = i * step;
    positions[vi++] = 0;
    positions[vi++] = 0.05 * (nbStacks - i) * step;
    positions[vi++] = i * step;
    positions[vi++] = 0;

    normals[ni++] = curvyNormal1.x; normals[ni++] = curvyNormal1.y; normals[ni++] = curvyNormal1.z;
    normals[ni++] = curvyNormal2.x; normals[ni++] = curvyNormal2.y; normals[ni++] = curvyNormal2.z;

    if (i === 0) { continue; }
    indices[ii++] = 2 * (i - 1);
    indices[ii++] = 2 * (i - 1) + 1;
    indices[ii++] = 2 * i;
    indices[ii++] = 2 * i;
    indices[ii++] = 2 * (i - 1) + 1;
    indices[ii++] = 2 * i + 1;
  }

  // Tip vertex + final triangle.
  positions[vi++] = 0; positions[vi++] = nbStacks * step; positions[vi++] = 0;
  normals[ni++] = 0; normals[ni++] = 0; normals[ni++] = 1;
  indices[ii++] = 2 * (nbStacks - 1);
  indices[ii++] = 2 * (nbStacks - 1) + 1;
  indices[ii++] = 2 * nbStacks;

  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.normals = normals;
  vertexData.indices = indices;

  const blade = new Mesh('grassBlade', scene);
  vertexData.applyToMesh(blade);
  return blade;
}
