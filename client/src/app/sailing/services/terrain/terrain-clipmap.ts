/**
 * TerrainClipmap — camera-centred geometry clipmap (concentric LOD rings) for the terrain.
 *
 * Forked from the FFT ocean's OceanGeometry (itself a port of Popov72's OceanDemo). The geometry is
 * identical — a dense centre patch + rings that double in scale outward, snapped to the camera each
 * frame so detail follows the player — but adapted for land:
 *   • meshes are named `terrain_clip_*` (NOT `ocean_*`) so they ARE included in the ocean's depth +
 *     refraction RTTs — the seabed must be in those for the depth-based water transparency to work.
 *   • meshes RECEIVE shadows (the ocean's don't).
 *   • a single material (terrain has no per-LOD material variants); the material's vertex shader
 *     displaces the flat grid by sampling a heightfield texture (see terrain.service).
 *
 * `update()` must be called each frame.
 */
import {
  Scene, Camera, TransformNode, Mesh, Material, VertexData,
  Quaternion, Vector3, Angle, Scalar, TmpVectors,
} from '@babylonjs/core';

enum Seams { None = 0, Left = 1, Right = 2, Top = 4, Bottom = 8, All = Left | Right | Top | Bottom }

export class TerrainClipmap {
  public lengthScale = 24;       // base ring length scale (m) — ~matches the 24 m heightfield texel
  public vertexDensity = 32;     // grid resolution knob (gridSize = 4*density+1)
  public clipLevels = 9;         // rings; 2^9 × lengthScale × grid covers the 50 km world + horizon
  public skirtSize = 20;
  public useSkirt = true;

  private _scene: Scene;
  private _camera: Camera;
  private _root: TransformNode;
  private _material: Material | null = null;
  private _trimRotations: Quaternion[];
  private _center!: Mesh;
  private _skirt!: Mesh;
  private _rings: Mesh[] = [];
  private _trims: Mesh[] = [];

  constructor(camera: Camera, scene: Scene) {
    this._camera = camera;
    this._scene = scene;
    this._root = new TransformNode('TerrainClipmap', scene);
    this._trimRotations = [
      Quaternion.RotationAxis(Vector3.UpReadOnly, Angle.FromDegrees(180).radians()),
      Quaternion.RotationAxis(Vector3.UpReadOnly, Angle.FromDegrees(90).radians()),
      Quaternion.RotationAxis(Vector3.UpReadOnly, Angle.FromDegrees(270).radians()),
      Quaternion.Identity(),
    ];
  }

  get root(): TransformNode { return this._root; }

  setMaterial(material: Material): void { this._material = material; }

  /** (Re)build all clipmap meshes. Call after setMaterial(). */
  initializeMeshes(): void {
    this._center?.dispose();
    this._skirt?.dispose();
    this._rings.forEach((m) => m.dispose());
    this._trims.forEach((m) => m.dispose());
    this._skirt = null as never;
    this._rings = [];
    this._trims = [];
    this._instantiateMeshes();
  }

  /** Per-frame: snap meshes to the camera grid. */
  update(): void { this._updatePositions(); }

  allMeshes(): Mesh[] {
    const out: Mesh[] = [this._center, ...this._rings, ...this._trims];
    if (this._skirt) { out.push(this._skirt); }
    return out.filter(Boolean);
  }

  dispose(): void {
    this._center?.dispose();
    this._skirt?.dispose();
    this._rings.forEach((m) => m.dispose());
    this._trims.forEach((m) => m.dispose());
    this._root.dispose();
  }

  // ── snapping ──────────────────────────────────────────────────────────────
  private _updatePositions(): void {
    const k = this._gridSize;
    const activeLevels = this._activeLodLevels;

    const previousSnappedPosition = TmpVectors.Vector3[0];
    const centerOffset = TmpVectors.Vector3[1];
    const snappedPosition = TmpVectors.Vector3[2];
    const trimPosition = TmpVectors.Vector3[3];

    let scale = this._clipLevelScale(-1, activeLevels);
    previousSnappedPosition.copyFrom(this._camera.position);
    this._snap(previousSnappedPosition, scale * 2);
    this._offsetFromCenter(-1, activeLevels, centerOffset);

    this._center.position.copyFrom(previousSnappedPosition).addInPlace(centerOffset);
    this._center.scaling.set(scale, 1, scale);

    for (let i = 0; i < this.clipLevels; i++) {
      this._rings[i].setEnabled(i < activeLevels);
      this._trims[i].setEnabled(i < activeLevels);
      if (i >= activeLevels) { continue; }

      scale = this._clipLevelScale(i, activeLevels);
      snappedPosition.copyFrom(this._camera.position);
      this._snap(snappedPosition, scale * 2);
      this._offsetFromCenter(i, activeLevels, centerOffset);

      trimPosition.copyFrom(snappedPosition).addInPlace(centerOffset)
        .addInPlaceFromFloats(scale * (k - 1) / 2, 0, scale * (k - 1) / 2);
      const shiftX = (previousSnappedPosition.x - snappedPosition.x) <= 0 ? 1 : 0;
      const shiftZ = (previousSnappedPosition.z - snappedPosition.z) <= 0 ? 1 : 0;
      trimPosition.x += shiftX * (k + 1) * scale;
      trimPosition.z += shiftZ * (k + 1) * scale;

      this._trims[i].position.copyFrom(trimPosition);
      this._trims[i].rotationQuaternion!.copyFrom(this._trimRotations[shiftX + 2 * shiftZ]);
      this._trims[i].scaling.set(scale, 1, scale);
      this._rings[i].position.copyFrom(snappedPosition).addInPlace(centerOffset);
      this._rings[i].scaling.set(scale, 1, scale);
      previousSnappedPosition.copyFrom(snappedPosition);
    }

    if (this.useSkirt) {
      scale = this.lengthScale * 2 * Math.pow(2, this.clipLevels);
      this._skirt.position.copyFrom(previousSnappedPosition)
        .addInPlaceFromFloats(-scale * (this.skirtSize + 0.5 - 0.5 / k), 0, -scale * (this.skirtSize + 0.5 - 0.5 / k));
      this._skirt.scaling.set(scale, 1, scale);
    }
  }

