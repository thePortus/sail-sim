import {
  Scene, TransformNode, AnimationGroup, MorphTargetManager, Quaternion, Vector3,
  InstantiatedEntries, Skeleton, PBRMaterial, AbstractMesh,
} from '@babylonjs/core';
import { RiggedManifest, SailState } from '../models';
import type { VesselController, GunSide } from './vessel-controller';
import { SailBillowPlugin } from './sail-billow.plugin';
import { BakedAOPlugin } from './baked-ao.plugin';
import { MAST_DAMAGE_ONSET } from './combat.constants';

/** One sail's furl morph + the rope morphs that follow it (resolved by NAME). */
interface SailMorphPair {
  sail: string;
  sailMorph: { node: string; target: string };
  rigging: { node: string; target: string }[];
}

interface MastZone {
  fallClip: string;
  breakNode: string | null;
  breakTarget: string | null;
  fallFrom: number;
  fallTo: number;
  downCur: number;
  breakCur: number;
}

/**
 * Animation driver for the heavy 44-gun frigate (frigate.glb, manifest schema_version 2).
 * Implements the VesselController contract against the Constitution-type rig. It mirrors the
 * MerchantmanController (three masts, all square-rigged, mizzen spanker + gaff, jibs/staysails, symmetric
 * Trim, per-side gunnery, twin bower anchors + gradient-skin cables, three-zone dismasting, code-driven wheel
 * + flags) with TWO rig-specific differences:
 *   • The gun-port LIDS are MORPHS (Frigate_Ports.Lid_S / Lid_P), NOT bone clips — morph-weight channels are
 *     pruned from the baked clips, so lids are driven DIRECTLY via setMorphByName (one Lid morph per broadside
 *     opens both the gun-deck long-gun ports AND the spar-deck carronade ports of that side).
 *   • The masts topple about local Z (baked into the MastDown clips — the controller just scrubs them).
 * All 3 variants ship in ONE GLB. Lids are NESTED per-variant morph groups (Lid_{S|P} = light set,
 * +LidM_{S|P} = medium's extra ports, +LidH_{S|P} = heavy's); the active variant opens up to its tier and
 * leaves the rest bolted shut (an un-opened lid hides its gun). Counts H/M/L: long guns 15/15/13, carronades 11/8/6.
 *
 * AnimationGroups may carry an 'NLA_' prefix + a loader .NNN suffix; strip() removes both.
 */
export class FrigateController implements VesselController {
  readonly root: TransformNode;
  private readonly scene: Scene;
  private readonly manifest: RiggedManifest;
  private readonly skeleton: Skeleton | null;

  private readonly clips  = new Map<string, AnimationGroup>();
  private readonly morphs = new Map<string, MorphTargetManager>();
  private readonly morphIndex = new Map<string, number>();
  private readonly sailMeshes = new Map<string, AbstractMesh>();
  /** Armament variant → its gun mesh (all 3 ship in the GLB; only the active one is shown). */
  private readonly gunVariantMeshes = new Map<string, AbstractMesh>();
  private armament = 'heavy';
  private prunedChannels = 0;
  private readonly nodes  = new Map<string, TransformNode>();
  private readonly restQ  = new Map<string, Quaternion>();
  private readonly parentRestQ = new Map<string, Quaternion>();
  private readonly frameEnd: number;
  private driveRopeFurl = true;

  private rudderCur = 0; private rudderTarget = 0;
  private trimCur   = 0.5; private trimTarget = 0.5;
  private readonly RUDDER_RATE = 4.0;
  private readonly TRIM_RATE   = 1.4;
  private readonly TRIM_TACK_SIGN = 1;
  private readonly WHEEL_MAX_RAD = Math.PI * 2;
  private WHEEL_AXIS = Vector3.Up();

  private readonly pairBySail = new Map<string, SailMorphPair>();
  private readonly furlCur    = new Map<string, number>();
  private readonly furlTarget = new Map<string, number>();
  private readonly FURL_RATE = 0.5;

