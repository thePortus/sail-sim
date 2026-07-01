import {
  DynamicTexture, Material, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Vector3,
} from '@babylonjs/core';

/**
 * Distant-crew billboard impostor (crew realism v2, P5 · track C).
 *
 * Beyond the freeze distance a crew member is only a few pixels tall, yet it still costs several skinned-mesh
 * draw calls (body + garments) and a cloned 24-joint skeleton. This layer replaces ALL of one ship's very-distant
 * crew with a SINGLE thin-instanced, camera-facing sprite — one draw call, no skeletons — so a horizon full of
 * other players' ships costs a few quads instead of hundreds of skinned submeshes. That is C's two goals
 * (impostor + GPU instancing) in one mechanism: the crew ARE the instances.
 *
 * One layer per `CrewHandle`. The billboard mesh lives at SCENE ROOT (identity world matrix) so the per-instance
 * matrices are pure world-space and the camera-facing yaw needs no ship-transform inverse. Each throttled frame
 * the owner walks its members, and for every one that is currently an impostor calls `push(worldPos, camPos)`;
 * `commit()` then uploads only the used slots (`thinInstanceCount` = pushed this frame — hidden crew simply aren't
 * pushed, so no zero-matrix bookkeeping). The sprite is a cheap procedural sailor silhouette; at impostor range a
 * baked photoreal atlas (cf. ship_impostors) would be indistinguishable, so this stays code-only for now.
 */
export class CrewImpostorLayer {
  private static readonly W = 0.6;    // billboard width  (m) — a sailor is ~0.5 m across the shoulders
  private static readonly H = 1.8;    // billboard height (m)

  private mesh: Mesh | null = null;
  private mat: StandardMaterial | null = null;
  private tex: DynamicTexture | null = null;
  private matrices: Float32Array;
  private readonly capacity: number;
  private count = 0;
  // Scratch reused every push so a busy horizon allocates nothing per frame.
  private readonly sScale = new Vector3(CrewImpostorLayer.W, CrewImpostorLayer.H, 1);
  private readonly sPos = new Vector3();
  private readonly sQuat = new Quaternion();
  private readonly sMat = Matrix.Identity();

  constructor(private scene: Scene, capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.matrices = new Float32Array(this.capacity * 16);
  }

  /** Lazily build the plane + material + sprite on the first frame any member goes distant (most ships never do). */
  private ensureBuilt(): void {
    if (this.mesh) { return; }
    this.tex = CrewImpostorLayer.buildSprite(this.scene);
    const mat = new StandardMaterial('crewImpostorMat', this.scene);
    mat.diffuseTexture = this.tex;
    this.tex.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.transparencyMode = Material.MATERIAL_ALPHATEST;   // opaque alpha-test → no transparency sorting, writes depth
    mat.alphaCutOff = 0.5;
    mat.disableLighting = true;                            // unlit; the sprite is pre-shaded, fog darkens it at range
    mat.emissiveTexture = this.tex;                        // show the texture colour at full (diffuse is unlit-black)
    mat.backFaceCulling = false;                           // a billboard is seen from either side as it yaws
    // fogEnabled stays true (default) so distant crew tint into the scene fog like every other impostor.
    this.mat = mat;

    const plane = MeshBuilder.CreatePlane('crewImpostors', { width: 1, height: 1 }, this.scene);
    plane.material = mat;
    plane.isPickable = false;
    plane.doNotSyncBoundingInfo = true;
    plane.alwaysSelectAsActiveMesh = true;                // world-space instances: skip the (wrong) base-mesh frustum test
    plane.thinInstanceSetBuffer('matrix', this.matrices, 16, false);   // non-static: updated per throttled frame
    plane.thinInstanceCount = 0;
    this.mesh = plane;
  }

  /** Start a fresh frame's instance list. */
  begin(): void { this.count = 0; }

  /** Add one impostor at a world position, yawed to face the camera. Silently drops if over capacity. */
  push(x: number, y: number, z: number, camX: number, camZ: number): void {
    if (this.count >= this.capacity) { return; }
    this.ensureBuilt();
    const yaw = Math.atan2(camX - x, camZ - z);           // Y-up billboard: rotate about Y toward the camera
    Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, this.sQuat);
    this.sPos.set(x, y + CrewImpostorLayer.H * 0.5, z);   // plane is centred; lift so its bottom sits at the feet
    Matrix.ComposeToRef(this.sScale, this.sQuat, this.sPos, this.sMat);
    this.sMat.copyToArray(this.matrices, this.count * 16);
    this.count++;
  }

  /** Upload the frame's instances (or hide the layer entirely when none are distant). */
  commit(): void {
    if (!this.mesh) { return; }                            // never built → nothing was ever distant
    this.mesh.thinInstanceCount = this.count;
    if (this.count > 0) { this.mesh.thinInstanceBufferUpdated('matrix'); }
  }

  dispose(): void {
    this.mesh?.dispose(false, false);
    this.mat?.dispose();
    this.tex?.dispose();
    this.mesh = null; this.mat = null; this.tex = null;
  }

  /** A tiny procedural upright-sailor silhouette (skin head, light shirt, dark breeches). Aspect ~1:3 to match the
   *  W:H billboard so the figure isn't stretched. Detail is pointless at impostor range — this just has to read as
   *  "a person standing on the deck" as a few pixels. */
  private static buildSprite(scene: Scene): DynamicTexture {
    const w = 32, h = 96;
    const tex = new DynamicTexture('crewImpostorSprite', { width: w, height: h }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    // breeches / legs (dark) — two columns with a gap
    ctx.fillStyle = '#2a2018';
    ctx.fillRect(cx - 9, 56, 7, 34);
    ctx.fillRect(cx + 2, 56, 7, 34);
    // torso / shirt (weathered off-white)
    ctx.fillStyle = '#cdc4ac';
    ctx.fillRect(cx - 10, 30, 20, 28);
    // arms (shirt, slightly darker for a hint of shading)
    ctx.fillStyle = '#b3aa92';
    ctx.fillRect(cx - 13, 31, 4, 22);
    ctx.fillRect(cx + 9, 31, 4, 22);
    // neck + head (skin)
    ctx.fillStyle = '#a8815e';
    ctx.fillRect(cx - 3, 24, 6, 6);
    ctx.beginPath();
    ctx.ellipse(cx, 18, 7, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    // hat / hair cap (dark) over the crown
    ctx.fillStyle = '#241a12';
    ctx.beginPath();
    ctx.ellipse(cx, 14, 8, 5, 0, Math.PI, 0);
    ctx.fill();
    tex.update(false);
    return tex;
  }
}