  private get _activeLodLevels(): number {
    // Use the camera's height above the ground to drop near LODs when high up (like the ocean uses
    // height above sea). Bigger constant than the ocean's since terrain is viewed from higher.
    return this.clipLevels - Scalar.Clamp(
      Math.floor(Math.log2((1.7 * Math.abs(this._camera.position.y) + 1) / this.lengthScale)),
      0, this.clipLevels,
    );
  }

  private _clipLevelScale(level: number, activeLevels: number): number {
    return this.lengthScale / this._gridSize * Math.pow(2, this.clipLevels - activeLevels + level + 1);
  }

  private _offsetFromCenter(level: number, activeLevels: number, result: Vector3): void {
    const k = this._gridSize;
    const v = ((1 << this.clipLevels) + TerrainClipmap._geoSum(2, 2, this.clipLevels - activeLevels + level + 1, this.clipLevels - 1))
      * this.lengthScale / k * (k - 1) / 2;
    result.copyFromFloats(-v, 0, -v);
  }

  private static _geoSum(b0: number, q: number, n1: number, n2: number): number {
    return b0 / (1 - q) * (Math.pow(q, n2) - Math.pow(q, n1));
  }

  private _snap(coords: Vector3, scale: number): void {
    if (coords.x >= 0) { coords.x = Math.floor(coords.x / scale) * scale; }
    else { coords.x = Math.ceil((coords.x - scale + 1) / scale) * scale; }
    if (coords.z < 0) { coords.z = Math.floor(coords.z / scale) * scale; }
    else { coords.z = Math.ceil((coords.z - scale + 1) / scale) * scale; }
    coords.y = 0;
  }

  private get _gridSize(): number { return 4 * this.vertexDensity + 1; }

  // ── Mesh construction (identical topology to the ocean clipmap) ────────────
  private _instantiateMeshes(): void {
    const k = this._gridSize;
    this._center = this._instantiate('Center', this._createPlaneMesh(2 * k, 2 * k, 1, Seams.All));
    const ring = this._createRingMesh(k, 1);
    const trim = this._createTrimMesh(k, 1);
    for (let i = 0; i < this.clipLevels; ++i) {
      this._rings.push(this._instantiate('Ring' + i, ring, i > 0));
      this._trims.push(this._instantiate('Trim' + i, trim, i > 0));
    }
    if (this.useSkirt) {
      this._skirt = this._instantiate('Skirt', this._createSkirtMesh(k, this.skirtSize));
    }
  }

  private _instantiate(name: string, mesh: Mesh, clone = false): Mesh {
    if (clone) { mesh = mesh.clone(''); }
    mesh.name = 'terrain_clip_' + name;          // NOT ocean_* → included in depth/refraction RTTs
    if (this._material) { mesh.material = this._material; }
    mesh.parent = this._root;
    mesh.receiveShadows = true;
    mesh.alwaysSelectAsActiveMesh = true;        // displaced in the vertex shader → CPU bounds are wrong
    return mesh;
  }

