import {
  Scene, TransformNode, AnimationGroup, MorphTargetManager, Quaternion, Vector3,
  InstantiatedEntries, Skeleton, PBRMaterial, AbstractMesh,
} from '@babylonjs/core';
import { RiggedManifest, SailState } from '../models';
import type { VesselController, GunSide } from './vessel-controller';
import { SailBillowPlugin } from './sail-billow.plugin';
import { BakedAOPlugin } from './baked-ao.plugin';
import { MAST_DAMAGE_ONSET } from './combat.constants';

/** One sail's furl morph + the rope morphs that follow it (resolved by NAME — the rope meshes carry
 *  several Furl_<sail> targets each, so a positional index is unsafe). */
interface SailMorphPair {
  sail: string;
  sailMorph: { node: string; target: string };
  rigging: { node: string; target: string }[];
}

/** A dismasting zone: its own fall clip (+ optional splinter morph, which the merchantman doesn't yet have),
 *  plus the masts-zone-fraction window over which it topples — so the THREE masts come down at different
 *  damage levels off ONE collective HP. */
interface MastZone {
  fallClip: string;
  breakNode: string | null;
  breakTarget: string | null;
  /** mast-damage fraction (= 1 − health) at which this mast STARTS leaning. */
  fallFrom: number;
  /** mast-damage fraction at which this mast is FULLY collapsed. */
  fallTo: number;
  // live eased state
  downCur: number;
  breakCur: number;
}

/**
 * Animation driver for the three-masted merchantman / hagboat (merchantman.glb, manifest schema_version 2).
 * Implements the same VesselController contract as the sloop / pinnace / brig against a bespoke rig:
 *  • Fore + main SQUARE-rigged, mizzen with a gaff SPANKER + topsails, three jibs. All yards + the gaff
 *    share ONE symmetric Trim scrub clip (0 = braced to one tack, 0.5 = square / running, 1 = the other tack).
 *  • Per-side gunnery WITH gunport lids (3 ports/side): open the lid then run the gun out; recoil kicks the
 *    gun term toward stowed (Lid_{S|P} + Gun_{S|P}).
 *  • 13 sails furled by DIRECT morph drive ('Furl' shape key per sail); the modelled running rigging follows
 *    via Furl_Sail_<name> morphs on rig_running / rig_sailgear / rig_headsheets (manifest.sail_sheet_pairs) —
 *    so sheets & clews gather with the furled sail. Opt out of the rope follow with ignis_mm_ropefurl='off'.
 *  • TWO anchors (AnchorDrop_S / AnchorDrop_P); the cable pays out via a GRADIENT SKIN on the bone (no morph),
 *    so the anchor drive just scrubs the clip — no separate cable morph like the brig.
 *  • SINGLE collective masts-zone HP drives ALL THREE masts: the foremast comes down first, the mizzen next,
 *    the big mainmast only at 0 HP. Each topples about its own hinge carrying its yards/sails/rigging.
 *  • Four flags (B_Flag_Ensign on the gaff, B_Flag_Fore / _Pennant / _Mizzen at the trucks) stream downwind
 *    and flutter, going limp in dead air; B_Wheel spins with the helm about its LOCAL Y (the bone points
 *    along the fore-aft axle — NOT local X like the brig, whose bone points up).
 *
 * AnimationGroups may carry an 'NLA_' prefix in this GLB; strip() removes both that and the loader's .NNN
 * datablock suffix, so clips are referenced by clean names (Rudder, Trim, MastDown_Fore, …).
 */
export class MerchantmanController implements VesselController {
  readonly root: TransformNode;
  private readonly scene: Scene;
  private readonly manifest: RiggedManifest;
  private readonly skeleton: Skeleton | null;

  private readonly clips  = new Map<string, AnimationGroup>();
  private readonly morphs = new Map<string, MorphTargetManager>();
  /** (meshName + '|' + targetName) → morph-target INDEX, resolved by name at construction. */
  private readonly morphIndex = new Map<string, number>();
  /** Sail node name → its mesh, so a furled sail can be re-enabled if the asset ever disables it. */
  private readonly sailMeshes = new Map<string, AbstractMesh>();
  private prunedChannels = 0;
  private readonly nodes  = new Map<string, TransformNode>();
  private readonly restQ  = new Map<string, Quaternion>();
  /** A flag bone's PARENT's rest rotation — used to cancel the parent's trim so the flag is wind-only. */
  private readonly parentRestQ = new Map<string, Quaternion>();
  private readonly frameEnd: number;
  /** Drive the running-rigging Furl morphs WITH each sail (the merchantman's rope morphs were authored to
   *  gather correctly). Opt out → ignis_mm_ropefurl='off' (leaves the sheets at their set position). */
  private driveRopeFurl = true;

