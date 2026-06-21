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

/** A dismasting zone: its own fall clip + splinter morph, plus the masts-zone-fraction window over
 *  which it topples (so the two masts come down at different damage levels off ONE collective HP). */
interface MastZone {
  fallClip: string;
  breakNode: string;
  breakTarget: string;
  /** mast-damage fraction (= 1 − health) at which this mast STARTS leaning. */
  fallFrom: number;
  /** mast-damage fraction at which this mast is FULLY collapsed. */
  fallTo: number;
  // live eased state
  downCur: number;
  breakCur: number;
}

/**
 * Animation driver for the two-masted brigantine (brig.glb, manifest schema_version 2). Implements the
 * same VesselController contract as the sloop & pinnace against a bespoke rig that combines features of
 * both:
 *  • Square-rigged FOREmast (5 yards) + fore-and-aft gaff MAINmast share ONE symmetric Trim scrub clip
 *    (0 = braced to one tack, 0.5 = square / running, 1 = braced to the other tack) — driven like the
 *    pinnace's symmetric trim but with a square-rig mapping (braced close-hauled, square running).
 *  • Per-side gunnery WITH gunport lids (like the sloop): open the lid then run the gun out; recoil kicks
 *    the gun term toward stowed (Lid_{S|P} + Gun_{S|P}).
 *  • 13 sails furled by DIRECT morph drive; the modelled running rigging follows via Furl_<sail> morphs on
 *    Clews / RunRig_Sheets / UpperSheets — so sheets & clews rise with the furled sail.
 *  • TWO anchors (AnchorDrop_S / AnchorDrop_P), the game lowers whichever side it randomly chose.
 *  • SINGLE collective masts-zone HP drives BOTH masts: the foremast comes down first (while HP remains),
 *    the mainmast only at 0 HP. Each topples about its own hinge carrying its yards/sails/rigging.
 *  • Three flags (B_Flag_Ensign on the gaff, B_Flag_Burgee fore truck, B_Flag_Pennant main truck) stream
 *    downwind and flutter, going limp when the wind is dead; B_Wheel spins with the helm.
 *
 * AnimationGroups carry an 'NLA_' prefix in this GLB (NLA_Rudder, …); strip() removes both that and the
 * loader's .NNN datablock suffix, so clips are referenced by clean names (Rudder, Trim, MastDown_Fore, …).
 */
export class BrigController implements VesselController {
  readonly root: TransformNode;
  private readonly scene: Scene;
  private readonly manifest: RiggedManifest;
  private readonly skeleton: Skeleton | null;

  private readonly clips  = new Map<string, AnimationGroup>();
  private readonly morphs = new Map<string, MorphTargetManager>();
  /** (meshName + '|' + targetName) → morph-target INDEX, resolved by name at construction. */
  private readonly morphIndex = new Map<string, number>();
  /** The cat-tackle cable's morph manager + its per-side Drop target indices (captured directly so the cable
   *  pays out by index, since the by-name lookup was missing → "no rope" on anchor drop). */
  private cableMorph: MorphTargetManager | null = null;
  private cableIdx: { S: number; P: number } = { S: 0, P: 1 };
  /** Sail node name → its mesh, so a furled sail can be hidden (the asset's furl morphs read badly). */
  private readonly sailMeshes = new Map<string, AbstractMesh>();
  private prunedChannels = 0;
  private readonly nodes  = new Map<string, TransformNode>();
  private readonly restQ  = new Map<string, Quaternion>();
  /** A flag bone's PARENT's rest rotation — used to cancel the parent's trim so the flag is wind-only. */
  private readonly parentRestQ = new Map<string, Quaternion>();
  private readonly frameEnd: number;