  private readonly gunDeployCur:    Record<GunSide, number> = { S: 0, P: 0 };
  private readonly gunDeployTarget: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly gunRecoil:       Record<GunSide, number> = { S: 0, P: 0 };
  private readonly GUN_DEPLOY_RATE  = 1.4;
  private readonly GUN_RECOIL_DECAY = 5.0;
  /** The gun-port lids are a MORPH mesh (Frigate_Ports) with Lid_S / Lid_P targets — not a bone clip. */
  private readonly PORTS_MESH = 'Frigate_Ports';
  /** Safety valve for gunport side: if a build ever reads port/starboard reversed, flip with
   *  localStorage.ignis_fr_gunside='swap' (default: no flip — B_Gun_S = starboard, matches the fleet). */
  private readonly gunSideFlip = !(typeof localStorage !== 'undefined' && localStorage.getItem('ignis_fr_gunside') === 'noswap');
  private clipSide(side: GunSide): GunSide { return this.gunSideFlip ? (side === 'S' ? 'P' : 'S') : side; }

  private readonly anchorReq: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly anchorCur: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly ANCHOR_RATE = 0.7;

  private readonly mastZones: MastZone[] = [];
  private mastHealthTarget = 1;
  private readonly MAST_FALL_RATE = 0.4;

  private readonly FLAG_LOCAL_AXIS = Vector3.Up();
  private FLAG_YAW_OFFSET = 0;
  private readonly flagBones: string[] = [];

  // Sail-state → per-sail furl. full = all set; topsails = strike the light kites (royals + flying jib);
  // reefed = all furled.
  private static readonly KITES = ['Sail_Fore_Royal', 'Sail_Main_Royal', 'Sail_Mizzen_Royal', 'Sail_FlyingJib'];
  private static readonly ALL_SAILS = [
    'Sail_Fore_Course', 'Sail_Fore_Topsail', 'Sail_Fore_Topgallant', 'Sail_Fore_Royal',
    'Sail_Main_Course', 'Sail_Main_Topsail', 'Sail_Main_Topgallant', 'Sail_Main_Royal',
    'Sail_Mizzen_Topsail', 'Sail_Mizzen_Topgallant', 'Sail_Mizzen_Royal',
    'Sail_ForeTopmastStaysail', 'Sail_Jib', 'Sail_FlyingJib', 'Sail_MainTopmastStaysail',
    'Sail_MizzenTopmastStaysail', 'Sail_Spanker',
  ];

