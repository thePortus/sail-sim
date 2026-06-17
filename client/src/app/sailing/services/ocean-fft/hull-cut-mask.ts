import { AbstractMesh, Constants, Matrix, Mesh, Scene, StandardMaterial, TransformNode, Vector3, VertexBuffer, VertexData } from '@babylonjs/core';

/** Stencil byte the hull proxy writes and the ocean tests against. Any non-zero value works; 1 is fine. */
export const HULL_STENCIL_REF = 1;

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

/**
 * Rasterise `hull`'s beam profile in the frame of `root`. N = bins along the length.
 *
 * `waterlineY` (root-local Y, the rig origin is authored at the waterline so ~0) selects the footprint:
 *  - a number → the TRUE WATERLINE CONTOUR: intersect the hull triangles with the plane y=waterlineY and
 *    bin the crossing points — the exact hull-meets-water outline, so the sea is cut/depressed only where
 *    the hull actually displaces it (waves lap right up to the planking, none of the old radial trough).
 *  - undefined → legacy widest-beam (gunwale-line) projection over all vertices.
 * Falls back to the widest-beam projection if the slice degenerates (waterlineY outside the hull's Y range).
 */
export function bakeHullCutProfile(
  hull: AbstractMesh, root: TransformNode, N = 96, waterlineY?: number,
): HullCutProfile | null {
  const src = (hull as unknown as { sourceMesh?: Mesh }).sourceMesh ?? (hull as Mesh);
  const positions = src.getVerticesData?.(VertexBuffer.PositionKind);
  if (!positions) { return null; }

  const hullToRoot = hull.computeWorldMatrix(true).multiply(Matrix.Invert(root.computeWorldMatrix(true)));

  // Transform every vertex to the root frame once (reused by both the waterline slice and the fallback).
  const n = positions.length / 3;
  const rx = new Float32Array(n), ry = new Float32Array(n), rz = new Float32Array(n);
  const tmp = new Vector3();
  let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < n; i++) {
    Vector3.TransformCoordinatesFromFloatsToRef(
      positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], hullToRoot, tmp);
    rx[i] = tmp.x; ry[i] = tmp.y; rz[i] = tmp.z;
    if (tmp.z < minZ) { minZ = tmp.z; } if (tmp.z > maxZ) { maxZ = tmp.z; }
    if (tmp.x < minX) { minX = tmp.x; } if (tmp.x > maxX) { maxX = tmp.x; }
  }
  const acrossCenter = (minX + maxX) * 0.5;
  const alongMin = minZ, alongLen = (maxZ - minZ) || 1;

  const profile = new Float32Array(N);
  const binOf = (z: number) => { let b = Math.floor(((z - alongMin) / alongLen) * N); return b < 0 ? 0 : (b >= N ? N - 1 : b); };

  let sliced = false;
  if (waterlineY != null) {
    // ── True waterline contour: bin the hull-triangle crossings of the plane y = waterlineY. ──
    const indices = src.getIndices?.();
    let crossings = 0;
    const consider = (a: number, b: number) => {
      const ya = ry[a] - waterlineY, yb = ry[b] - waterlineY;
      if ((ya <= 0 && yb > 0) || (yb <= 0 && ya > 0)) {           // edge straddles the waterline
        const f = ya / (ya - yb);                                 // ∈ (0,1]
        const cz = rz[a] + (rz[b] - rz[a]) * f;
        const cxAbs = Math.abs((rx[a] + (rx[b] - rx[a]) * f) - acrossCenter);
        const bin = binOf(cz);
        if (cxAbs > profile[bin]) { profile[bin] = cxAbs; }
        crossings++;
      }
    };
    if (indices) {
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
        consider(i0, i1); consider(i1, i2); consider(i2, i0);
      }
    }
    sliced = crossings >= N * 0.25;   // enough of the waterline was hit; else fall back below
    if (!sliced) { profile.fill(0); }
  }

  if (!sliced) {
    // ── Fallback (or legacy): widest |across| per along-bin over all vertices (gunwale outline). ──
    for (let i = 0; i < n; i++) {
      const hb = Math.abs(rx[i] - acrossCenter);
      const b = binOf(rz[i]);
      if (hb > profile[b]) { profile[b] = hb; }
    }
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

/**
 * HEIGHT-AWARE hull silhouette for the ocean's per-pixel interior DISCARD (the SoT-style occlusion that
 * replaces the surface-carve). A single top-down outline is wrong the instant the boat bobs: the hull
 * FLARES, so the waterline meets it FURTHER OUT under a crest and FURTHER IN in a trough. So instead of
 * one outline we bake a 2-D table — half-beam as a function of BOTH along-position AND height — by
 * intersecting the hull triangles with horizontal planes at NH height levels spanning the hull (keel→top).
 * The ocean fragment shader then looks up the hull's width AT THE LIVE WAVE HEIGHT at each pixel, so the
 * exclusion outline rides up and down the flare exactly with the water. Root frame: forward=+Z=along,
 * +X=across, +Y=up; heights are root-local (the rig origin is ~the waterline), referenced at render time
 * against the boat's current vertical position.
 */
export interface HullSilhouette {
  table:        Float32Array;   // NA*NH half-beams, row-major [along*NH + height]
  NA:           number;
  NH:           number;
  alongMin:     number;
  alongLen:     number;
  acrossCenter: number;
  hMin:         number;         // root-local Y of height level 0 (≈ keel)
  hMax:         number;         // root-local Y of the top level (≈ above the gunwale)
}

export function bakeHullSilhouette(
  hull: AbstractMesh, root: TransformNode, NA = 48, NH = 8,
): HullSilhouette | null {
  const src = (hull as unknown as { sourceMesh?: Mesh }).sourceMesh ?? (hull as Mesh);
  const positions = src.getVerticesData?.(VertexBuffer.PositionKind);
  const indices = src.getIndices?.();
  if (!positions || !indices) { return null; }

  const hullToRoot = hull.computeWorldMatrix(true).multiply(Matrix.Invert(root.computeWorldMatrix(true)));

  const n = positions.length / 3;
  const rx = new Float32Array(n), ry = new Float32Array(n), rz = new Float32Array(n);
  const tmp = new Vector3();
  let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    Vector3.TransformCoordinatesFromFloatsToRef(
      positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], hullToRoot, tmp);
    rx[i] = tmp.x; ry[i] = tmp.y; rz[i] = tmp.z;
    if (tmp.z < minZ) { minZ = tmp.z; } if (tmp.z > maxZ) { maxZ = tmp.z; }
    if (tmp.x < minX) { minX = tmp.x; } if (tmp.x > maxX) { maxX = tmp.x; }
    if (tmp.y < minY) { minY = tmp.y; } if (tmp.y > maxY) { maxY = tmp.y; }
  }
  const acrossCenter = (minX + maxX) * 0.5;
  const alongMin = minZ, alongLen = (maxZ - minZ) || 1;
  // Pad the top a touch so the highest level sits just ABOVE the gunwale (its half-beam → 0 there, which is
  // what lets a wave wash over the rail instead of being clipped).
  const hMin = minY, hMax = maxY + (maxY - minY) * 0.06;
  const hSpan = (hMax - hMin) || 1, dH = hSpan / NH;

  const table = new Float32Array(NA * NH);
  const binAlong = (z: number) => { let b = Math.floor(((z - alongMin) / alongLen) * NA); return b < 0 ? 0 : (b >= NA ? NA - 1 : b); };

  // For each triangle edge, record its crossing of every height level it spans → the hull's |across| at
  // that (along, height) cell (widest wins). Robust to vertex density (uses the actual surface, not verts).
  const edge = (a: number, b: number) => {
    const ya = ry[a], yb = ry[b];
    if (ya === yb) { return; }
    const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
    let k0 = Math.ceil((lo - hMin) / dH - 0.5), k1 = Math.floor((hi - hMin) / dH - 0.5);
    if (k0 < 0) { k0 = 0; } if (k1 > NH - 1) { k1 = NH - 1; }
    for (let k = k0; k <= k1; k++) {
      const hk = hMin + (k + 0.5) * dH;
      const f = (hk - ya) / (yb - ya);
      if (f < 0 || f > 1) { continue; }
      const cz = rz[a] + (rz[b] - rz[a]) * f;
      const cxAbs = Math.abs((rx[a] + (rx[b] - rx[a]) * f) - acrossCenter);
      const idx = binAlong(cz) * NH + k;
      if (cxAbs > table[idx]) { table[idx] = cxAbs; }
    }
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
    edge(i0, i1); edge(i1, i2); edge(i2, i0);
  }

  // Per height level, fill gaps along the length (sparse stations) by linear interpolation; leave the
  // leading/trailing zeros (the fine bow/stern tips) so the cut tapers to a point there.
  for (let k = 0; k < NH; k++) {
    let first = 0; while (first < NA && table[first * NH + k] === 0) { first++; }
    let last = NA - 1; while (last >= 0 && table[last * NH + k] === 0) { last--; }
    for (let a = first; a <= last; a++) {
      if (table[a * NH + k] > 0) { continue; }
      let j = a + 1; while (j <= last && table[j * NH + k] === 0) { j++; }
      const lo = table[(a - 1) * NH + k], hi = (j <= last ? table[j * NH + k] : lo);
      for (let m = a; m < j; m++) { table[m * NH + k] = lo + (hi - lo) * ((m - a + 1) / (j - a + 1)); }
      a = j;
    }
  }

  return { table, NA, NH, alongMin, alongLen, acrossCenter, hMin, hMax };
}

