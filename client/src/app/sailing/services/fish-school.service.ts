import { Injectable, inject } from '@angular/core';
import { Color3, Matrix, Mesh, Observer, Quaternion, Scene, StandardMaterial, Texture, Vector3, VertexBuffer } from '@babylonjs/core';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { SceneService } from './scene.service';
import { VesselService } from './vessel.service';
import { TerrainService } from './terrain.service';
import { DolphinService } from './dolphin.service';
import { FishSwimPlugin } from './scatter/props/fish-swim.plugin';
import { loadScatterGeometry, scatterTextureUrl } from './scatter/asset-loader';

/**
 * Schools of small reef/bait fish seen as colored shapes swimming in the clear shallows — like the dolphins,
 * the school meshes are kept OFF the `scatter_` name prefix so they render into the ocean's seabed-refraction
 * RTT (revealed only through shallow water; gone once the boat leaves the shallows). Each SCHOOL is a tight
 * BOIDS bait-ball of one species (one of four colors from the shared `fish_atlas`, picked by baking that
 * species' atlas ROW into the school mesh's UVs), with a per-fish lateral-swim (FishSwimPlugin) whose effort
 * rides the instance-colour alpha. `?nofish` disables it.
 */

/** One fish within a school (world-space). */
interface Fish {
  x: number; z: number; y: number;
  theta: number; targetTheta: number;
  speed: number; targetSpeed: number;
  baseY: number; depthPhase: number; depthRate: number; depthAmp: number;
  retarget: number; effort: number; bank: number;
}

/** A bait-ball: a species + body, its own mesh (UV-baked to the species row), and its members. */
interface School {
  mesh: Mesh; species: number;
  homeX: number; homeZ: number;          // cluster home as an offset from the boat
  fish: Fish[]; matBuf: Float32Array; colBuf: Float32Array;
  scl: number;
  boiling: boolean; boilT: number;       // F4: surface-boil state (a feeding-frenzy churn near the surface)
}

@Injectable({ providedIn: 'root' })
export class FishSchoolService {
  private sceneService  = inject(SceneService);
  private vesselService = inject(VesselService);
  private terrain       = inject(TerrainService);
  private dolphins      = inject(DolphinService);

  private baseA: Mesh | null = null;     // slim body template (silver/olive)
  private baseB: Mesh | null = null;     // deep body template (reef/sergeant)
  private material: StandardMaterial | null = null;
  private observer: Observer<Scene> | null = null;

  private schools: School[] = [];
  private active = false;
  private _swimTime = 0;
  private _panic = 0; private _panicX = 0; private _panicZ = 0;
  private static readonly PANIC_TIME = 4.5;

  // Species → atlas ROW (the atlas is 4 stacked rows: 0 silver, 1 reef, 2 sergeant, 3 olive) + which body.
  // ⚠️ LIVE-VERIFY: if the colours land on the wrong species, the glTF V-flip reversed the rows → set ROW_FLIP.
  private static readonly SPECIES = [
    { row: 0, body: 'a' as const },   // silver — slim
    { row: 1, body: 'b' as const },   // reef — deep
    { row: 2, body: 'b' as const },   // sergeant — deep
    { row: 3, body: 'a' as const },   // olive — slim
  ];
  private static readonly ROW_FLIP = false;   // flip to true if rows render inverted in-engine
  private static readonly NSPECIES = 4;

  // Shallows window + tuning (mirrors the dolphins).
  private static readonly DEPTH_MIN = 2.0;
  private static readonly DEPTH_MAX = 22;
  private static readonly LEASH = 36;
  private static readonly SURFACE_CLEAR = 1.2;
  private static readonly SEABED_CLEAR = 0.6;
  // ⚠️ LIVE-VERIFY orientation: fish authored forward +X / up +Y. If they swim tail-first flip FACE_OFFSET to π;
  // if banking tips them the wrong way swap the bank slot / sign below.
  private static readonly FACE_OFFSET = 0;

