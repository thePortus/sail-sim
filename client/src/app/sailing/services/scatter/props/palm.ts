import { Color4, Matrix, Mesh, MeshBuilder, Scene, VertexBuffer, VertexData } from '@babylonjs/core';

/** Per-vertex colour gradient along Y (dark base → lighter top). */
function colorByY(mesh: Mesh, base: Color4, top: Color4, y0: number, y1: number): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) { return; }
  const n = pos.length / 3, cols = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, (pos[i * 3 + 1] - y0) / (y1 - y0)));
    cols[i * 4] = base.r + (top.r - base.r) * t;
    cols[i * 4 + 1] = base.g + (top.g - base.g) * t;
    cols[i * 4 + 2] = base.b + (top.b - base.b) * t;
    cols[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, cols);
}
function colorUniform(mesh: Mesh, c: Color4): void {
  const n = mesh.getTotalVertices(), cols = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { cols[i * 4] = c.r; cols[i * 4 + 1] = c.g; cols[i * 4 + 2] = c.b; cols[i * 4 + 3] = 1; }
  mesh.setVerticesData(VertexBuffer.ColorKind, cols);
}

/**
 * Low-poly stylised palm: a tapered trunk + a crown of drooping fronds (+ coconuts at high detail).
 * Vertex-coloured (brown trunk, green fronds) and merged into ONE mesh so it thin-instances cheaply.
 * Origin at the base (trunk foot at y=0). `detail` is the LoD knob (frond count / trunk segments /
 * coconuts). Ported from the original terrain beach-palm into the scatter system.
 */
export function createPalm(scene: Scene, detail: number): Mesh {
  const trunkBase = new Color4(0.42, 0.31, 0.19, 1);
  const trunkTop  = new Color4(0.55, 0.43, 0.28, 1);
  const frondBase = new Color4(0.11, 0.33, 0.12, 1);
  const frondTip  = new Color4(0.33, 0.58, 0.24, 1);
  const cocoCol   = new Color4(0.33, 0.24, 0.14, 1);

  const TRUNK_H = 9, CROWN_Y = TRUNK_H;
  const hi = detail >= 2;
  const perRing = hi ? 6 : 4;

  const trunk = MeshBuilder.CreateCylinder('palm_trunk', {
    height: TRUNK_H, diameterBottom: 0.85, diameterTop: 0.34, tessellation: hi ? 8 : 6, subdivisions: hi ? 6 : 1,
  }, scene);
  trunk.bakeTransformIntoVertices(Matrix.Translation(0, TRUNK_H / 2, 0));   // base at y = 0
  colorByY(trunk, trunkBase, trunkTop, 0, TRUNK_H);
  const parts: Mesh[] = [trunk];

  // A feathered frond: a drooping central spine with small leaflet triangles down both sides
  // (shrinking toward the tip), so the silhouette reads as a real palm leaf, not a flat triangle.
  const makeFrond = (ring: number, idx: number): Mesh => {
    const len = 6.0 - ring * 0.8 + (idx % 2) * 0.5;
    const N = detail >= 2 ? 9 : 6;                       // leaflet pairs (LoD)
    const positions: number[] = [], indices: number[] = [], colors: number[] = [], uvs: number[] = [];
    const spine: number[] = [];
    let vi = 0;
    const pushCol = (t: number) => colors.push(
      frondBase.r + (frondTip.r - frondBase.r) * t,
      frondBase.g + (frondTip.g - frondBase.g) * t,
      frondBase.b + (frondTip.b - frondBase.b) * t, 1);

    for (let i = 0; i <= N; i++) {
      const t = i / N;
      positions.push(0, len * t, -len * 0.16 * t * t);   // spine, drooping forward
      pushCol(t); uvs.push(0.5, t);
      spine.push(vi++);
    }
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const sy = len * t, sz = -len * 0.16 * t * t;
      const lw = (0.95 - 0.7 * t) * 0.7;                 // leaflet length, shrinks toward the tip
      const dy = -0.45 * lw;                             // leaflet droop
      positions.push(-lw, sy + dy, sz - 0.06 * lw); pushCol(t); uvs.push(0, t); const li = vi++;
      positions.push( lw, sy + dy, sz - 0.06 * lw); pushCol(t); uvs.push(1, t); const ri = vi++;
      indices.push(spine[i - 1], spine[i], li);          // left leaflet
      indices.push(spine[i - 1], ri, spine[i]);          // right leaflet
    }

    const m = new Mesh(`palm_frond_${ring}_${idx}`, scene);
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const vd = new VertexData();
    vd.positions = positions; vd.indices = indices; vd.normals = normals; vd.colors = colors; vd.uvs = uvs;
    vd.applyToMesh(m);
    return m;
  };

  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < perRing; i++) {
      const f = makeFrond(ring, i);
      f.rotation.x = (ring === 0 ? 0.70 : 1.45) + (i % 2) * 0.15;
      f.rotation.y = (i / perRing) * Math.PI * 2 + ring * (Math.PI / perRing);
      f.position.set(0, CROWN_Y, 0);
      parts.push(f);
    }
  }

  if (hi) {
    for (let i = 0; i < 4; i++) {
      const c = MeshBuilder.CreateSphere(`palm_coco_${i}`, { diameter: 0.5, segments: 4 }, scene);
      const a = (i / 4) * Math.PI * 2;
      c.bakeTransformIntoVertices(Matrix.Translation(Math.cos(a) * 0.42, CROWN_Y - 0.5, Math.sin(a) * 0.42));
      colorUniform(c, cocoCol);
      parts.push(c);
    }
  }

  const palm = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  return palm ?? trunk;
}