/**
 * Build the HULL STENCIL PROXY — a thin lid spanning the deck outline at the gunwale, parented to the boat
 * root. It paints NO colour and writes NO depth; it only stamps the stencil buffer with HULL_STENCIL_REF
 * across the boat's exact on-screen footprint (real geometry, so it tracks pitch/heel/heave perfectly).
 * The FFT ocean is then drawn with a stencil test that rejects those pixels, so the sea is masked out of the
 * hull at the pixel level — no carve, no per-pixel footprint math, and (because it's the boat's true
 * projected silhouette) no tears. Built from the widest-beam (gunwale) profile so the lid covers the whole
 * open cockpit; `inset` (<1) keeps its edge just inside the planking so it never masks sea OUTSIDE the hull.
 *
 * Render wiring (done by the caller): renderingGroupId 0 (with the FFT ocean) + a group-0 opaque sort that
 * draws this FIRST, so the stencil is stamped before the water reads it. Depth/stencil are continuous across
 * groups in this scene, so the boat (group 2) still fills the masked cockpit normally.
 */
export function buildHullStencilCap(
  profile: HullCutProfile, gunwaleY: number, scene: Scene, inset = 0.95,
): Mesh {
  const N = profile.profile.length;
  const positions: number[] = [];
  const indices: number[] = [];
  const dz = profile.alongLen / N;
  for (let i = 0; i < N; i++) {
    const hb = Math.max(profile.profile[i] * inset, 0);
    const z = profile.alongMin + (i + 0.5) * dz;
    positions.push(profile.acrossCenter - hb, gunwaleY, z);   // left  rail (vertex 2i)
    positions.push(profile.acrossCenter + hb, gunwaleY, z);   // right rail (vertex 2i+1)
  }
  for (let i = 0; i < N - 1; i++) {
    const a = 2 * i, b = 2 * i + 1, c = a + 2, d = b + 2;
    indices.push(a, c, b, b, c, d);                           // two tris bridging adjacent stations
  }
  const mesh = new Mesh('hull_stencil_cap', scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.applyToMesh(mesh);

  const mat = new StandardMaterial('hull_stencil_mat', scene);
  mat.disableLighting   = true;
  mat.disableColorWrite = true;            // never paints a pixel
  mat.disableDepthWrite = true;            // must not occlude the boat, crew or seabed
  mat.depthFunction     = Constants.ALWAYS;   // stamp the whole footprint regardless of what's behind it
  mat.backFaceCulling   = false;
  mat.stencil.enabled            = true;
  mat.stencil.func               = Constants.ALWAYS;    // always pass → always stamp
  mat.stencil.funcRef            = HULL_STENCIL_REF;
  mat.stencil.funcMask           = 0xff;
  mat.stencil.mask               = 0xff;                // write mask
  mat.stencil.opStencilDepthPass = Constants.REPLACE;   // write the ref where it draws
  mat.stencil.opStencilFail      = Constants.KEEP;
  mat.stencil.opDepthFail        = Constants.KEEP;
  mesh.material = mat;

  mesh.renderingGroupId        = 0;        // same group as the FFT ocean (a group-0 sort draws it first)
  mesh.isPickable              = false;
  mesh.receiveShadows          = false;
  mesh.alwaysSelectAsActiveMesh = true;    // tiny + always near the camera — never frustum-cull it away
  mesh.metadata = { stencilProxy: true, excludeFromRefraction: true, excludeFromOceanDepth: true };
  return mesh;
}

/**
 * Build the TRUE-3D HULL STENCIL PROXY — the parallax-free replacement for the flat lid. A boat's
 * cross-section changes with height (it flares out near the gunwale, narrows to the keel), so NO single
 * horizontal outline matches it: a flat sheet at the gunwale floats above the sea (parallax), one at the
 * waterline pokes its wide gunwale outline out past the narrower waterline hull (a skirt). The only thing
 * whose on-screen silhouette is exactly the boat's at every camera angle is the boat's own geometry — so
 * this clones the live hull mesh (SHARED geometry + SHARED skeleton, so it deforms with the boat for free)
 * and paints it into the stencil buffer only: no colour, no depth, depthFunc ALWAYS + backfaces on, so
 * EVERY pixel any hull triangle (near, far, or floor) covers gets stamped HULL_STENCIL_REF — i.e. the
 * solid hull silhouette, the open cockpit included (the far wall/floor project onto it). The FFT ocean's
 * stencil test then rejects exactly those pixels: the sea is masked to the hull's real shape, no skirt,
 * no float, no tears. The boat (group 2, after the ocean) draws over it and fills the cockpit.
 *
 * Render wiring (caller): renderingGroupId 0 + the group-0 opaque sort that draws stencilProxy meshes
 * first, so the stamp lands before the water reads it. Returns null if the hull can't be cloned.
 */
export function buildHullStencilProxy(hull: AbstractMesh, root: TransformNode, scene: Scene): Mesh | null {
  // An InstancedMesh shares its sourceMesh's geometry; clone the SOURCE (a real Mesh with a material slot).
  const src = (hull as unknown as { sourceMesh?: Mesh }).sourceMesh ?? (hull as Mesh);
  if (typeof (src as Mesh).clone !== 'function') { return null; }
  const clone = (src as Mesh).clone('hull_stencil_proxy', null, true);   // share geometry, skip children
  if (!clone) { return null; }

  // Overlay it exactly on the LIVE hull (not the source, which may sit hidden at the origin): copy the
  // hull's parent + local transform, and share its skeleton so the clone skins identically each frame.
  clone.parent = hull.parent;
  clone.position.copyFrom(hull.position);
  if (hull.rotationQuaternion) { clone.rotationQuaternion = hull.rotationQuaternion.clone(); }
  else { clone.rotationQuaternion = null; clone.rotation.copyFrom(hull.rotation); }
  clone.scaling.copyFrom(hull.scaling);
  clone.skeleton = hull.skeleton;

  const mat = new StandardMaterial('hull_stencil_mat', scene);
  mat.disableLighting   = true;
  mat.disableColorWrite = true;            // never paints a pixel
  mat.disableDepthWrite = true;            // must not occlude the boat, crew or seabed
  mat.depthFunction     = Constants.ALWAYS;   // stamp the whole silhouette regardless of what's behind it
  mat.backFaceCulling   = false;           // far wall / floor stamp the open-cockpit pixels too
  mat.stencil.enabled            = true;
  mat.stencil.func               = Constants.ALWAYS;
  mat.stencil.funcRef            = HULL_STENCIL_REF;
  mat.stencil.funcMask           = 0xff;
  mat.stencil.mask               = 0xff;
  mat.stencil.opStencilDepthPass = Constants.REPLACE;
  mat.stencil.opStencilFail      = Constants.KEEP;
  mat.stencil.opDepthFail        = Constants.KEEP;
  clone.material = mat;

  clone.renderingGroupId         = 0;
  clone.isPickable               = false;
  clone.receiveShadows           = false;
  clone.alwaysSelectAsActiveMesh = true;
  // The source can be a hidden instancing master — force the clone visible/enabled or it stamps nothing.
  clone.setEnabled(true);
  clone.isVisible = true;
  clone.metadata = { stencilProxy: true, excludeFromRefraction: true, excludeFromOceanDepth: true };
  return clone;
}