  constructor(entries: InstantiatedEntries, root: TransformNode, manifest: RiggedManifest, scene: Scene) {
    this.root = root;
    this.scene = scene;
    this.manifest = manifest;
    this.skeleton = entries.skeletons[0]
      ?? (root.getChildMeshes(false).find((m) => (m as { skeleton?: Skeleton }).skeleton) as
            { skeleton?: Skeleton } | undefined)?.skeleton
      ?? null;
    const mc = (manifest as unknown as { constants?: { clip_frame_end?: number }; frame_range?: number[] });
    this.frameEnd = mc.frame_range?.[1] ?? mc.constants?.clip_frame_end ?? 30;
    if (typeof localStorage !== 'undefined') {
      const fdeg = localStorage.getItem('ignis_fr_flag_deg');
      if (fdeg !== null && !isNaN(parseFloat(fdeg))) this.FLAG_YAW_OFFSET = parseFloat(fdeg) * Math.PI / 180;
      if (localStorage.getItem('ignis_fr_ropefurl') === 'off') this.driveRopeFurl = false;
      const wa = localStorage.getItem('ignis_fr_wheelaxis');
      if (wa === 'x') this.WHEEL_AXIS = Vector3.Right();
      else if (wa === 'y') this.WHEEL_AXIS = Vector3.Up();
      else if (wa === 'z') this.WHEEL_AXIS = Vector3.Forward();
    }

    let pruned = 0;
    for (const g of entries.animationGroups) {
      g.stop();
      pruned += FrigateController.pruneConstantChannels(g);
      this.clips.set(FrigateController.strip(g.name), g);
    }
    this.prunedChannels = pruned;

    for (const mesh of root.getChildMeshes(false)) {
      const name = FrigateController.strip(mesh.name);
      const mgr = (mesh as { morphTargetManager?: MorphTargetManager }).morphTargetManager;
      if (mgr) {
        this.morphs.set(name, mgr);
        for (let i = 0; i < mgr.numTargets; i++) {
          const t = mgr.getTarget(i);
          if (t) this.morphIndex.set(name + '|' + t.name, i);
        }
      }
      if (!name.startsWith('Flag_') && name !== 'Frigate_Flags') mesh.useVertexColors = false;
      if (name.startsWith('Frigate_Guns_')) this.gunVariantMeshes.set(name.replace('Frigate_Guns_', '').toLowerCase(), mesh);
      if (name.startsWith('Sail_')) this.sailMeshes.set(name, mesh);
      if (name.startsWith('Sail_') && mesh.material instanceof PBRMaterial) {
        const mat = mesh.material;
        let plugin = mat.pluginManager?.getPlugin<SailBillowPlugin>('SailBillow') ?? null;
        if (!plugin) plugin = new SailBillowPlugin(mat);
        const bb = mesh.getBoundingInfo().boundingBox;
        plugin.configure(bb.minimum, bb.maximum);
      }
      if (mesh.material instanceof PBRMaterial) {
        const mat = mesh.material;
        if (mat.ambientTexture && !mat.pluginManager?.getPlugin('BakedAO')) { new BakedAOPlugin(mat); }
        mat.maxSimultaneousLights = 6;
      }
    }

    this.nodes.set(FrigateController.strip(root.name), root);
    for (const n of root.getChildTransformNodes(false)) this.nodes.set(FrigateController.strip(n.name), n);

    const pairs = (manifest as unknown as { sail_sheet_pairs?: Record<string, { object: string; shape_key: string }[]> }).sail_sheet_pairs ?? {};
    const sailNodes = (manifest as unknown as { meshes?: { sails?: string[] } }).meshes?.sails ?? FrigateController.ALL_SAILS;
    for (const sail of sailNodes) {
      const furlTarget = this.resolveFurlTarget(sail);
      if (!furlTarget) continue;
      const rigging = (pairs[sail] ?? []).map((r) => ({ node: r.object, target: r.shape_key }));
      this.pairBySail.set(sail, { sail, sailMorph: { node: sail, target: furlTarget }, rigging });
    }

    // Three mast zones off ONE collective health. Foremast first, mizzen next, mainmast (largest) only at 0 HP.
    const zones = (manifest as unknown as { mast_damage?: { zones?: { id?: string; fall_clip: string; break_morph?: { node: string; target: string } | null }[] } }).mast_damage?.zones ?? [];
    const windows: Record<string, [number, number]> = {
      MastDown_Fore:   [1 - MAST_DAMAGE_ONSET, 0.60],
      MastDown_Mizzen: [0.60, 0.80],
      MastDown_Main:   [0.80, 1.00],
    };
    for (const z of zones) {
      if (!this.clips.has(z.fall_clip)) continue;
      const [from, to] = windows[z.fall_clip] ?? [1 - MAST_DAMAGE_ONSET, 1];
      this.mastZones.push({
        fallClip: z.fall_clip,
        breakNode: z.break_morph?.node ?? null, breakTarget: z.break_morph?.target ?? null,
        fallFrom: from, fallTo: to, downCur: 0, breakCur: 0,
      });
    }

    const freeBones = (manifest as unknown as { free_rotation?: { bones?: string[] } }).free_rotation?.bones
      ?? ['B_Wheel', 'B_Flag_Ensign', 'B_Flag_Jack', 'B_Flag_Pennant', 'B_Flag_ForeSignal', 'B_Flag_MizzenSignal'];
    for (const b of freeBones) if (b.startsWith('B_Flag_')) this.flagBones.push(b);

    for (const name of ['B_Wheel', ...this.flagBones]) {
      const n = this.nodes.get(name);
      if (n) {
        const q = n.rotationQuaternion ?? Quaternion.FromEulerAngles(n.rotation.x, n.rotation.y, n.rotation.z);
        n.rotationQuaternion = q.clone();
        this.restQ.set(name, q.clone());
        const parent = n.parent as TransformNode | null;
        if (parent) {
          const pq = parent.rotationQuaternion ?? Quaternion.FromEulerAngles(parent.rotation.x, parent.rotation.y, parent.rotation.z);
          this.parentRestQ.set(name, pq.clone());
        }
      }
    }

    // Armament variant: show the active gun set, hide the other two. Default from the manifest (heavy), with a
    // live test override; the server-authoritative `armament` field is applied later via setArmament().
    const vdefault = (manifest as unknown as { variants?: { default?: string } }).variants?.default ?? 'heavy';
    const vOverride = typeof localStorage !== 'undefined' ? localStorage.getItem('ignis_fr_armament') : null;
    this.setArmament(vOverride || vdefault);

    // Default pose: centre helm + square trim, all sail set, guns run in + ports CLOSED, anchors stowed.
    this.applyRudder();
    this.applyTrim();
    this.applySailState('full', true);
    this.applyGunPose('S');
    this.applyGunPose('P');

    if (!FrigateController._loggedMorphs) {
      FrigateController._loggedMorphs = true;
      const missing: string[] = [];
      for (const p of this.pairBySail.values()) {
        if (!this.hasMorph(p.sailMorph.node, p.sailMorph.target)) missing.push(p.sailMorph.node + '|' + p.sailMorph.target);
        for (const r of p.rigging) if (!this.hasMorph(r.node, r.target)) missing.push(r.node + '|' + r.target);
      }
      for (const side of ['S', 'P'] as const) for (const grp of ['Lid', 'LidM', 'LidH']) if (!this.hasMorph(this.PORTS_MESH, `${grp}_${side}`)) missing.push(`${this.PORTS_MESH}|${grp}_${side}`);
      console.log(`[Frigate] clips (${this.clips.size}), pruned ${this.prunedChannels} constant channels:`, [...this.clips.keys()].join(', '));
      if (missing.length) console.warn('[Frigate] UNRESOLVED morphs →', missing.join(', '));
      else console.log('[Frigate] all sail/rope/lid morphs resolved by name ✓');
      const flagState = ['B_Wheel', ...this.flagBones]
        .map((n) => `${n}=${this.restQ.has(n) ? 'ok' : 'MISSING'}`).join(', ');
      console.log('[Frigate] free-rotation bones:', flagState);
    }
  }

