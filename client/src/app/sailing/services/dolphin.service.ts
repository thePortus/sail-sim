import { Injectable, inject } from '@angular/core';
import { Color3, Matrix, Mesh, Observer, Quaternion, Scene, StandardMaterial, Texture, Vector3 } from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { SceneService } from './scene.service';
import { VesselService } from './vessel.service';
import { TerrainService } from './terrain.service';
import { DolphinSwimPlugin } from './scatter/props/dolphin-swim.plugin';
import { loadScatterGeometry, scatterTextureUrl } from './scatter/asset-loader';

/**
 * Bottlenose dolphins seen as murky shapes swimming UNDERWATER, only in the shallows. They aren't drawn
 * directly on top of the ocean — instead the mesh is named off the `scatter_` prefix so it renders into
 * the ocean's seabed REFRACTION RTT, which the water shader only reveals where the water is shallow. So
 * the dolphins show through clear shallow water and vanish as the bottom drops away (and the pod despawns
 * the moment the boat leaves the shallows).
 *
 * Each dolphin is an INDEPENDENT wanderer (no pod cohesion): it darts around near the boat, eases its
 * depth up and down, and is clamped to stay between the surface and the seabed (never under the bottom).
 * The authored body-wave (swim shader) animates the swimming; this service drives where each one goes.
 * `?nodolphins` disables it.
 */

/** One independent dolphin's swim state (all world-space). */
interface Dolphin {
  x: number; z: number; y: number;     // world position (y < 0 underwater)
  theta: number;                       // travel heading (world, math convention)
  targetTheta: number;                 // wander target heading
  speed: number; targetSpeed: number;  // m/s
  baseY: number;                       // preferred cruising depth
  depthPhase: number; depthRate: number; depthAmp: number;
  retarget: number;                    // countdown to the next wander/dart decision
  scale: number;
  tint: Color3;
}

@Injectable({ providedIn: 'root' })
export class DolphinService {
  private sceneService  = inject(SceneService);
  private vesselService = inject(VesselService);
  private terrain       = inject(TerrainService);

  private mesh: Mesh | null = null;
  private material: StandardMaterial | null = null;
  private observer: Observer<Scene> | null = null;
  private matBuf = new Float32Array(0);
  private colBuf = new Float32Array(0);

  private pod: Dolphin[] = [];
  private active = false;
  private _swimTime = 0;

  // Orientation conventions (flip if needed): a roll about the forward axis rights the side-lying model;
  // FACE_OFFSET aims the nose. (Match the surfaced version we were tuning.)
  private static readonly UPRIGHT = Math.PI / 2;
  private static readonly FACE_OFFSET = Math.PI;

  // Shallows window (water depth, m) the pod lives in; leash keeps them near the boat; clearances keep
  // them off the surface and off the bottom.
  private static readonly DEPTH_MIN = 2.0;
  private static readonly DEPTH_MAX = 22;
  private static readonly LEASH = 42;
  private static readonly SURFACE_CLEAR = 1.0;
  private static readonly SEABED_CLEAR = 0.7;

  private static readonly TINTS: readonly Color3[] = [
    new Color3(1.00, 1.00, 1.00),
    new Color3(0.82, 0.86, 0.94),
    new Color3(0.70, 0.76, 0.86),
    new Color3(0.92, 0.95, 1.00),
  ];

