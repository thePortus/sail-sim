import { Injectable, inject } from '@angular/core';
import { Color3, Matrix, Mesh, Observer, Quaternion, Scene, StandardMaterial, Texture, Vector3 } from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { SceneService } from './scene.service';
import { VesselService } from './vessel.service';
import { TerrainService } from './terrain.service';
import { OceanService } from './ocean.service';
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
  effort: number;                      // D1: eased tail-beat effort (0 glide → 1 hard pump), → colour alpha
  group: number;                       // D2: which pod (BOIDS cohesion/alignment/separation is per-pod)
  bank: number;                        // D2: eased banking roll into turns (rad)
  bowSlot: number;                     // D3: bow-riding station (-1 = not riding; else a formation slot index)
  breaching: boolean;                  // D4: mid-leap (ballistic arc above the surface)
  breachVy: number;                    // D4: current vertical velocity during a leap (m/s)
  scale: number;
  homeX: number; homeZ: number;        // this pod's home, as an offset from the boat (groups the dolphins)
  tint: Color3;
}

@Injectable({ providedIn: 'root' })
export class DolphinService {
  private sceneService  = inject(SceneService);
  private vesselService = inject(VesselService);
  private terrain       = inject(TerrainService);
  private ocean         = inject(OceanService);

  // D5 — three pose meshes sharing one material: [0] cruise (dolphin_a, level), [1] arc (dolphin_b, rising leap),
  // [2] dive (dolphin_c, nose-down entry). Each dolphin is written into whichever mesh matches its current pose
  // (a breaching dolphin uses the arc going UP and the dive coming DOWN), so leaps look like real arcing dolphins.
  private meshes: (Mesh | null)[] = [];
  private mats: Float32Array[] = [];
  private cols: Float32Array[] = [];
  private material: StandardMaterial | null = null;
  private observer: Observer<Scene> | null = null;

  private pod: Dolphin[] = [];
  private active = false;
  private _swimTime = 0;

  // Cannon-fire panic: while this counts down the pod bolts away from the shot, fast, on a relaxed leash —
  // then settles back. They never despawn (presence preserved); they just scatter for a few seconds.
  private _panic = 0;
  private _panicX = 0;
  private _panicZ = 0;
  private static readonly PANIC_TIME = 5.5;

  // Orientation conventions (flip if needed): a roll about the forward axis rights the side-lying model;
  // FACE_OFFSET aims the nose. (Match the surfaced version we were tuning.)
  private static readonly UPRIGHT = Math.PI / 2;
  private static readonly FACE_OFFSET = Math.PI;

  // Shallows window (water depth, m) the pod lives in; leash keeps them near the boat; clearances keep
  // them off the surface and off the bottom.
  private static readonly DEPTH_MIN = 2.0;
  private static readonly DEPTH_MAX = 22;
  private static readonly LEASH = 42;
  private static readonly PODS = 2;        // number of separate dolphin pods spawned near the boat
  private static readonly SURFACE_CLEAR = 1.0;
  private static readonly SEABED_CLEAR = 0.7;

  // D2 — pod BOIDS (cohesion/alignment/separation, per pod) + banking roll into turns.
  private static readonly SEP_R     = 6;       // m — push off podmates closer than this (no clipping/stacking)
  private static readonly W_WANDER  = 0.5;     // pull toward the per-dolphin wander heading (keeps variety)
  private static readonly W_COH     = 0.5;     // toward the pod centroid (holds the pod together)
  private static readonly W_ALI     = 0.55;    // match the pod's mean heading (coherent travel)
  private static readonly W_SEP     = 1.8;     // push off close podmates
  private static readonly TURN_RATE = 1.7;     // rad/s — max yaw rate (momentum-limited turns)
  private static readonly BANK_K    = 0.55;    // turn-rate → banking roll
  private static readonly MAX_BANK  = 0.6;     // rad (~34°) max roll into a hard turn
  private static readonly BANK_EASE = 3.0;     // how fast the roll catches up to the turn