  // Bait-ball BOIDS — tighter than the dolphin pods (small, dense, schooling).
  private static readonly SEP_R     = 1.4;
  private static readonly W_WANDER  = 0.35;
  private static readonly W_COH     = 0.9;
  private static readonly W_ALI     = 0.7;
  private static readonly W_SEP     = 1.6;
  private static readonly TURN_RATE = 2.6;
  private static readonly BANK_K    = 0.3;
  private static readonly MAX_BANK  = 0.5;
  private static readonly BANK_EASE = 4.0;

  // F4 — predator/prey: flee the player's hull, and ball-up + bolt + boil to the surface near a dolphin pod.
  private static readonly HULL_FLEE_R = 12;    // m — fish within this of the boat dart away from it
  private static readonly HULL_FLEE_W = 3.5;
  private static readonly THREAT_R    = 16;    // m — a dolphin pod centre this close alarms the school
  private static readonly THREAT_FLEE_W = 4.5;
  private static readonly BOLT_SPEED  = 4.5;   // m/s a panicked/alarmed fish bolts at
  private static readonly BOIL_DEPTH  = -0.7;  // a boiling bait-ball churns just under the surface

  private readonly _scl = new Vector3();
  private readonly _pos = new Vector3();
  private readonly _quat = new Quaternion();
  private readonly _mat = new Matrix();

