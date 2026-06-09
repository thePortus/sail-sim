import { AbstractMesh, Matrix, Mesh, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';

/**
 * Baked beam profile of a hull, for the ocean's interior water-cut. A boat hull is bilaterally
 * symmetric across the beam, so its top-down outline is fully described by ONE function: the
 * half-beam as a function of position ALONG the hull. We sample the hull mesh's vertices (in the
 * VESSEL-ROOT frame, forward = +Z = "along", +X = "across") into `N` bins along the length and take
 * the widest |across| in each — the gunwale outline. The ocean shader reads this profile from a small
 * uniform array (NO texture, NO sampler — Mac/Metal caps samplers at 16 and the ocean already uses
 * them all) and cuts the sea where |across| < halfBeam(along), giving the exact pointed hull shape.
 */
export interface HullCutProfile {
  profile:      Float32Array;   // half-beam (m) per along-bin, length N
  alongMin:     number;         // root-local +Z of bin 0 (metres)
  alongLen:     number;         // root-local Z span the bins cover (metres)
  acrossCenter: number;         // root-local +X of the hull centreline (≈0)
}

/** Rasterise `hull`'s beam profile in the frame of `root`. N = bins along the length. */
export function bakeHullCutProfile(
  hull: AbstractMesh, root: TransformNode, N = 96,
): HullCutProfile | null {
  const src = (hull as unknown as { sourceMesh?: Mesh }).sourceMesh ?? (hull as Mesh);
  const positions = src.getVerticesData?.(VertexBuffer.PositionKind);
  if (!positions) { return null; }

  const hullToRoot = hull.computeWorldMatrix(true).multiply(Matrix.Invert(root.computeWorldMatrix(true)));

  // Transform to root frame, track along (Z) / across (X) bounds.
  const n = positions.length / 3;
  const az = new Float32Array(n), ax = new Float32Array(n);
  const tmp = new Vector3();
  let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < n; i++) {
    Vector3.TransformCoordinatesFromFloatsToRef(
      positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], hullToRoot, tmp);
    az[i] = tmp.z; ax[i] = tmp.x;
    if (tmp.z < minZ) { minZ = tmp.z; } if (tmp.z > maxZ) { maxZ = tmp.z; }
    if (tmp.x < minX) { minX = tmp.x; } if (tmp.x > maxX) { maxX = tmp.x; }
  }
  const acrossCenter = (minX + maxX) * 0.5;
  const alongMin = minZ, alongLen = (maxZ - minZ) || 1;

  // Per-bin widest half-beam from the vertices.
  const profile = new Float32Array(N);
  for (let i = 0; i < n; i++) {
    let b = Math.floor(((az[i] - alongMin) / alongLen) * N);
    if (b < 0) { b = 0; } else if (b >= N) { b = N - 1; }
    const hb = Math.abs(ax[i] - acrossCenter);
    if (hb > profile[b]) { profile[b] = hb; }
  }

  // Fill interior gaps (sparse vertices) by linear interpolation between filled bins so the cut
  // doesn't leave thin wet slivers between sampled stations. Leading/trailing zeros (the fine bow/
  // stern tips) are left at 0 so the cut tapers to a point there, matching the hull.
  let first = 0; while (first < N && profile[first] === 0) { first++; }
  let last = N - 1; while (last >= 0 && profile[last] === 0) { last--; }
  for (let i = first; i <= last; i++) {
    if (profile[i] > 0) { continue; }
    let j = i + 1; while (j <= last && profile[j] === 0) { j++; }
    const a = profile[i - 1], bb = profile[j] ?? a;
    for (let k = i; k < j; k++) { profile[k] = a + (bb - a) * ((k - i + 1) / (j - i + 1)); }
    i = j;
  }

  return { profile, alongMin, alongLen, acrossCenter };
}