  // D3 — bow-riding: dolphins near the bow of a MOVING boat peel off to ride the pressure wave, pacing the
  // hull just ahead/abeam the stem and surfacing shallow, then rejoin the pod when she slows.
  private static readonly BOWRIDE_SPEED_MIN = 1.4;   // m/s boat speed to trigger (≈2.7 kn)
  private static readonly BOW_AHEAD   = 8;     // m ahead of the boat origin for the bow point
  private static readonly BOW_SPACING = 4;     // m between rider ranks (staggered ahead of the bow)
  private static readonly BOW_SIDE    = 2.6;   // m lateral offset (riders alternate sides of the stem)
  private static readonly BOWRIDE_RANGE = 30;  // m from the bow a dolphin can be recruited
  private static readonly MAX_RIDERS  = 6;
  private static readonly BOWRIDE_DEPTH = -0.9;  // shallow — bow-riders skim just under the surface

  // D4 — breaching: an occasional ballistic leap clear of the surface (the dolphin is in the main render; the
  // ocean only occludes it while submerged, so an above-water arc shows for free), with a splash on exit + entry.
  private static readonly BREACH_CHANCE   = 0.05;   // per-second chance per eligible cruising dolphin
  private static readonly BREACH_VY0      = 7.5;    // launch vertical velocity (m/s)
  private static readonly BREACH_G        = 13;     // arc gravity (m/s²)
  private static readonly BREACH_REENTRY  = -1.2;   // depth (m) at which the leap ends and normal swim resumes
  private static readonly BREACH_MIN_DEPTH = 3;     // only breach over water at least this deep (safe re-entry)
  private static readonly MAX_BREACH      = 2;      // concurrent leaps across both pods
  private static readonly BREACH_PITCH_SIGN = 1;    // ⚠️ LIVE-VERIFY: flip if the nose pitches the wrong way mid-arc

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
    if (!scene || this.meshes.length) { return; }

    const mat = new StandardMaterial('dolphin_mat', scene);
    mat.diffuseTexture = new Texture(scatterTextureUrl('dolphin_atlas.png'), scene);
    mat.specularColor = new Color3(0.1, 0.11, 0.13);
    mat.emissiveColor = new Color3(0.12, 0.13, 0.15);
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    new DolphinSwimPlugin(mat);
    this.sceneService.excludeFromPrePass(mat);
    this.material = mat;

    // NOTE: names are NOT `scatter_…` on purpose — that lets the meshes into the ocean's seabed refraction
    // RTT (which excludes scatter/foliage), so the dolphins are revealed through shallow water. Three pose
    // variants (cruise / arc / dive) share this material; each frame every dolphin is routed to the right one.
    const files: [string, string][] = [
      ['dolphin_a.glb', 'dolphinPod'],     // cruise (level)
      ['dolphin_b.glb', 'dolphinArc'],     // arc (rising leap)
      ['dolphin_c.glb', 'dolphinDive'],    // dive (nose-down entry)
    ];
    for (const [file, name] of files) {
      const mesh = await loadScatterGeometry(scene, file, name, mat, false);
      if (!mesh) { console.warn(`[dolphins] ${file} failed`); this.meshes.push(null); continue; }
      this.sceneService.excludeFromGlow(mesh);
      mesh.isVisible = true;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.thinInstanceCount = 0;
      this.meshes.push(mesh);
    }
    if (!this.meshes[0]) { console.warn('[dolphins] cruise mesh failed — no dolphins'); return; }