  private static _loggedMorphs = false;
  private static strip(name: string): string { return name.replace(/^NLA_/, '').replace(/\.\d{3,}$/, ''); }

  private resolveFurlTarget(sailNode: string): string | null {
    if (this.morphIndex.has(sailNode + '|Furl')) return 'Furl';
    const mgr = this.morphs.get(sailNode);
    if (!mgr) return null;
    for (let i = 0; i < mgr.numTargets; i++) {
      const t = mgr.getTarget(i);
      if (t && /furl/i.test(t.name)) return t.name;
    }
    return null;
  }

  private static isConstantAnim(anim: { getKeys(): { value: unknown }[] }): boolean {
    const keys = anim.getKeys();
    if (keys.length <= 1) return true;
    const v0 = keys[0].value as number | { equalsWithEpsilon?: (o: unknown, e: number) => boolean };
    for (let i = 1; i < keys.length; i++) {
      const v = keys[i].value;
      if (typeof v0 === 'number') { if (Math.abs((v as number) - v0) > 1e-5) return false; }
      else if (v0.equalsWithEpsilon) { if (!v0.equalsWithEpsilon(v, 1e-5)) return false; }
      else if (v !== v0) return false;
    }
    return true;
  }

  private static pruneConstantChannels(g: AnimationGroup): number {
    const arr = g.targetedAnimations;
    const keep = arr.filter((ta) => {
      const anim = ta.animation as unknown as { getKeys(): { value: unknown }[]; targetProperty?: string };
      if (anim.targetProperty === 'influence') return false;   // morphs are driven directly via setMorphByName
      return !FrigateController.isConstantAnim(anim);
    });
    const removed = arr.length - keep.length;
    if (removed > 0) { arr.length = 0; for (const ta of keep) arr.push(ta); }
    return removed;
  }