  async init(): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene || this.material) { return; }

    const mat = new StandardMaterial('fish_mat', scene);
    mat.diffuseTexture = new Texture(scatterTextureUrl('fish_atlas.png'), scene);
    mat.specularColor = new Color3(0.12, 0.13, 0.15);
    mat.emissiveColor = new Color3(0.10, 0.11, 0.13);
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    new FishSwimPlugin(mat);
    this.sceneService.excludeFromPrePass(mat);
    this.material = mat;

    // Base templates (hidden; school meshes are UV-baked clones of these). NOT `scatter_` → into the refraction RTT.
    this.baseA = await loadScatterGeometry(scene, 'fish_a.glb', 'fishBaseA', mat, false);
    this.baseB = await loadScatterGeometry(scene, 'fish_b.glb', 'fishBaseB', mat, false);
    if (!this.baseA || !this.baseB) { console.warn('[fish] fish_a/b.glb failed — no fish schools'); return; }

    this.observer = scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);
      this._swimTime += dt;
      FishSwimPlugin.SWIM.time = this._swimTime;
      this.update(dt);
    });
  }

  private update(dt: number): void {
    const vs = this.vesselService.state();
    if (!vs || !this.baseA) { return; }
    const bx = vs.x, bz = vs.z;

    const depth = -this.terrain.getElevation(bx, bz);
    const inShallows = depth >= FishSchoolService.DEPTH_MIN && depth <= FishSchoolService.DEPTH_MAX;
    if (inShallows && !this.active) { this.spawn(bx, bz); }
    else if (!inShallows && this.active) { this.despawn(); }
    if (!this.active) { return; }

    if (this._panic > 0) { this._panic = Math.max(0, this._panic - dt); }
    const panicking = this._panic > 0;
    const leash = panicking ? FishSchoolService.LEASH * 1.6 : FishSchoolService.LEASH;
    const t = this._swimTime;
    const threats = this.dolphins.getPodCenters();   // F4: dolphin pods the schools flee from

    for (const sc of this.schools) {
      // Per-school centroid + mean heading (the whole bait-ball is one BOIDS group).
      let cx = 0, cz = 0, hx = 0, hz = 0;
      for (const f of sc.fish) { cx += f.x; cz += f.z; hx += Math.cos(f.theta); hz += Math.sin(f.theta); }
      const n = sc.fish.length; cx /= n; cz /= n;

      // F4 — nearest dolphin-pod threat to the school + surface-boil state. A hunted ball boils to the surface.
      let thx = 0, thz = 0, thd = Infinity;
      for (const pc of threats) { const d = Math.hypot(cx - pc.x, cz - pc.z); if (d < thd) { thd = d; thx = pc.x; thz = pc.z; } }
      const alarm = thd < FishSchoolService.THREAT_R ? (1 - thd / FishSchoolService.THREAT_R) : 0;   // 0..1
      sc.boilT -= dt;
      if (sc.boilT <= 0) { sc.boiling = Math.random() < 0.18; sc.boilT = sc.boiling ? 2 + Math.random() * 3 : 4 + Math.random() * 6; }
      const boil = sc.boiling || alarm > 0.25;

      for (let i = 0; i < n; i++) {
        const f = sc.fish[i];
        f.retarget -= dt;
        if (f.retarget <= 0) {
          f.retarget = 1.0 + Math.random() * 2.4;
          f.targetTheta = f.theta + (Math.random() - 0.5) * 1.4;
          f.targetSpeed = 1.4 + Math.random() * 1.6;
          if (Math.random() < 0.15) { f.targetSpeed = 3.2 + Math.random() * 1.8; }   // a flick
          f.baseY = -(1.2 + Math.random() * 4);
        }

        let sx = Math.cos(f.targetTheta) * FishSchoolService.W_WANDER;
        let sz = Math.sin(f.targetTheta) * FishSchoolService.W_WANDER;
        const ccx = cx - f.x, ccz = cz - f.z, cd = Math.hypot(ccx, ccz) || 1;
        sx += (ccx / cd) * FishSchoolService.W_COH; sz += (ccz / cd) * FishSchoolService.W_COH;
        const ah = Math.hypot(hx, hz) || 1;
        sx += (hx / ah) * FishSchoolService.W_ALI; sz += (hz / ah) * FishSchoolService.W_ALI;
        for (let j = 0; j < n; j++) {
          if (j === i) { continue; }
          const o = sc.fish[j];
          const ox = f.x - o.x, oz = f.z - o.z, od2 = ox * ox + oz * oz;
          if (od2 > 1e-4 && od2 < FishSchoolService.SEP_R * FishSchoolService.SEP_R) {
            const inv = 1 / Math.sqrt(od2);
            sx += ox * inv * inv * FishSchoolService.W_SEP * FishSchoolService.SEP_R;
            sz += oz * inv * inv * FishSchoolService.W_SEP * FishSchoolService.SEP_R;
          }
        }

        const dxB = (bx + sc.homeX) - f.x, dzB = (bz + sc.homeZ) - f.z;
        const distB = Math.hypot(dxB, dzB);
        if (distB > leash) { sx += (dxB / distB) * 2.2; sz += (dzB / distB) * 2.2; }

        // F4 — flee the player's hull when it bears down on the school.
        const hdx = f.x - bx, hdz = f.z - bz, hd = Math.hypot(hdx, hdz) || 1;
        if (hd < FishSchoolService.HULL_FLEE_R) {
          const w = (1 - hd / FishSchoolService.HULL_FLEE_R) * FishSchoolService.HULL_FLEE_W;
          sx += (hdx / hd) * w; sz += (hdz / hd) * w;
          f.targetSpeed = Math.max(f.targetSpeed, FishSchoolService.BOLT_SPEED * 0.7);
        }
        // F4 — dolphin threat: bolt away AND ball-up (extra cohesion tightens the bait-ball).
        if (alarm > 0) {
          const tdx = f.x - thx, tdz = f.z - thz, td = Math.hypot(tdx, tdz) || 1;
          sx += (tdx / td) * FishSchoolService.THREAT_FLEE_W * alarm;
          sz += (tdz / td) * FishSchoolService.THREAT_FLEE_W * alarm;
          sx += (ccx / cd) * FishSchoolService.W_COH * alarm * 1.6;
          sz += (ccz / cd) * FishSchoolService.W_COH * alarm * 1.6;
          f.targetSpeed = Math.max(f.targetSpeed, FishSchoolService.BOLT_SPEED);
        }

        const la = 6;
        const aheadDepth = -this.terrain.getElevation(f.x + Math.cos(f.theta) * la, f.z + Math.sin(f.theta) * la);
        const avoiding = aheadDepth < FishSchoolService.DEPTH_MIN;
        if (avoiding) {
          sx = dxB; sz = dzB;
          f.targetSpeed = Math.min(f.targetSpeed, 1.6);
        } else if (panicking && distB <= leash) {
          const fa = Math.atan2(f.z - this._panicZ, f.x - this._panicX) + (f.depthPhase - Math.PI) * 0.2;
          sx = Math.cos(fa) * 3; sz = Math.sin(fa) * 3;
          f.targetSpeed = 4.0 + Math.random() * 1.6;
        }

        const desired = Math.atan2(sz, sx);
        const maxTurn = FishSchoolService.TURN_RATE * dt * (avoiding ? 2.0 : panicking ? 1.8 : 1);
        let turn = this.angDiff(desired, f.theta);
        turn = Math.max(-maxTurn, Math.min(maxTurn, turn));
        f.theta += turn;
        const bankTarget = Math.max(-FishSchoolService.MAX_BANK, Math.min(FishSchoolService.MAX_BANK,
          -(turn / Math.max(1e-4, dt)) * FishSchoolService.BANK_K));
        f.bank += (bankTarget - f.bank) * Math.min(1, dt * FishSchoolService.BANK_EASE);

        f.speed += (f.targetSpeed - f.speed) * Math.min(1, dt * 1.8);
        f.x += Math.cos(f.theta) * f.speed * dt;
        f.z += Math.sin(f.theta) * f.speed * dt;

        const sb = this.terrain.getElevation(f.x, f.z);
        // F4 — boiling: the ball rises to just under the surface and churns harder (a feeding frenzy / hunted boil).
        const depthBase = boil ? Math.max(f.baseY, FishSchoolService.BOIL_DEPTH) : f.baseY;
        let yTarget = depthBase + Math.sin(t * f.depthRate + f.depthPhase) * f.depthAmp * (boil ? 1.5 : 1);
        const lo = sb + FishSchoolService.SEABED_CLEAR;
        const hi = -FishSchoolService.SURFACE_CLEAR;
        yTarget = hi < lo ? (lo + hi) * 0.5 : Math.max(lo, Math.min(hi, yTarget));
        f.y += (yTarget - f.y) * Math.min(1, dt * 1.8);

        // Swim effort → instance-colour alpha (read by FishSwimPlugin): a flicking/fleeing fish beats harder.
        const effortTarget = Math.max(0.2, Math.min(1, (f.speed - 1.0) / 3.5));
        f.effort += (effortTarget - f.effort) * Math.min(1, dt * 5);
        sc.colBuf[i * 4 + 3] = f.effort;

        // Orientation: yaw to travel + banking. (Slot/sign may need a live tweak — see FACE_OFFSET note.)
        const yaw = -f.theta + FishSchoolService.FACE_OFFSET;
        this._scl.set(sc.scl, sc.scl, sc.scl);
        this._pos.set(f.x, f.y, f.z);
        Quaternion.RotationYawPitchRollToRef(yaw, 0, f.bank, this._quat);
        Matrix.ComposeToRef(this._scl, this._quat, this._pos, this._mat);
        this._mat.copyToArray(sc.matBuf, i * 16);
      }
      sc.mesh.thinInstanceBufferUpdated('matrix');
      sc.mesh.thinInstanceBufferUpdated('color');
    }
  }

  /** Cannon-fire spook: bait-balls bolt away from the shot for a few seconds, then settle. */
  scatterFrom(x: number, z: number): void {
    if (!this.active) { return; }
    this._panic = FishSchoolService.PANIC_TIME;
    this._panicX = x; this._panicZ = z;
  }

  private angDiff(b: number, a: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) { d -= Math.PI * 2; } else if (d < -Math.PI) { d += Math.PI * 2; }
    return d;
  }

  /** Build a UV-baked species clone of a body template: offsets the unit-cell UV.v into the species atlas row. */
  private speciesMesh(species: number): Mesh | null {
    const def = FishSchoolService.SPECIES[species];
    const base = def.body === 'a' ? this.baseA : this.baseB;
    if (!base) { return null; }
    const m = base.clone('fishSchool_' + species + '_' + this.schools.length)!;
    m.makeGeometryUnique();
    const uvs = m.getVerticesData(VertexBuffer.UVKind);
    if (uvs) {
      const rowH = 1 / FishSchoolService.NSPECIES;
      let row = def.row;
      if (FishSchoolService.ROW_FLIP) { row = FishSchoolService.NSPECIES - 1 - row; }
      for (let k = 1; k < uvs.length; k += 2) { uvs[k] = uvs[k] * rowH + row * rowH; }
      m.updateVerticesData(VertexBuffer.UVKind, uvs);
    }
    m.isVisible = true;
    m.alwaysSelectAsActiveMesh = true;
    this.sceneService.excludeFromGlow(m);
    return m;
  }

  /** Spawn one tight bait-ball per species, each clustered around its own home offset from the boat. */
  private spawn(bx: number, bz: number): void {
    this.schools = [];
    const baseAng = Math.random() * Math.PI * 2;
    for (let s = 0; s < FishSchoolService.NSPECIES; s++) {
      const mesh = this.speciesMesh(s);
      if (!mesh) { continue; }
      const gAng = baseAng + (s * Math.PI * 2) / FishSchoolService.NSPECIES + (Math.random() - 0.5) * 0.7;
      const gDist = 14 + Math.random() * 20;
      const homeX = Math.cos(gAng) * gDist, homeZ = Math.sin(gAng) * gDist;
      const members = 14 + Math.floor(Math.random() * 12);          // 14–25 (a dense ball)
      const scl = 0.32 + Math.random() * 0.22;                      // small fish
      const fish: Fish[] = [];
      for (let i = 0; i < members; i++) {
        const ang = Math.random() * Math.PI * 2, r = 1 + Math.random() * 4;
        fish.push({
          x: bx + homeX + Math.cos(ang) * r, z: bz + homeZ + Math.sin(ang) * r, y: -(2 + Math.random() * 3),
          theta: Math.random() * Math.PI * 2, targetTheta: Math.random() * Math.PI * 2,
          speed: 1.2 + Math.random() * 1.2, targetSpeed: 1.2 + Math.random() * 1.2,
          baseY: -(1.2 + Math.random() * 4),
          depthPhase: Math.random() * Math.PI * 2, depthRate: 0.15 + Math.random() * 0.3, depthAmp: 0.5 + Math.random() * 1.4,
          retarget: Math.random() * 2, effort: 0.4, bank: 0,
        });
      }
      const matBuf = new Float32Array(members * 16);
      const colBuf = new Float32Array(members * 4);
      for (let i = 0; i < members; i++) { colBuf[i * 4] = 1; colBuf[i * 4 + 1] = 1; colBuf[i * 4 + 2] = 1; colBuf[i * 4 + 3] = 0.4; }
      mesh.thinInstanceSetBuffer('matrix', matBuf, 16, false);
      mesh.thinInstanceSetBuffer('color', colBuf, 4, false);
      mesh.thinInstanceCount = members;
      this.schools.push({ mesh, species: s, homeX, homeZ, fish, matBuf, colBuf, scl, boiling: false, boilT: 3 + Math.random() * 5 });
    }
    this.active = this.schools.length > 0;
  }

  private despawn(): void {
    for (const sc of this.schools) { sc.mesh.dispose(); }
    this.schools = [];
    this.active = false;
  }

  dispose(): void {
    const scene = this.sceneService.scene;
    if (this.observer && scene) { scene.onBeforeRenderObservable.remove(this.observer); }
    this.observer = null;
    this.despawn();
    this.baseA?.dispose(); this.baseB?.dispose();
    this.material?.dispose();
    this.baseA = this.baseB = null; this.material = null;
  }
}