  // Rudder + symmetric trim (scrub the clip's FULL range so 0.5 lands on true centre).
  private rudderCur = 0; private rudderTarget = 0;        // −1 hard port .. 0 centre .. +1 hard stbd
  private trimCur   = 0.5; private trimTarget = 0.5;       // 0 tack .. 0.5 square .. 1 other tack
  private readonly RUDDER_RATE = 4.0;
  private readonly TRIM_RATE   = 1.4;
  /** Tack-swing sign for the square-rig trim mapping (flip if the rig braces to the wrong side). */
  private readonly TRIM_TACK_SIGN = 1;
  private readonly WHEEL_MAX_RAD = Math.PI * 2;            // ~one turn lock-to-lock
  // The wheel rolls about its bone's LOCAL Y (live-confirmed). Still tunable: localStorage.ignis_mm_wheelaxis = 'x'|'y'|'z'.
  private WHEEL_AXIS = Vector3.Up();

  // Per-sail furl (keys = SailMorphPair.sail).
  private readonly pairBySail = new Map<string, SailMorphPair>();
  private readonly furlCur    = new Map<string, number>();
  private readonly furlTarget = new Map<string, number>();
  private readonly FURL_RATE = 0.5;

  // Gunnery with lids: deploy 0 = stowed, 1 = ready (lid open + gun run out).
  private readonly gunDeployCur:    Record<GunSide, number> = { S: 0, P: 0 };
  private readonly gunDeployTarget: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly gunRecoil:       Record<GunSide, number> = { S: 0, P: 0 };
  private readonly GUN_DEPLOY_RATE  = 1.4;
  private readonly GUN_RECOIL_DECAY = 5.0;

  // Two anchors, one per side (cable follows via gradient skin — no morph).
  private readonly anchorReq: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly anchorCur: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly ANCHOR_RATE = 0.7;

  // Three mast-damage zones driven off ONE collective health. Onset matches the HUD green→yellow boundary.
  private readonly mastZones: MastZone[] = [];
  private mastHealthTarget = 1;
  private readonly MAST_FALL_RATE = 0.4;

  /** Local staff axis each flag bone spins about (bones point head→tail along local Y). */
  private readonly FLAG_LOCAL_AXIS = Vector3.Up();
  /** Rest-bearing offset so a flag streams DOWNWIND from its staff. Live-tunable via
   *  localStorage.ignis_mm_flag_deg (degrees). */
  private FLAG_YAW_OFFSET = 0;
  private readonly flagBones: string[] = [];

  // Sail-state → per-sail furl. full = all set; topsails = strike the light kites; reefed = all furled.
  private static readonly KITES = ['Sail_Fore_TGallant', 'Sail_Main_TGallant', 'Sail_Mizzen_TGallant', 'Sail_OuterJib'];
  private static readonly ALL_SAILS = [
    'Sail_Fore_Course', 'Sail_Fore_Tops', 'Sail_Fore_TGallant',
    'Sail_Main_Course', 'Sail_Main_Tops', 'Sail_Main_TGallant',
    'Sail_Mizzen_Course', 'Sail_Mizzen_Tops', 'Sail_Mizzen_TGallant',
    'Sail_InnerJib', 'Sail_MiddleJib', 'Sail_OuterJib', 'Sail_Spanker',
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
      const fdeg = localStorage.getItem('ignis_mm_flag_deg');
      if (fdeg !== null && !isNaN(parseFloat(fdeg))) this.FLAG_YAW_OFFSET = parseFloat(fdeg) * Math.PI / 180;
      if (localStorage.getItem('ignis_mm_ropefurl') === 'off') this.driveRopeFurl = false;
      const wa = localStorage.getItem('ignis_mm_wheelaxis');
      if (wa === 'x') this.WHEEL_AXIS = Vector3.Right();
      else if (wa === 'y') this.WHEEL_AXIS = Vector3.Up();
      else if (wa === 'z') this.WHEEL_AXIS = Vector3.Forward();
    }

    // Like the brig, the clips may be full-skeleton bakes — prune CONSTANT channels so each clip only drives
    // the bones it actually moves and they compose instead of clobbering each other; also drop morph-weight
    // channels (every morph is driven directly via setMorphByName).
    let pruned = 0;
    for (const g of entries.animationGroups) {
      g.stop();
      pruned += MerchantmanController.pruneConstantChannels(g);
      this.clips.set(MerchantmanController.strip(g.name), g);
    }
    this.prunedChannels = pruned;