  private poseNorm(clipName: string, t01: number): void {
    const g = this.clips.get(clipName);
    if (!g) return;
    if (!g.animatables.length) { g.start(false, 1.0, g.from, g.to); g.pause(); }
    g.goToFrame(g.from + Math.max(0, Math.min(1, t01)) * (g.to - g.from));
  }

  // ── control surface ─────────────────────────────────────────────────────────
  setRudder(t: number): void { this.rudderTarget = Math.max(-1, Math.min(1, t)); }

  setSailTrim(sheetAngleDeg: number, isPortTack: boolean): void {
    const eased = Math.max(0, Math.min(1, (sheetAngleDeg - 5) / 83));
    const brace = 1 - eased;
    const tackDir = (isPortTack ? -1 : 1) * this.TRIM_TACK_SIGN;
    this.trimTarget = Math.max(0, Math.min(1, 0.5 + tackDir * brace * 0.5));
  }

  applySailState(state: SailState, immediate = false): void {
    const table = FrigateController.sailFurlTable(state);
    for (const sail in table) {
      this.furlTarget.set(sail, table[sail]);
      if (immediate || !this.furlCur.has(sail)) { this.furlCur.set(sail, table[sail]); this.applyFurl(sail, table[sail]); }
    }
  }

  setGunDeployTarget(side: GunSide, t: number): void { this.gunDeployTarget[side] = Math.max(0, Math.min(1, t)); }
  addGunRecoil(side: GunSide, kick = 0.7): void { this.gunRecoil[side] = Math.min(1, this.gunRecoil[side] + kick); }
  isGunReady(side: GunSide): boolean { return this.gunDeployCur[side] >= 0.99; }
  gunSettled(side: GunSide): boolean {
    return Math.abs(this.gunDeployCur[side] - this.gunDeployTarget[side]) < 0.01 && this.gunRecoil[side] < 0.02;
  }
  /** Lids are a MORPH (Frigate_Ports.Lid_{S|P}), driven directly — NOT a clip. */
  setGunports(side: GunSide, open: number): void {
    this.setLidsOpen(this.clipSide(side), open);
  }

  /** Open the nested per-variant lid groups. One GLB carries all ports; the variant tier decides how many
   *  open (light = Lid_* only, medium adds LidM_*, heavy adds LidH_*). Groups above the tier are forced shut
   *  (bolted) — self-correcting so a variant downgrade after deploy can't leave a group stuck open. */
  private setLidsOpen(cs: string, open: number): void {
    const v = Math.max(0, Math.min(1, open));
    const tier = this.armament === 'heavy' ? 2 : this.armament === 'medium' ? 1 : 0;
    this.setMorphByName(this.PORTS_MESH, `Lid_${cs}`, v);
    this.setMorphByName(this.PORTS_MESH, `LidM_${cs}`, tier >= 1 ? v : 0);
    this.setMorphByName(this.PORTS_MESH, `LidH_${cs}`, tier >= 2 ? v : 0);
  }

  /** Choose the visible armament variant ('heavy' | 'medium' | 'light'). All three are rigged, so the shown
   *  one animates; the others are hidden. Server-driven via the vessel's `armament` field. */
  setArmament(variant: string): void {
    const want = (variant || 'heavy').toLowerCase();
    if (!this.gunVariantMeshes.size) return;
    const active = this.gunVariantMeshes.has(want) ? want : 'heavy';
    this.armament = active;
    for (const [name, mesh] of this.gunVariantMeshes) mesh.setEnabled(name === active);
  }

  setMastDamage(health: number): void { this.mastHealthTarget = Math.max(0, Math.min(1, health)); }