  // Rudder + symmetric trim (scrub the clip's FULL range so 0.5 lands on true centre).
  private rudderCur = 0; private rudderTarget = 0;        // −1 hard port .. 0 centre .. +1 hard stbd
  private trimCur   = 0.5; private trimTarget = 0.5;       // 0 tack .. 0.5 square .. 1 other tack
  private readonly RUDDER_RATE = 4.0;
  private readonly TRIM_RATE   = 1.4;
  /** Tack-swing sign for the square-rig trim mapping (flip if the rig braces to the wrong side). */
  private readonly TRIM_TACK_SIGN = 1;
  private readonly WHEEL_MAX_RAD = Math.PI * 2;            // ~one turn lock-to-lock
  // B_Wheel's axle is its LOCAL X (the bone's local X points fore-aft) — NOT local Y. Spin about X.
  private readonly WHEEL_AXIS    = Vector3.Right();

  // Per-sail furl (keys = SailMorphPair.sail).
  private readonly pairBySail = new Map<string, SailMorphPair>();
  private readonly furlCur    = new Map<string, number>();
  private readonly furlTarget = new Map<string, number>();
  private readonly FURL_RATE = 0.5;

  // Gunnery with lids (sloop model): deploy 0 = stowed, 1 = ready (lid open + gun run out).
  private readonly gunDeployCur:    Record<GunSide, number> = { S: 0, P: 0 };
  private readonly gunDeployTarget: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly gunRecoil:       Record<GunSide, number> = { S: 0, P: 0 };
  private readonly GUN_DEPLOY_RATE  = 1.4;
  private readonly GUN_RECOIL_DECAY = 5.0;

  // Two anchors, one per side.
  private readonly anchorReq: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly anchorCur: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly ANCHOR_RATE = 0.7;

  // Two mast-damage zones driven off ONE collective health. Onset matches the HUD green→yellow boundary.
  private readonly mastZones: MastZone[] = [];
  private mastHealthTarget = 1;
  private readonly MAST_FALL_RATE = 0.4;

  /** Local staff axis each flag bone spins about (bones point head→tail along local Y). */
  private readonly FLAG_LOCAL_AXIS = Vector3.Up();
  /** Rest-bearing offset so a flag streams DOWNWIND from its staff (user: was 180° off at Math.PI → 0).
   *  Live-tunable via localStorage.ignis_brig_flag_deg (degrees). */
  private FLAG_YAW_OFFSET = 0;

  // Sail-state → per-sail furl. full = all set; topsails = strike the light kites; reefed = all furled.
  private static readonly KITES = ['ForeRoyal', 'ForeTGallant', 'GaffTopsail', 'FlyingJib', 'MainTGallStaysail', 'MainTopStaysail'];
  private static readonly ALL_SAILS = [
    'ForeCourse', 'ForeLowerTops', 'ForeUpperTops', 'ForeTGallant', 'ForeRoyal', 'MainGaff', 'GaffTopsail',
    'ForeStaysail', 'InnerJib', 'FlyingJib', 'MainStaysail', 'MainTopStaysail', 'MainTGallStaysail',
  ];