  private readonly _scl = new Vector3();
  private readonly _pos = new Vector3();
  private readonly _quat = new Quaternion();   // scratch — avoids a per-dolphin per-frame allocation
  private readonly _mat = new Matrix();

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene || this.mesh) { return; }

    const mat = new StandardMaterial('dolphin_mat', scene);
    mat.diffuseTexture = new Texture(scatterTextureUrl('dolphin_atlas.png'), scene);
    mat.specularColor = new Color3(0.1, 0.11, 0.13);
    mat.emissiveColor = new Color3(0.12, 0.13, 0.15);
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    new DolphinSwimPlugin(mat);
    this.sceneService.excludeFromPrePass(mat);
    this.material = mat;

    // NOTE: name is NOT `scatter_…` on purpose — that lets the mesh into the ocean's seabed refraction
    // RTT (which excludes scatter/foliage), so the dolphins are revealed through shallow water.
    const mesh = await loadScatterGeometry(scene, 'dolphin_a.glb', 'dolphinPod', mat, false);
    if (!mesh) { console.warn('[dolphins] dolphin_a.glb failed — no dolphins'); return; }
    this.sceneService.excludeFromGlow(mesh);
    mesh.isVisible = true;
    mesh.alwaysSelectAsActiveMesh = true;
    this.mesh = mesh;

    this.observer = scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);
      this._swimTime += dt;
      DolphinSwimPlugin.SWIM.time = this._swimTime;
      this.update(dt);
    });
  }

  private update(dt: number): void {
    const mesh = this.mesh;
    if (!mesh) { return; }
    const vs = this.vesselService.state();
    if (!vs) { return; }
    const bx = vs.x, bz = vs.z;

    // Are we over the shallows? (seabed elevation is negative underwater; depth = −elev.)
    const seabed = this.terrain.getElevation(bx, bz);
    const depth = -seabed;
    const inShallows = depth >= DolphinService.DEPTH_MIN && depth <= DolphinService.DEPTH_MAX;

    if (inShallows && !this.active) { this.spawn(bx, bz); }
    else if (!inShallows && this.active) { this.despawn(); }
    if (!this.active) { return; }

    const t = this._swimTime;
    for (let i = 0; i < this.pod.length; i++) {
      const d = this.pod[i];

      // Wander / dart decisions.
      d.retarget -= dt;
      if (d.retarget <= 0) {
        d.retarget = 1.2 + Math.random() * 3.0;
        d.targetTheta = d.theta + (Math.random() - 0.5) * 2.4;       // turn somewhere new
        d.targetSpeed = 2.0 + Math.random() * 2.8;                   // cruise…
        if (Math.random() < 0.25) { d.targetSpeed = 5.5 + Math.random() * 2.5; }  // …or a dart
        d.baseY = -(1.5 + Math.random() * 5);                        // pick a new cruising depth
      }

      // Leash: if it strays too far from the boat, steer home.
      const dxB = bx - d.x, dzB = bz - d.z;
      const distB = Math.hypot(dxB, dzB);
      if (distB > DolphinService.LEASH) { d.targetTheta = Math.atan2(dzB, dxB); }

      // Don't shoal into land: if the water AHEAD gets too shallow, veer hard back toward deeper water
      // (toward the boat, which is in the navigable shallows).
      const la = 7;
      const aheadDepth = -this.terrain.getElevation(d.x + Math.cos(d.theta) * la, d.z + Math.sin(d.theta) * la);
      const avoiding = aheadDepth < DolphinService.DEPTH_MIN;
      if (avoiding) {
        d.targetTheta = Math.atan2(dzB, dxB);
        d.targetSpeed = Math.min(d.targetSpeed, 2.5);
      }

      // Ease heading + speed (turn sharply when avoiding the shallows), then swim forward.
      d.theta += this.angDiff(d.targetTheta, d.theta) * Math.min(1, dt * (avoiding ? 3.5 : 1.4));
      d.speed += (d.targetSpeed - d.speed) * Math.min(1, dt * 1.5);
      d.x += Math.cos(d.theta) * d.speed * dt;
      d.z += Math.sin(d.theta) * d.speed * dt;

      // Depth: ease toward the cruising depth + a gentle wander, clamped between surface and seabed.
      const sb = this.terrain.getElevation(d.x, d.z);
      let yTarget = d.baseY + Math.sin(t * d.depthRate + d.depthPhase) * d.depthAmp;
      const lo = sb + DolphinService.SEABED_CLEAR;                   // never under the bottom
      const hi = -DolphinService.SURFACE_CLEAR;                      // stay below the surface
      yTarget = hi < lo ? (lo + hi) * 0.5 : Math.max(lo, Math.min(hi, yTarget));
      d.y += (yTarget - d.y) * Math.min(1, dt * 1.5);

      // Face travel direction (Babylon handedness → negate), upright via the roll slot.
      const yaw = -d.theta + DolphinService.FACE_OFFSET;
      this._scl.set(d.scale, d.scale, d.scale);
      this._pos.set(d.x, d.y, d.z);
      Quaternion.RotationYawPitchRollToRef(yaw, DolphinService.UPRIGHT, 0, this._quat);
      Matrix.ComposeToRef(this._scl, this._quat, this._pos, this._mat);
      this._mat.copyToArray(this.matBuf, i * 16);
    }
    mesh.thinInstanceBufferUpdated('matrix');
  }

  /** Shortest-arc difference b−a. */
  private angDiff(b: number, a: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) { d -= Math.PI * 2; } else if (d < -Math.PI) { d += Math.PI * 2; }
    return d;
  }

  /** Spawn a handful of independent dolphins scattered around the boat in the shallows. */
  private spawn(bx: number, bz: number): void {
    const n = 5 + Math.floor(Math.random() * 5);          // 5–9
    this.pod = [];
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, r = 6 + Math.random() * 24;
      this.pod.push({
        x: bx + Math.cos(ang) * r, z: bz + Math.sin(ang) * r, y: -(2 + Math.random() * 4),
        theta: Math.random() * Math.PI * 2, targetTheta: Math.random() * Math.PI * 2,
        speed: 2 + Math.random() * 2, targetSpeed: 2 + Math.random() * 2,
        baseY: -(1.5 + Math.random() * 5),
        depthPhase: Math.random() * Math.PI * 2,
        depthRate: 0.1 + Math.random() * 0.25,
        depthAmp: 0.8 + Math.random() * 2.0,
        retarget: Math.random() * 2,
        scale: 0.9 + Math.random() * 0.4,
        tint: DolphinService.TINTS[Math.floor(Math.random() * DolphinService.TINTS.length)],
      });
    }
    this.matBuf = new Float32Array(n * 16);
    this.colBuf = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const c = this.pod[i].tint, ci = i * 4;
      this.colBuf[ci] = c.r; this.colBuf[ci + 1] = c.g; this.colBuf[ci + 2] = c.b; this.colBuf[ci + 3] = 1;
    }
    this.mesh!.thinInstanceSetBuffer('matrix', this.matBuf, 16, false);
    this.mesh!.thinInstanceSetBuffer('color', this.colBuf, 4, false);
    this.mesh!.thinInstanceCount = n;
    this.active = true;
  }

  /** Leave the shallows → the dolphins are gone. */
  private despawn(): void {
    this.pod = [];
    if (this.mesh) { this.mesh.thinInstanceCount = 0; }
    this.active = false;
  }

  dispose(): void {
    const scene = this.sceneService.scene;
    if (this.observer && scene) { scene.onBeforeRenderObservable.remove(this.observer); }
    this.observer = null;
    this.mesh?.dispose();
    this.material?.dispose();
    this.mesh = null; this.material = null;
    this.pod = []; this.active = false;
  }
}