  dropAnchor(side: GunSide, t: number): void { this.anchorReq[side] = Math.max(0, Math.min(1, t)); }

  idleWind(windDirLocalRad: number, strength: number, t: number): void {
    const s = Math.max(0, Math.min(1.5, strength));
    const w = Math.max(0, Math.min(1, (s - 0.02) / 0.10));
    const base = windDirLocalRad + this.FLAG_YAW_OFFSET;
    const flutter: Record<string, [number, number, number]> = {
      B_Flag_Ensign:       [2.0, 0.0, 0.18],
      B_Flag_Jack:         [2.4, 0.3, 0.22],
      B_Flag_Pennant:      [1.6, -0.4, 0.40],
      B_Flag_ForeSignal:   [2.3, 0.5, 0.24],
      B_Flag_MizzenSignal: [2.2, 0.6, 0.22],
    };
    for (const name of this.flagBones) {
      const [freq, phase, amp] = flutter[name] ?? [2.0, 0.0, 0.22];
      this.streamFlag(name, base + Math.sin(t * freq + phase) * amp * s, w);
    }
    SailBillowPlugin.wind.strength = s;
    SailBillowPlugin.wind.time = t;
  }

  tickRig(dt: number): void {
    this.rudderCur = approach(this.rudderCur, this.rudderTarget, this.RUDDER_RATE * dt);
    this.applyRudder();
    this.trimCur = approach(this.trimCur, this.trimTarget, this.TRIM_RATE * dt);
    this.applyTrim();

    const step = this.FURL_RATE * dt;
    for (const [sail, target] of this.furlTarget) {
      let cur = this.furlCur.get(sail); if (cur === undefined) cur = target;
      if (cur !== target) {
        cur = cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
        this.furlCur.set(sail, cur);
      }
      this.applyFurl(sail, cur);
    }

    for (const side of ['S', 'P'] as const) {
      this.gunDeployCur[side] = approach(this.gunDeployCur[side], this.gunDeployTarget[side], this.GUN_DEPLOY_RATE * dt);
      if (this.gunRecoil[side] > 0) this.gunRecoil[side] = Math.max(0, this.gunRecoil[side] - this.GUN_RECOIL_DECAY * dt);
      if (this.gunDeployCur[side] !== 0 || this.gunDeployTarget[side] !== 0 || this.gunRecoil[side] > 0) {
        this.applyGunPose(side);
      }
    }

    for (const side of ['S', 'P'] as const) {
      this.anchorCur[side] = approach(this.anchorCur[side], this.anchorReq[side], this.ANCHOR_RATE * dt);
      if (this.anchorCur[side] > 0.0001 || this.anchorReq[side] > 0) {
        this.poseNorm(`AnchorDrop_${side}`, this.anchorCur[side]);
      }
    }

    const frac = 1 - this.mastHealthTarget;
    for (const z of this.mastZones) {
      const span = Math.max(0.0001, z.fallTo - z.fallFrom);
      const downTgt = Math.max(0, Math.min(1, (frac - z.fallFrom) / span));
      const breakTgt = Math.max(0, Math.min(1, (downTgt - 0.6) / 0.4));
      z.downCur  = approach(z.downCur,  downTgt,  this.MAST_FALL_RATE * dt);
      z.breakCur = approach(z.breakCur, breakTgt, this.MAST_FALL_RATE * dt);
      if (z.downCur > 0.0001 || downTgt > 0) {
        this.poseNorm(z.fallClip, z.downCur);
        if (z.breakNode && z.breakTarget) this.setMorphByName(z.breakNode, z.breakTarget, z.breakCur);
      }
    }

    if (this.skeleton) {
      (this.skeleton as unknown as { _isDirty: boolean })._isDirty = true;
      this.skeleton.prepare(true);
    }
  }

  getMeshes() { return this.root.getChildMeshes(false); }