  constructor(entries: InstantiatedEntries, root: TransformNode, manifest: RiggedManifest, scene: Scene) {
    this.root = root;
    this.scene = scene;
    this.manifest = manifest;
    this.skeleton = entries.skeletons[0]
      ?? (root.getChildMeshes(false).find((m) => (m as { skeleton?: Skeleton }).skeleton) as
            { skeleton?: Skeleton } | undefined)?.skeleton
      ?? null;
    this.frameEnd = manifest.frame_range?.[1] ?? 30;
    const fdeg = (typeof localStorage !== 'undefined') ? localStorage.getItem('ignis_brig_flag_deg') : null;
    if (fdeg !== null && !isNaN(parseFloat(fdeg))) this.FLAG_YAW_OFFSET = parseFloat(fdeg) * Math.PI / 180;

    // CRITICAL: the brig's clips are FULL-SKELETON bakes — every clip animates ALL ~81 bone channels, not
    // just its own targets (unlike the sparse sloop/pinnace clips). Layered scrubbing would clobber: posing
    // Gun_S after Lid_S resets the lid bones to rest (ports never open), and any clip resets the flags that
    // idleWind just moved. Strip the CONSTANT channels so each clip only drives the bones it actually moves,
    // making them compose like the sparse rigs do.
    let pruned = 0;
    for (const g of entries.animationGroups) {
      g.stop();
      pruned += BrigController.pruneConstantChannels(g);
      this.clips.set(BrigController.strip(g.name), g);
    }
    this.prunedChannels = pruned;

    for (const mesh of root.getChildMeshes(false)) {
      const name = BrigController.strip(mesh.name);
      const mgr = (mesh as { morphTargetManager?: MorphTargetManager }).morphTargetManager;
      if (mgr) {
        this.morphs.set(name, mgr);
        let dropS = -1, dropP = -1;
        for (let i = 0; i < mgr.numTargets; i++) {
          const t = mgr.getTarget(i);
          if (!t) continue;
          this.morphIndex.set(name + '|' + t.name, i);
          if (/drop_?s/i.test(t.name)) dropS = i;
          if (/drop_?p/i.test(t.name)) dropP = i;
        }
        // Capture the cat-tackle cable's morph manager directly (its name lookup was missing) + the per-side
        // target indices so the anchor drive can pay the cable out by index regardless of the mesh's loaded name.
        if (/cattackle/i.test(name) || dropS >= 0 || dropP >= 0) {
          this.cableMorph = mgr;
          // SWAPPED on purpose: the AnchorDrop CLIPS are named for the GAME side (corrected for the glTF
          // handedness flip), but the cable morphs Drop_S/Drop_P are raw model-side — so the game-starboard
          // anchor (driven via AnchorDrop_S) pairs with the morph on the model's OTHER side. Pair them by side.
          this.cableIdx = { S: dropP >= 0 ? dropP : 1, P: dropS >= 0 ? dropS : 0 };
        }
      }

      // The merge corrupted the static hull's COLOR_0 vertex colors (garbage tints) — Babylon auto-applies
      // them (magenta/purple patches on the deck) while Blender's baked material ignores them. The hull has
      // no legit vertex-colour parts, so just turn them off. (Brig_Rigging keeps them for the flags.)
      if (name === 'Brig_Hull') mesh.useVertexColors = false;
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

    this.nodes.set(BrigController.strip(root.name), root);
    for (const n of root.getChildTransformNodes(false)) this.nodes.set(BrigController.strip(n.name), n);

    // Sail → furl-morph pairing (resolved by name; the manifest carries node+target, indices resolved above).
    for (const p of (manifest as unknown as { sail_sheet_pairs?: { sail: string; sail_morph: { node: string; target: string }; rigging_morphs?: { node: string; target: string }[] }[] }).sail_sheet_pairs ?? []) {
      this.pairBySail.set(p.sail, { sail: p.sail, sailMorph: p.sail_morph, rigging: p.rigging_morphs ?? [] });
    }

    // Two mast zones. The foremast topples first (fully down while HP remains); the main only at 0 HP.
    // Both windows live BELOW the damage onset (health < 0.60 → fraction > 0.40).
    const zones = (manifest as unknown as { mast_damage_zones?: { fall_clip: string; break_morph: { node: string; target: string } }[] }).mast_damage_zones ?? [];
    const windows: Record<string, [number, number]> = { /* fraction = 1 − health */
      MastDown_Fore: [1 - MAST_DAMAGE_ONSET, 0.70],   // 0.40 → 0.70  (foremast: down by ~30% HP remaining)
      MastDown_Main: [0.70, 1.00],                    // 0.70 → 1.00  (mainmast: down only at 0 HP)
    };
    for (const z of zones) {
      if (!this.clips.has(z.fall_clip)) continue;
      const [from, to] = windows[z.fall_clip] ?? [1 - MAST_DAMAGE_ONSET, 1];
      this.mastZones.push({
        fallClip: z.fall_clip, breakNode: z.break_morph.node, breakTarget: z.break_morph.target,
        fallFrom: from, fallTo: to, downCur: 0, breakCur: 0,
      });
    }

    // Capture rest rotation for the code-driven bones (flags + wheel).
    for (const name of ['B_Flag_Ensign', 'B_Flag_Burgee', 'B_Flag_Pennant', 'B_Wheel']) {
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

    // Default pose: centre helm + square trim, all sail set, guns run in + ports CLOSED (the bind pose may
    // leave the lids open, so pose them shut), anchors stowed.
    this.applyRudder();
    this.applyTrim();
    this.applySailState('full', true);
    this.applyGunPose('S');
    this.applyGunPose('P');

    if (!BrigController._loggedMorphs) {
      BrigController._loggedMorphs = true;
      const missing: string[] = [];
      for (const p of this.pairBySail.values()) {
        if (!this.hasMorph(p.sailMorph.node, p.sailMorph.target)) missing.push(p.sailMorph.node + '|' + p.sailMorph.target);
        for (const r of p.rigging) if (!this.hasMorph(r.node, r.target)) missing.push(r.node + '|' + r.target);
      }
      for (const z of this.mastZones) if (!this.hasMorph(z.breakNode, z.breakTarget)) missing.push(z.breakNode + '|' + z.breakTarget);
      console.log(`[Brig] clips (${this.clips.size}), pruned ${this.prunedChannels} constant channels:`, [...this.clips.keys()].join(', '));
      if (missing.length) console.warn('[Brig] UNRESOLVED morphs →', missing.join(', '));
      else console.log('[Brig] all sail/rope/mast morphs resolved by name ✓');
      const flagState = ['B_Flag_Ensign', 'B_Flag_Burgee', 'B_Flag_Pennant', 'B_Wheel']
        .map((n) => `${n}=${this.restQ.has(n) ? 'ok' : 'MISSING'}`).join(', ');
      console.log('[Brig] free-rotation bones:', flagState);
    }
  }

  private static _loggedMorphs = false;
  private static strip(name: string): string { return name.replace(/^NLA_/, '').replace(/\.\d{3,}$/, ''); }

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

  /** Drop the constant channels from a full-skeleton-baked clip so it only drives the bones it animates
   *  (lets the brig's dense clips compose instead of clobbering each other). Returns #channels removed. */
  private static pruneConstantChannels(g: AnimationGroup): number {
    const arr = g.targetedAnimations;
    const keep = arr.filter((ta) => {
      const anim = ta.animation as unknown as { getKeys(): { value: unknown }[]; targetProperty?: string };
      // Drop MORPH-WEIGHT channels: every morph (sail furl, cat-tackle pay-out, mast break) is driven DIRECTLY
      // via setMorphByName. A clip that's posed for its BONE (e.g. AnchorDrop_S moves B_Anchor_S) would otherwise
      // also re-apply its baked morph-weight curve every goToFrame, fighting/zeroing the direct drive — which is
      // why the anchor cable wasn't paying out with the anchor.
      if (anim.targetProperty === 'influence') return false;
      return !BrigController.isConstantAnim(anim);
    });
    const removed = arr.length - keep.length;
    if (removed > 0) { arr.length = 0; for (const ta of keep) arr.push(ta); }
    return removed;
  }

  private pose(clipName: string, frame: number): void {
    const g = this.clips.get(clipName);
    if (!g) return;
    if (!g.animatables.length) { g.start(false, 1.0, g.from, g.to); g.pause(); }
    g.goToFrame(frame);
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
    const table = BrigController.sailFurlTable(state);
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

  /** Single collective mast HP (1 intact .. 0 destroyed) → both masts (tickRig eases the two zones). */
  setMastDamage(health: number): void { this.mastHealthTarget = Math.max(0, Math.min(1, health)); }

  dropAnchor(side: GunSide, t: number): void { this.anchorReq[side] = Math.max(0, Math.min(1, t)); }

  idleWind(windDirLocalRad: number, strength: number, t: number): void {
    const s = Math.max(0, Math.min(1.5, strength));
    const w = Math.max(0, Math.min(1, (s - 0.02) / 0.10));   // 0 = limp (dead air) .. 1 = streaming (fills in fast)
    const base = windDirLocalRad + this.FLAG_YAW_OFFSET;
    // Ensign (on the gaff), burgee (fore truck), pennant (main truck) — each streams downwind with a
    // phase-lagged flutter; the pennant is the longest/laggiest. Slerped from rest by w so they go limp.
    this.streamFlag('B_Flag_Ensign',  base + Math.sin(t * 2.0) * 0.18 * s, w);
    this.streamFlag('B_Flag_Burgee',  base + Math.sin(t * 2.4 + 0.3) * 0.24 * s, w);
    this.streamFlag('B_Flag_Pennant', base + Math.sin(t * 1.6 - 0.4) * 0.38 * s, w);

    SailBillowPlugin.wind.strength = s;
    SailBillowPlugin.wind.time = t;
  }

  tickRig(dt: number): void {
    this.rudderCur = approach(this.rudderCur, this.rudderTarget, this.RUDDER_RATE * dt);
    this.applyRudder();
    this.trimCur = approach(this.trimCur, this.trimTarget, this.TRIM_RATE * dt);
    this.applyTrim();

    // Furl — ease per sail, and RE-APPLY the morph every frame so a sail can never get stuck at a stale
    // influence (drives the morph to match furlCur regardless).
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

    // Anchors — ease each side; pose only when not fully stowed.
    for (const side of ['S', 'P'] as const) {
      this.anchorCur[side] = approach(this.anchorCur[side], this.anchorReq[side], this.ANCHOR_RATE * dt);
      if (this.anchorCur[side] > 0.0001 || this.anchorReq[side] > 0) {
        this.poseNorm(`AnchorDrop_${side}`, this.anchorCur[side]);
        // Pay the cat-tackle cable out WITH the anchor. The clip's morph-weight channel doesn't retarget to the
        // cloned mesh, so drive it directly. Drive BY INDEX (0=Drop_S, 1=Drop_P — the GLB target order) rather
        // than by name: the by-name lookup was silently missing (cable never extended → "no rope"), but the
        // CatTackle morph manager itself is in the map.
        const ctTgt = this.cableMorph?.getTarget(this.cableIdx[side]);
        if (ctTgt) ctTgt.influence = this.anchorCur[side];
      }
    }

    // Mast damage — map the single health onto each zone's own collapse window, ease, pose + break morph.
    const frac = 1 - this.mastHealthTarget;   // 0 intact .. 1 destroyed
    for (const z of this.mastZones) {
      const span = Math.max(0.0001, z.fallTo - z.fallFrom);
      const downTgt = Math.max(0, Math.min(1, (frac - z.fallFrom) / span));   // 0 upright .. 1 collapsed
      // Splinter ramps over the last ~40% of this mast's own fall.
      const breakTgt = Math.max(0, Math.min(1, (downTgt - 0.6) / 0.4));
      z.downCur  = approach(z.downCur,  downTgt,  this.MAST_FALL_RATE * dt);
      z.breakCur = approach(z.breakCur, breakTgt, this.MAST_FALL_RATE * dt);
      if (z.downCur > 0.0001 || downTgt > 0) {
        this.poseNorm(z.fallClip, z.downCur);
        this.setMorphByName(z.breakNode, z.breakTarget, z.breakCur);
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
    // meshes alone leaks them as NPCs churn through interest range. See RiggedVesselController.dispose.
    for (const m of this.morphs.values()) { m.dispose(); }
    this.skeleton?.dispose();
    this.clips.clear(); this.morphs.clear(); this.morphIndex.clear();
    this.nodes.clear(); this.restQ.clear();
    this.furlCur.clear(); this.furlTarget.clear(); this.pairBySail.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private applyRudder(): void {
    // Symmetric Rudder clip: 0 = hard port, 0.5 = centre, 1 = hard starboard. Spin the wheel alongside.
    this.poseNorm('Rudder', 0.5 + this.rudderCur * 0.5);
    const w = this.nodes.get('B_Wheel'); const wRest = this.restQ.get('B_Wheel');
    if (w && wRest) w.rotationQuaternion = wRest.multiply(Quaternion.RotationAxis(this.WHEEL_AXIS, this.rudderCur * this.WHEEL_MAX_RAD));
  }

  private applyTrim(): void { this.poseNorm('Trim', this.trimCur); }

  private applyGunPose(side: GunSide): void {
    const dep = this.gunDeployCur[side];
    const lid = Math.max(0, Math.min(1, dep * 2));            // lid opens over the first half
    const gun = Math.max(0, Math.min(1, dep * 2 - 1) - this.gunRecoil[side]);   // gun runs out over the second half
    // NORMALIZED scrub — the brig's clips run 0..1.25s (NOT 0..30 frames), so an absolute *frameEnd scrub
    // would only reach ~80% and the lids would never fully open. poseNorm hits the true open/run-out pose.
    this.poseNorm(`Lid_${side}`, lid);
    this.poseNorm(`Gun_${side}`, gun);
  }

  private applyFurl(sail: string, v: number): void {
    const pair = this.pairBySail.get(sail);
    if (!pair) return;
    // The sail Furl morphs were re-authored to gather realistically (square sails UP to the yard, fore-and-aft
    // IN to the luff/stay), so DRIVE the sail morph — it eases via furlCur in tickRig, giving a smooth furl.
    // We still do NOT drive the rope Furl morphs (those fling the sheets off the mastheads); the running
    // rigging stays at its set position, close to the furled sail on the spar.
    const mesh = this.sailMeshes.get(pair.sailMorph.node);
    if (mesh) { mesh.setEnabled(true); mesh.visibility = 1; }
    this.setMorphByName(pair.sailMorph.node, pair.sailMorph.target, v);
    // Drive the running-rigging clew morphs too — re-authored (v6 bake) so each clew line carries up WITH its
    // sail. UpperSheets was deleted, so its morphs resolve to nothing (no-op).
    for (const r of pair.rigging) this.setMorphByName(r.node, r.target, v);
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

  /** Set a flag bone to point downwind (world-yaw `phi`) with flutter, Slerped from its rest (limp) pose
   *  by `w` so the flag hangs limp in dead air and streams as the wind fills in. Mirrors the sloop's
   *  heel-independent world-Y spin (preserves the staff's authored tilt). */
  private streamFlag(name: string, phi: number, w: number): void {
    const n = this.nodes.get(name); const rest = this.restQ.get(name);
    if (!n || !rest) return;
    if (w <= 0.0001) { n.rotationQuaternion = rest.clone(); return; }
    // Spin about the bone's OWN staff axis (local Y) so the flag swings around its pole in place. THEN cancel
    // the parent's deviation from its rest pose so trim (which rotates B_Gaff under the ensign) doesn't carry
    // the flag with it — the flag is driven by WIND only. The burgee/pennant parents don't trim, so their
    // cancel is ~identity. Tunable: flip FLAG_LOCAL_AXIS to Right()/Forward() if local-Y isn't the staff.
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
    for (const s of BrigController.ALL_SAILS) t[s] = state === 'reefed' ? 1 : 0;
    if (state === 'topsails') for (const k of BrigController.KITES) t[k] = 1;   // strike the light kites
    return t;
  }
}

/** Move `cur` toward `target` by at most `maxStep` (linear ease). */
function approach(cur: number, target: number, maxStep: number): number {
  if (cur === target) return cur;
  const d = target - cur;
  return cur + Math.sign(d) * Math.min(Math.abs(d), maxStep);
}