    for (const mesh of root.getChildMeshes(false)) {
      const name = MerchantmanController.strip(mesh.name);
      const mgr = (mesh as { morphTargetManager?: MorphTargetManager }).morphTargetManager;
      if (mgr) {
        this.morphs.set(name, mgr);
        for (let i = 0; i < mgr.numTargets; i++) {
          const t = mgr.getTarget(i);
          if (t) this.morphIndex.set(name + '|' + t.name, i);
        }
      }

      // The flags carry the legit COLOR_0 (flag-colour picker tints them); turn vertex colours OFF everywhere
      // else so any stray/garbage COLOR_0 layer can't tint the hull/deck.
      if (!name.startsWith('Flag_')) mesh.useVertexColors = false;
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

    this.nodes.set(MerchantmanController.strip(root.name), root);
    for (const n of root.getChildTransformNodes(false)) this.nodes.set(MerchantmanController.strip(n.name), n);

    // Sail → furl-morph pairing. The merchantman manifest's sail_sheet_pairs is an OBJECT keyed by sail node,
    // each value a list of {object, shape_key} rope morphs. The sail's OWN furl morph is the 'Furl' shape key
    // on the sail mesh (resolved robustly in case the authored name differs).
    const pairs = (manifest as unknown as { sail_sheet_pairs?: Record<string, { object: string; shape_key: string }[]> }).sail_sheet_pairs ?? {};
    const sailNodes = (manifest as unknown as { meshes?: { sails?: string[] } }).meshes?.sails ?? MerchantmanController.ALL_SAILS;
    for (const sail of sailNodes) {
      const furlTarget = this.resolveFurlTarget(sail);
      if (!furlTarget) continue;
      const rigging = (pairs[sail] ?? []).map((r) => ({ node: r.object, target: r.shape_key }));
      this.pairBySail.set(sail, { sail, sailMorph: { node: sail, target: furlTarget }, rigging });
    }

    // Three mast zones off ONE collective health. Foremast first, mizzen next, mainmast (largest) only at 0 HP.
    // All windows live BELOW the damage onset (health < onset → fraction > 1 − onset).
    const zones = (manifest as unknown as { mast_damage?: { zones?: { id?: string; fall_clip: string; break_morph?: { node: string; target: string } | null }[] } }).mast_damage?.zones ?? [];
    const windows: Record<string, [number, number]> = { /* fraction = 1 − health */
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

    // Free-rotation bones: the wheel + every flag (from the manifest, falling back to the known names).
    const freeBones = (manifest as unknown as { free_rotation?: { bones?: string[] } }).free_rotation?.bones
      ?? ['B_Wheel', 'B_Flag_Ensign', 'B_Flag_Fore', 'B_Flag_Pennant', 'B_Flag_Mizzen'];
    for (const b of freeBones) if (b.startsWith('B_Flag_')) this.flagBones.push(b);

    // Capture rest rotation for the code-driven bones (flags + wheel).
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

    // Default pose: centre helm + square trim, all sail set, guns run in + ports CLOSED, anchors stowed.
    this.applyRudder();
    this.applyTrim();
    this.applySailState('full', true);
    this.applyGunPose('S');
    this.applyGunPose('P');

    if (!MerchantmanController._loggedMorphs) {
      MerchantmanController._loggedMorphs = true;
      const missing: string[] = [];
      for (const p of this.pairBySail.values()) {
        if (!this.hasMorph(p.sailMorph.node, p.sailMorph.target)) missing.push(p.sailMorph.node + '|' + p.sailMorph.target);
        for (const r of p.rigging) if (!this.hasMorph(r.node, r.target)) missing.push(r.node + '|' + r.target);
      }
      console.log(`[Merchantman] clips (${this.clips.size}), pruned ${this.prunedChannels} constant channels:`, [...this.clips.keys()].join(', '));
      if (missing.length) console.warn('[Merchantman] UNRESOLVED morphs →', missing.join(', '));
      else console.log('[Merchantman] all sail/rope morphs resolved by name ✓');
      const flagState = ['B_Wheel', ...this.flagBones]
        .map((n) => `${n}=${this.restQ.has(n) ? 'ok' : 'MISSING'}`).join(', ');
      console.log('[Merchantman] free-rotation bones:', flagState);
    }
  }

  private static _loggedMorphs = false;
  private static strip(name: string): string { return name.replace(/^NLA_/, '').replace(/\.\d{3,}$/, ''); }

  /** Find the furl morph target on a sail mesh — 'Furl' if present, else the first target matching /furl/i. */
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

  /** True if every keyframe of an animation holds the same value (a baked-in rest channel). */
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

  /** Drop constant + morph-weight channels from a clip so it only drives the bones it animates (lets dense
   *  full-skeleton bakes compose instead of clobbering each other). Returns #channels removed. */
  private static pruneConstantChannels(g: AnimationGroup): number {
    const arr = g.targetedAnimations;
    const keep = arr.filter((ta) => {
      const anim = ta.animation as unknown as { getKeys(): { value: unknown }[]; targetProperty?: string };
      // Drop MORPH-WEIGHT channels: every morph (sail furl, mast break) is driven DIRECTLY via setMorphByName.
      if (anim.targetProperty === 'influence') return false;
      return !MerchantmanController.isConstantAnim(anim);
    });
    const removed = arr.length - keep.length;
    if (removed > 0) { arr.length = 0; for (const ta of keep) arr.push(ta); }
    return removed;
  }

  /** Scrub a clip to a NORMALIZED 0..1 over its ACTUAL [from, to] (the glTF loader resamples frames, so
   *  g.to is generally not frameEnd — symmetric clips must hit their true centre). */
  private poseNorm(clipName: string, t01: number): void {
    const g = this.clips.get(clipName);
    if (!g) return;
    if (!g.animatables.length) { g.start(false, 1.0, g.from, g.to); g.pause(); }
    g.goToFrame(g.from + Math.max(0, Math.min(1, t01)) * (g.to - g.from));
  }

  // ── control surface ─────────────────────────────────────────────────────────
  setRudder(t: number): void { this.rudderTarget = Math.max(-1, Math.min(1, t)); }

  setSailTrim(sheetAngleDeg: number, isPortTack: boolean): void {
    // Square-rig mapping: yards SQUARE (0.5) when running (eased), braced to the tack when close-hauled.
    const eased = Math.max(0, Math.min(1, (sheetAngleDeg - 5) / 83));   // 0 close-hauled .. 1 running
    const brace = 1 - eased;                                            // 1 braced (close-hauled) .. 0 square
    const tackDir = (isPortTack ? -1 : 1) * this.TRIM_TACK_SIGN;
    this.trimTarget = Math.max(0, Math.min(1, 0.5 + tackDir * brace * 0.5));
  }

  applySailState(state: SailState, immediate = false): void {
    const table = MerchantmanController.sailFurlTable(state);
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
  setGunports(side: GunSide, open: number): void { this.poseNorm(`Lid_${side}`, Math.max(0, Math.min(1, open))); }

  /** Single collective mast HP (1 intact .. 0 destroyed) → all three masts (tickRig eases the zones). */
  setMastDamage(health: number): void { this.mastHealthTarget = Math.max(0, Math.min(1, health)); }

  dropAnchor(side: GunSide, t: number): void { this.anchorReq[side] = Math.max(0, Math.min(1, t)); }

  idleWind(windDirLocalRad: number, strength: number, t: number): void {
    const s = Math.max(0, Math.min(1.5, strength));
    const w = Math.max(0, Math.min(1, (s - 0.02) / 0.10));   // 0 = limp (dead air) .. 1 = streaming
    const base = windDirLocalRad + this.FLAG_YAW_OFFSET;
    // Each flag streams downwind with a phase-lagged flutter; longer pennants lag more. Slerped from rest by w.
    const flutter: Record<string, [number, number, number]> = {
      B_Flag_Ensign:  [2.0, 0.0, 0.18],
      B_Flag_Fore:    [2.4, 0.3, 0.24],
      B_Flag_Pennant: [1.6, -0.4, 0.38],
      B_Flag_Mizzen:  [2.2, 0.6, 0.22],
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

    // Furl — ease per sail, re-applying the morph every frame so a sail can't get stuck at a stale influence.
    const step = this.FURL_RATE * dt;
    for (const [sail, target] of this.furlTarget) {
      let cur = this.furlCur.get(sail); if (cur === undefined) cur = target;
      if (cur !== target) {
        cur = cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
        this.furlCur.set(sail, cur);
      }
      this.applyFurl(sail, cur);
    }

    // Gunnery — ease run-out/stow + decay recoil, then pose lid+gun per side.
    for (const side of ['S', 'P'] as const) {
      this.gunDeployCur[side] = approach(this.gunDeployCur[side], this.gunDeployTarget[side], this.GUN_DEPLOY_RATE * dt);
      if (this.gunRecoil[side] > 0) this.gunRecoil[side] = Math.max(0, this.gunRecoil[side] - this.GUN_RECOIL_DECAY * dt);
      if (this.gunDeployCur[side] !== 0 || this.gunDeployTarget[side] !== 0 || this.gunRecoil[side] > 0) {
        this.applyGunPose(side);
      }
    }

    // Anchors — ease each side; pose only when not fully stowed. The cable follows via gradient skin (no morph).
    for (const side of ['S', 'P'] as const) {
      this.anchorCur[side] = approach(this.anchorCur[side], this.anchorReq[side], this.ANCHOR_RATE * dt);
      if (this.anchorCur[side] > 0.0001 || this.anchorReq[side] > 0) {
        this.poseNorm(`AnchorDrop_${side}`, this.anchorCur[side]);
      }
    }

    // Mast damage — map the single health onto each zone's own collapse window, ease, pose + (optional) break.
    const frac = 1 - this.mastHealthTarget;   // 0 intact .. 1 destroyed
    for (const z of this.mastZones) {
      const span = Math.max(0.0001, z.fallTo - z.fallFrom);
      const downTgt = Math.max(0, Math.min(1, (frac - z.fallFrom) / span));   // 0 upright .. 1 collapsed
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
    // Free the per-vessel cloned skeleton + morph managers (GPU-texture-backed on WebGPU) — disposing the
    // meshes alone leaks them as NPCs churn through interest range.
    for (const m of this.morphs.values()) { m.dispose(); }
    this.skeleton?.dispose();
    this.clips.clear(); this.morphs.clear(); this.morphIndex.clear();
    this.nodes.clear(); this.restQ.clear();
    this.furlCur.clear(); this.furlTarget.clear(); this.pairBySail.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private applyRudder(): void {
    // Symmetric Rudder clip, authored REVERSED on this rig (0 = stbd, 1 = port), so negate to map
    // rudderCur (−1 port .. +1 stbd) the right way. Spin the wheel alongside.
    this.poseNorm('Rudder', 0.5 - this.rudderCur * 0.5);
    const w = this.nodes.get('B_Wheel'); const wRest = this.restQ.get('B_Wheel');
    if (w && wRest) w.rotationQuaternion = wRest.multiply(Quaternion.RotationAxis(this.WHEEL_AXIS, this.rudderCur * this.WHEEL_MAX_RAD));
  }

  private applyTrim(): void { this.poseNorm('Trim', this.trimCur); }

  private applyGunPose(side: GunSide): void {
    const dep = this.gunDeployCur[side];
    const lid = Math.max(0, Math.min(1, dep * 2));            // lid opens over the first half
    const gun = Math.max(0, Math.min(1, dep * 2 - 1) - this.gunRecoil[side]);   // gun runs out over the second half
    this.poseNorm(`Lid_${side}`, lid);
    this.poseNorm(`Gun_${side}`, gun);
  }

  private applyFurl(sail: string, v: number): void {
    const pair = this.pairBySail.get(sail);
    if (!pair) return;
    const mesh = this.sailMeshes.get(pair.sailMorph.node);
    if (mesh) { mesh.setEnabled(true); mesh.visibility = 1; }
    this.setMorphByName(pair.sailMorph.node, pair.sailMorph.target, v);
    // Drive the running-rigging Furl morphs WITH the sail (authored to gather correctly). Opt out via
    // ignis_mm_ropefurl='off'.
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

  /** Set a flag bone to point downwind (world-yaw `phi`) with flutter, Slerped from its rest (limp) pose by
   *  `w` so the flag hangs limp in dead air and streams as the wind fills in. Cancels the parent's trim
   *  deviation (the ensign rides B_Gaff, which yaws on trim) so the flag is WIND-only. */
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
      const cancel = Quaternion.Inverse(pCur).multiply(pRest);   // undo the parent's trim deviation
      q = cancel.multiply(q);
    }
    n.rotationQuaternion = Quaternion.Slerp(rest, q, w);
  }

  private static sailFurlTable(state: SailState): Record<string, number> {
    const t: Record<string, number> = {};
    for (const s of MerchantmanController.ALL_SAILS) t[s] = state === 'reefed' ? 1 : 0;
    if (state === 'topsails') for (const k of MerchantmanController.KITES) t[k] = 1;   // strike the light kites
    return t;
  }
}

/** Move `cur` toward `target` by at most `maxStep` (linear ease). */
function approach(cur: number, target: number, maxStep: number): number {
  if (cur === target) return cur;
  const d = target - cur;
  return cur + Math.sign(d) * Math.min(Math.abs(d), maxStep);
}