  private _createSkirtMesh(k: number, outerBorderScale: number): Mesh {
    const quad = this._createPlaneMesh(1, 1, 1);
    const hStrip = this._createPlaneMesh(k, 1, 1);
    const vStrip = this._createPlaneMesh(1, k, 1);
    const cornerQuadScale = new Vector3(outerBorderScale, 1, outerBorderScale);
    const midQuadScaleVert = new Vector3(1 / k, 1, outerBorderScale);
    const midQuadScaleHor = new Vector3(outerBorderScale, 1, 1 / k);
    const m1 = quad.clone(); m1.scaling.copyFrom(cornerQuadScale);
    const m2 = hStrip.clone(); m2.scaling.copyFrom(midQuadScaleVert); m2.position.x = outerBorderScale;
    const m3 = quad.clone(); m3.scaling.copyFrom(cornerQuadScale); m3.position.x = outerBorderScale + 1;
    const m4 = vStrip.clone(); m4.scaling.copyFrom(midQuadScaleHor); m4.position.z = outerBorderScale;
    const m5 = vStrip.clone(); m5.scaling.copyFrom(midQuadScaleHor); m5.position.x = outerBorderScale + 1; m5.position.z = outerBorderScale;
    const m6 = quad.clone(); m6.scaling.copyFrom(cornerQuadScale); m6.position.z = outerBorderScale + 1;
    const m7 = hStrip.clone(); m7.scaling.copyFrom(midQuadScaleVert); m7.position.x = outerBorderScale; m7.position.z = outerBorderScale + 1;
    const m8 = quad.clone(); m8.scaling.copyFrom(cornerQuadScale); m8.position.x = outerBorderScale + 1; m8.position.z = outerBorderScale + 1;
    quad.dispose(true, false); hStrip.dispose(true, false); vStrip.dispose(true, false);
    return Mesh.MergeMeshes([m1, m2, m3, m4, m5, m6, m7, m8], true, true)!;
  }

  private _createTrimMesh(k: number, lengthScale: number): Mesh {
    const m1 = this._createPlaneMesh(k + 1, 1, lengthScale, Seams.None, 1);
    m1.position.set((-k - 1) * lengthScale, 0, -1 * lengthScale);
    const m2 = this._createPlaneMesh(1, k, lengthScale, Seams.None, 1);
    m2.position.set(-1 * lengthScale, 0, (-k - 1) * lengthScale);
    const mesh = Mesh.MergeMeshes([m1, m2], true, true)!;
    mesh.rotationQuaternion = new Quaternion();
    return mesh;
  }

  private _createRingMesh(k: number, lengthScale: number): Mesh {
    const m1 = this._createPlaneMesh(2 * k, (k - 1) >> 1, lengthScale, Seams.Bottom | Seams.Right | Seams.Left);
    const m2 = this._createPlaneMesh(2 * k, (k - 1) >> 1, lengthScale, Seams.Top | Seams.Right | Seams.Left);
    m2.position.set(0, 0, (k + 1 + ((k - 1) >> 1)) * lengthScale);
    const m3 = this._createPlaneMesh((k - 1) >> 1, k + 1, lengthScale, Seams.Left);
    m3.position.set(0, 0, ((k - 1) >> 1) * lengthScale);
    const m4 = this._createPlaneMesh((k - 1) >> 1, k + 1, lengthScale, Seams.Right);
    m4.position.set((k + 1 + ((k - 1) >> 1)) * lengthScale, 0, ((k - 1) >> 1) * lengthScale);
    return Mesh.MergeMeshes([m1, m2, m3, m4], true, true)!;
  }

  private _createPlaneMesh(width: number, height: number, lengthScale: number, seams: Seams = Seams.None, trianglesShift = 0): Mesh {
    const vertices: number[] = [], triangles: number[] = [], normals: number[] = [];
    const vdata = new VertexData();
    vdata.positions = vertices; vdata.indices = triangles; vdata.normals = normals;
    for (let i = 0; i < height + 1; ++i) {
      for (let j = 0; j < width + 1; ++j) {
        let x = j, z = i;
        if ((i === 0 && (seams & Seams.Bottom)) || (i === height && (seams & Seams.Top))) { x = x & ~1; }
        if ((j === 0 && (seams & Seams.Left)) || (j === width && (seams & Seams.Right))) { z = z & ~1; }
        vertices[0 + j * 3 + i * (width + 1) * 3] = x * lengthScale;
        vertices[1 + j * 3 + i * (width + 1) * 3] = 0;
        vertices[2 + j * 3 + i * (width + 1) * 3] = z * lengthScale;
        normals[0 + j * 3 + i * (width + 1) * 3] = 0;
        normals[1 + j * 3 + i * (width + 1) * 3] = 1;
        normals[2 + j * 3 + i * (width + 1) * 3] = 0;
      }
    }
    let tris = 0;
    for (let i = 0; i < height; ++i) {
      for (let j = 0; j < width; ++j) {
        const kk = j + i * (width + 1);
        if ((i + j + trianglesShift) % 2 === 0) {
          triangles[tris++] = kk; triangles[tris++] = kk + width + 2; triangles[tris++] = kk + width + 1;
          triangles[tris++] = kk; triangles[tris++] = kk + 1; triangles[tris++] = kk + width + 2;
        } else {
          triangles[tris++] = kk; triangles[tris++] = kk + 1; triangles[tris++] = kk + width + 1;
          triangles[tris++] = kk + 1; triangles[tris++] = kk + width + 2; triangles[tris++] = kk + width + 1;
        }
      }
    }
    const mesh = new Mesh('clip_plane', this._scene);
    vdata.applyToMesh(mesh, true);
    return mesh;
  }
}