    this.observer = scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);
      this._swimTime += dt;
      DolphinSwimPlugin.SWIM.time = this._swimTime;
      this.update(dt);
    });
  }

  private update(dt: number): void {
    if (!this.meshes[0]) { return; }
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

    if (this._panic > 0) { this._panic = Math.max(0, this._panic - dt); }
    const panicking = this._panic > 0;
    const leash = panicking ? DolphinService.LEASH * 1.7 : DolphinService.LEASH;   // let them scatter wide

    const t = this._swimTime;
    const G = DolphinService.PODS;

    // D3 — bow-ride management: recruit/release riders around the bow of a moving boat.
    const boatSpeed = Math.abs(vs.speed);
    const hr = vs.heading * Math.PI / 180;
    const fwdx = Math.sin(hr), fwdz = Math.cos(hr);     // boat forward (heading 0=N=+Z, 90=E=+X)
    const rgtx = fwdz, rgtz = -fwdx;                    // boat starboard (perp to forward)
    const bowX = bx + fwdx * DolphinService.BOW_AHEAD, bowZ = bz + fwdz * DolphinService.BOW_AHEAD;
    const wantRiders = boatSpeed > DolphinService.BOWRIDE_SPEED_MIN && !panicking;
    const taken = new Array(DolphinService.MAX_RIDERS).fill(false);
    for (const d of this.pod) {
      if (d.bowSlot < 0) { continue; }
      const tooFar = Math.hypot(d.x - bx, d.z - bz) > DolphinService.BOWRIDE_RANGE * 1.7;
      if (!wantRiders || tooFar) { d.bowSlot = -1; } else { taken[d.bowSlot] = true; }
    }
    if (wantRiders) {
      for (const d of this.pod) {
        if (d.bowSlot >= 0) { continue; }
        if (Math.hypot(d.x - bowX, d.z - bowZ) > DolphinService.BOWRIDE_RANGE) { continue; }
        let slot = -1;
        for (let k = 0; k < DolphinService.MAX_RIDERS; k++) { if (!taken[k]) { slot = k; break; } }
        if (slot < 0) { break; }
        taken[slot] = true; d.bowSlot = slot;
      }
    }

    // D2 pass 1 — per-pod aggregates (centroid + mean heading) for cohesion & alignment.
    const gcx = new Array(G).fill(0), gcz = new Array(G).fill(0);
    const ghx = new Array(G).fill(0), ghz = new Array(G).fill(0);
    const gct = new Array(G).fill(0);
    let breachCount = 0;
    for (const d of this.pod) {
      const g = d.group;
      gcx[g] += d.x; gcz[g] += d.z;
      ghx[g] += Math.cos(d.theta); ghz[g] += Math.sin(d.theta);
      gct[g]++;
      if (d.breaching) { breachCount++; }
    }
    for (let g = 0; g < G; g++) { if (gct[g] > 0) { gcx[g] /= gct[g]; gcz[g] /= gct[g]; } }

    // D2 pass 2 — steer (BOIDS + leash/avoid/panic) and integrate each dolphin.
    const counts = [0, 0, 0];   // D5: per-pose-mesh running instance counts (cruise / arc / dive)
    for (let i = 0; i < this.pod.length; i++) {
      const d = this.pod[i];
      const g = d.group;

      // Periodic dart/depth decisions (speed + cruising-depth variety; heading now comes from BOIDS).
      d.retarget -= dt;
      if (d.retarget <= 0) {
        d.retarget = 1.2 + Math.random() * 3.0;
        d.targetTheta = d.theta + (Math.random() - 0.5) * 1.6;        // a loose wander bias
        d.targetSpeed = 2.0 + Math.random() * 2.6;                    // cruise…
        if (Math.random() < 0.22) { d.targetSpeed = 5.5 + Math.random() * 2.5; }   // …or a dart
        d.baseY = -(1.5 + Math.random() * 5);
      }

      // Steering vector (world XZ): wander + cohesion + alignment + separation.
      let sx = Math.cos(d.targetTheta) * DolphinService.W_WANDER;
      let sz = Math.sin(d.targetTheta) * DolphinService.W_WANDER;
      const ccx = gcx[g] - d.x, ccz = gcz[g] - d.z, cd = Math.hypot(ccx, ccz) || 1;
      sx += (ccx / cd) * DolphinService.W_COH; sz += (ccz / cd) * DolphinService.W_COH;
      const ah = Math.hypot(ghx[g], ghz[g]) || 1;
      sx += (ghx[g] / ah) * DolphinService.W_ALI; sz += (ghz[g] / ah) * DolphinService.W_ALI;
      for (const o of this.pod) {
        if (o === d || o.group !== g) { continue; }
        const ox = d.x - o.x, oz = d.z - o.z, od2 = ox * ox + oz * oz;
        if (od2 > 1e-4 && od2 < DolphinService.SEP_R * DolphinService.SEP_R) {
          const inv = 1 / Math.sqrt(od2);
          sx += ox * inv * inv * DolphinService.W_SEP * DolphinService.SEP_R;
          sz += oz * inv * inv * DolphinService.W_SEP * DolphinService.SEP_R;
        }
      }

      // Leash to the pod home (boat + pod offset) keeps the pods near the boat and apart from each other.
      const dxB = (bx + d.homeX) - d.x, dzB = (bz + d.homeZ) - d.z;
      const distB = Math.hypot(dxB, dzB);
      if (distB > leash) { sx += (dxB / distB) * 2.5; sz += (dzB / distB) * 2.5; }

      // D3 — bow-riding override: steer to hold a staggered station ahead of the bow, pace the boat, skim shallow.
      let riding = false;
      if (d.bowSlot >= 0) {
        const rank = Math.floor(d.bowSlot / 2);
        const side = (d.bowSlot % 2 === 0) ? 1 : -1;
        const tx = bowX + fwdx * (rank * DolphinService.BOW_SPACING) + rgtx * (side * DolphinService.BOW_SIDE);
        const tz = bowZ + fwdz * (rank * DolphinService.BOW_SPACING) + rgtz * (side * DolphinService.BOW_SIDE);
        sx = tx - d.x; sz = tz - d.z;
        d.targetSpeed = Math.max(boatSpeed + 0.6, 3.0);
        d.baseY = DolphinService.BOWRIDE_DEPTH;
        riding = true;
      }

      // Don't shoal into land: veer hard back toward deeper water (toward the boat) if it's shallow ahead.
      const la = 7;
      const aheadDepth = -this.terrain.getElevation(d.x + Math.cos(d.theta) * la, d.z + Math.sin(d.theta) * la);
      const avoiding = aheadDepth < DolphinService.DEPTH_MIN;
      if (avoiding) {
        sx = dxB; sz = dzB;                                            // override → back to deep water
        d.targetSpeed = Math.min(d.targetSpeed, 2.5);
      } else if (panicking && distB <= leash) {
        // Bolt from the shot, fanned per dolphin so the pod scatters rather than streaming as one.
        const fa = Math.atan2(d.z - this._panicZ, d.x - this._panicX) + (d.depthPhase - Math.PI) * 0.15;
        sx = Math.cos(fa) * 3; sz = Math.sin(fa) * 3;
        d.targetSpeed = 6.5 + Math.random() * 2.0;
      }

      // Desired heading from the steering vector → turn-rate-limited ease, with a banking roll into the turn.
      const desired = Math.atan2(sz, sx);
      const maxTurn = DolphinService.TURN_RATE * dt * (avoiding ? 2.2 : panicking ? 1.8 : riding ? 2.0 : 1);
      let turn = this.angDiff(desired, d.theta);
      turn = Math.max(-maxTurn, Math.min(maxTurn, turn));
      d.theta += turn;
      const bankTarget = Math.max(-DolphinService.MAX_BANK, Math.min(DolphinService.MAX_BANK,
        -(turn / Math.max(1e-4, dt)) * DolphinService.BANK_K));
      d.bank += (bankTarget - d.bank) * Math.min(1, dt * DolphinService.BANK_EASE);

      d.speed += (d.targetSpeed - d.speed) * Math.min(1, dt * 1.5);
      d.x += Math.cos(d.theta) * d.speed * dt;
      d.z += Math.sin(d.theta) * d.speed * dt;

      // Depth / D4 breaching. A breaching dolphin follows a ballistic arc ABOVE the surface (allowed past y=0 —
      // it's in the main render, only the ocean occludes it while submerged); a ring-splash marks exit + re-entry.
      const sb = this.terrain.getElevation(d.x, d.z);
      if (d.breaching) {
        const prevY = d.y;
        d.breachVy -= DolphinService.BREACH_G * dt;
        d.y += d.breachVy * dt;
        if (prevY < 0 && d.y >= 0) { this.ocean.addSplash(d.x, d.z); }        // bursts clear of the water
        if (prevY >= 0 && d.y < 0) { this.ocean.addSplash(d.x, d.z); }        // clean re-entry
        if (d.y <= DolphinService.BREACH_REENTRY && d.breachVy < 0) { d.breaching = false; }
      } else {
        let yTarget = d.baseY + Math.sin(t * d.depthRate + d.depthPhase) * d.depthAmp;
        const lo = sb + DolphinService.SEABED_CLEAR;                  // never under the bottom
        const hi = -DolphinService.SURFACE_CLEAR;                     // stay below the surface
        yTarget = hi < lo ? (lo + hi) * 0.5 : Math.max(lo, Math.min(hi, yTarget));
        d.y += (yTarget - d.y) * Math.min(1, dt * 1.5);
        // Occasionally launch a leap: cruising forward, not riding/fleeing/avoiding, over deep-enough water.
        if (!panicking && !avoiding && d.bowSlot < 0 && d.speed > 2.2 && sb < -DolphinService.BREACH_MIN_DEPTH
            && breachCount < DolphinService.MAX_BREACH && Math.random() < DolphinService.BREACH_CHANCE * dt) {
          d.breaching = true; d.breachVy = DolphinService.BREACH_VY0; d.targetSpeed = 6; breachCount++;
        }
      }

      // D1 — tail EFFORT (→ instance-colour alpha, read by DolphinSwimPlugin): darts/flees pump hard, cruise glides.
      const effortTarget = Math.max(0.15, Math.min(1, (d.speed - 1.2) / 6));
      d.effort += (effortTarget - d.effort) * Math.min(1, dt * 4);

      // Orientation: yaw to travel, righting pitch (UPRIGHT) + leap pitch when breaching, banking roll.
      // (Bank + leap-pitch slot/sign may need a live tweak.)
      const leapPitch = d.breaching ? Math.atan2(d.breachVy, Math.max(2, d.speed)) * DolphinService.BREACH_PITCH_SIGN : 0;
      const yaw = -d.theta + DolphinService.FACE_OFFSET;
      this._scl.set(d.scale, d.scale, d.scale);
      this._pos.set(d.x, d.y, d.z);
      Quaternion.RotationYawPitchRollToRef(yaw, DolphinService.UPRIGHT + leapPitch, d.bank, this._quat);
      Matrix.ComposeToRef(this._scl, this._quat, this._pos, this._mat);

      // D5 — route to the pose mesh: cruise (0) normally, arc (1) rising in a leap, dive (2) on the way down.
      // Falls back to cruise if the arc/dive GLB failed to load. Tint (rgb) + effort (alpha) ride the colour buffer.
      let mi = !d.breaching ? 0 : (d.breachVy > 0 ? 1 : 2);
      if (!this.meshes[mi]) { mi = 0; }
      const ci = counts[mi];
      this._mat.copyToArray(this.mats[mi], ci * 16);
      const cb = this.cols[mi], co = ci * 4, tc = d.tint;
      cb[co] = tc.r; cb[co + 1] = tc.g; cb[co + 2] = tc.b; cb[co + 3] = d.effort;
      counts[mi]++;
    }
    for (let m = 0; m < this.meshes.length; m++) {
      const mesh = this.meshes[m];
      if (!mesh) { continue; }
      mesh.thinInstanceCount = counts[m];
      if (counts[m] > 0) { mesh.thinInstanceBufferUpdated('matrix'); mesh.thinInstanceBufferUpdated('color'); }
    }
  }

  /**
   * Spook the pod with a cannon shot near (x,z): they bolt away from it, fast, for a few seconds, then
   * settle back. Does NOT despawn them — their presence is preserved. No-op if no pod is currently out.
   */
  scatterFrom(x: number, z: number): void {
    if (!this.active) { return; }
    this._panic = DolphinService.PANIC_TIME;
    this._panicX = x; this._panicZ = z;
    for (const d of this.pod) {
      d.targetTheta = Math.atan2(d.z - z, d.x - x) + (d.depthPhase - Math.PI) * 0.15;
      d.targetSpeed = 6.5 + Math.random() * 2.0;
      d.retarget = Math.max(d.retarget, 1.5);   // don't let a wander decision immediately override the bolt
    }
  }

  /** Pod centroids (world XZ) of the currently-active pods — fish schools flee these (F4 predator/prey).
   *  Empty when no pod is out. */
  getPodCenters(): { x: number; z: number }[] {
    if (!this.active) { return []; }
    const G = DolphinService.PODS;
    const cx = new Array(G).fill(0), cz = new Array(G).fill(0), ct = new Array(G).fill(0);
    for (const d of this.pod) { cx[d.group] += d.x; cz[d.group] += d.z; ct[d.group]++; }
    const out: { x: number; z: number }[] = [];
    for (let g = 0; g < G; g++) { if (ct[g] > 0) { out.push({ x: cx[g] / ct[g], z: cz[g] / ct[g] }); } }
    return out;
  }

  /** Shortest-arc difference b−a. */
  private angDiff(b: number, a: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) { d -= Math.PI * 2; } else if (d < -Math.PI) { d += Math.PI * 2; }
    return d;
  }

  /** Spawn TWO pods of independent dolphins in the shallows — each pod clusters around its own home
   *  point (offset from the boat, kept apart) so the sea reads as livelier than one dense group. */
  private spawn(bx: number, bz: number): void {
    this.pod = [];
    const baseAng = Math.random() * Math.PI * 2;
    for (let g = 0; g < DolphinService.PODS; g++) {
      // Pod home: a point 16–38 m from the boat, with the pods fanned to opposite-ish sides.
      const gAng  = baseAng + (g * Math.PI * 2) / DolphinService.PODS + (Math.random() - 0.5) * 0.8;
      const gDist = 16 + Math.random() * 22;
      const homeX = Math.cos(gAng) * gDist, homeZ = Math.sin(gAng) * gDist;
      const members = 5 + Math.floor(Math.random() * 4);          // 5–8 per pod (≈10–16 total)
      for (let i = 0; i < members; i++) {
        const ang = Math.random() * Math.PI * 2, r = 4 + Math.random() * 16;
        this.pod.push({
          x: bx + homeX + Math.cos(ang) * r, z: bz + homeZ + Math.sin(ang) * r, y: -(2 + Math.random() * 4),
          theta: Math.random() * Math.PI * 2, targetTheta: Math.random() * Math.PI * 2,
          speed: 2 + Math.random() * 2, targetSpeed: 2 + Math.random() * 2,
          baseY: -(1.5 + Math.random() * 5),
          depthPhase: Math.random() * Math.PI * 2,
          depthRate: 0.1 + Math.random() * 0.25,
          depthAmp: 0.8 + Math.random() * 2.0,
          retarget: Math.random() * 2,
          effort: 0.4,
          group: g,
          bank: 0,
          bowSlot: -1,
          breaching: false,
          breachVy: 0,
          scale: 0.9 + Math.random() * 0.4,
          homeX, homeZ,
          tint: DolphinService.TINTS[Math.floor(Math.random() * DolphinService.TINTS.length)],
        });
      }
    }
    // D5 — each pose mesh gets its own matrix+colour buffers sized for the WHOLE pod (worst case: every
    // dolphin on one mesh). Counts are 0 until update() routes dolphins per frame.
    const n = this.pod.length;
    this.mats = []; this.cols = [];
    for (let m = 0; m < this.meshes.length; m++) {
      const mat = new Float32Array(n * 16), col = new Float32Array(n * 4);
      this.mats.push(mat); this.cols.push(col);
      const mesh = this.meshes[m];
      if (!mesh) { continue; }
      mesh.thinInstanceSetBuffer('matrix', mat, 16, false);
      mesh.thinInstanceSetBuffer('color', col, 4, false);
      mesh.thinInstanceCount = 0;
    }
    this.active = true;
  }

  /** Leave the shallows → the dolphins are gone. */
  private despawn(): void {
    this.pod = [];
    for (const mesh of this.meshes) { if (mesh) { mesh.thinInstanceCount = 0; } }
    this.active = false;
  }

  dispose(): void {
    const scene = this.sceneService.scene;
    if (this.observer && scene) { scene.onBeforeRenderObservable.remove(this.observer); }
    this.observer = null;
    for (const mesh of this.meshes) { mesh?.dispose(); }
    this.meshes = []; this.mats = []; this.cols = [];
    this.material?.dispose();
    this.material = null;
    this.pod = []; this.active = false;
  }
}