  dispose(): void {
    for (const g of this.clips.values()) { g.stop(); g.dispose(); }
    for (const m of this.morphs.values()) { m.dispose(); }
    this.skeleton?.dispose();
    this.clips.clear(); this.morphs.clear(); this.morphIndex.clear();
    this.nodes.clear(); this.restQ.clear();
    this.furlCur.clear(); this.furlTarget.clear(); this.pairBySail.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private applyRudder(): void {
    // Authored NATURALLY: 0 = hard port (-max), 0.5 = centre, 1 = hard stbd (+max). Map rudderCur
    // (-1 port .. +1 stbd) straight through. (Flip via ignis_fr_rudder if it reads reversed.)
    let n = 0.5 + this.rudderCur * 0.5;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('ignis_fr_rudder') === 'rev') n = 0.5 - this.rudderCur * 0.5;
    this.poseNorm('Rudder', n);
    const w = this.nodes.get('B_Wheel'); const wRest = this.restQ.get('B_Wheel');
    if (w && wRest) w.rotationQuaternion = wRest.multiply(Quaternion.RotationAxis(this.WHEEL_AXIS, this.rudderCur * this.WHEEL_MAX_RAD));
  }

  private applyTrim(): void { this.poseNorm('Trim', this.trimCur); }

  private applyGunPose(side: GunSide): void {
    const dep = this.gunDeployCur[side];
    const lid = Math.max(0, Math.min(1, dep * 2));                              // lid opens over the first half
    const gun = Math.max(0, Math.min(1, dep * 2 - 1) - this.gunRecoil[side]);   // gun runs out over the second half
    const cs = this.clipSide(side);
    this.setLidsOpen(cs, lid);                                                  // lids = nested per-variant morphs
    this.poseNorm(`Gun_${cs}`, gun);
  }

  private applyFurl(sail: string, v: number): void {
    const pair = this.pairBySail.get(sail);
    if (!pair) return;
    const mesh = this.sailMeshes.get(pair.sailMorph.node);
    if (mesh) { mesh.setEnabled(true); mesh.visibility = 1; }
    this.setMorphByName(pair.sailMorph.node, pair.sailMorph.target, v);
    if (this.driveRopeFurl) for (const r of pair.rigging) this.setMorphByName(r.node, r.target, v);
  }

  private hasMorph(meshNode: string, targetName: string): boolean {
    return this.morphIndex.has(meshNode + '|' + targetName);
  }

  private setMorphByName(meshNode: string, targetName: string, value: number): void {
    const idx = this.morphIndex.get(meshNode + '|' + targetName);
    if (idx === undefined) return;
    const target = this.morphs.get(meshNode)?.getTarget(idx);
    if (target) target.influence = value;
  }

  private streamFlag(name: string, phi: number, w: number): void {
    const n = this.nodes.get(name); const rest = this.restQ.get(name);
    if (!n || !rest) return;
    if (w <= 0.0001) { n.rotationQuaternion = rest.clone(); return; }
    const windSpin = Quaternion.RotationAxis(this.FLAG_LOCAL_AXIS, phi);
    let q = rest.multiply(windSpin);
    const parent = n.parent as TransformNode | null;
    const pRest = this.parentRestQ.get(name);
    if (parent && pRest) {
      const pCur = parent.rotationQuaternion ?? pRest;
      const cancel = Quaternion.Inverse(pCur).multiply(pRest);   // undo the parent's (gaff) trim deviation
      q = cancel.multiply(q);
    }
    n.rotationQuaternion = Quaternion.Slerp(rest, q, w);
  }

  private static sailFurlTable(state: SailState): Record<string, number> {
    const t: Record<string, number> = {};
    for (const s of FrigateController.ALL_SAILS) t[s] = state === 'reefed' ? 1 : 0;
    if (state === 'topsails') for (const k of FrigateController.KITES) t[k] = 1;   // strike the light kites
    return t;
  }
}

function approach(cur: number, target: number, maxStep: number): number {
  if (cur === target) return cur;
  const d = target - cur;
  return cur + Math.sign(d) * Math.min(Math.abs(d), maxStep);
}
