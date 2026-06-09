import {
  Scene, TransformNode, AnimationGroup, MorphTargetManager, Quaternion, Vector3, Matrix,
  InstantiatedEntries, Skeleton, PBRMaterial,
} from '@babylonjs/core';
import { RiggedManifest, SailState } from '../models';
import type { VesselController, GunSide } from './vessel-controller';
import { SailBillowPlugin } from './sail-billow.plugin';
import { BakedAOPlugin } from './baked-ao.plugin';

/**
 * Animation driver for the RN 28-ft pinnace (manifest schema_version 2). Implements the same
 * VesselController contract as the sloop but against a different, simpler rig:
 *  • Rudder + Trim are SYMMETRIC scrub clips (0=port, 0.5=centre, 1=starboard) on transform nodes / the
 *    MainTrim+JibTrim bones — not a wheel + one-sided brace + boom/gaff swing.
 *  • 2 sails (Mainsail, Jib) furled via `Furl` morphs (+ their rigging morphs), driven directly.
 *  • Guns are GunMount_P/_S translation scrubs (run-out 0..1); recoil kicks the same travel toward stowed
 *    and eases back. NO gunport lids.
 *  • ONE anchor (AnchorDrop scrub + AnchorCable morph) — dropped whichever side the game requests.
 *  • Flag1>Flag2>Flag3 bone chain rippled in code (no clip).
 */
export class PinnaceController implements VesselController {
  readonly root: TransformNode;
  private readonly scene: Scene;
  private readonly manifest: RiggedManifest;
  private readonly skeleton: Skeleton | null;

  private readonly clips  = new Map<string, AnimationGroup>();
  private readonly morphs = new Map<string, MorphTargetManager>();
  private readonly nodes  = new Map<string, TransformNode>();
  private readonly restQ  = new Map<string, Quaternion>();
  private readonly pairBySail = new Map<string, RiggedManifest['sail_sheet_pairs'][number]>();
  private readonly frameEnd: number;

  // Rudder is driven DIRECTLY on the Rudder node (its rest = true amidships, so t=0 is centred and the
  // direction is a single sign — the authored Rudder *clip*'s center frame proved unreliable). Tiller is
  // a child and follows. Trim defaults to 0.5 (centre scrub); guns/anchor/furl to 0.
  private rudderCur = 0; private rudderTarget = 0;        // −1 hard port .. 0 centre .. +1 hard stbd
  private trimCur   = 0.5; private trimTarget   = 0.5;
  private readonly RUDDER_RATE    = 4.0;                  // units/sec
  private readonly RUDDER_MAX_RAD = 30 * Math.PI / 180;   // manifest rudder_max_deg
  private RUDDER_SIGN: 1 | -1 = 1;                        // deflect direction (tune; flipped vs the sloop)
  private readonly TRIM_RATE   = 1.6;

  // Furl per sail (keys match sail_sheet_pairs[].sail: 'Mainsail', 'Jib').
  private readonly furlCur    = new Map<string, number>();
  private readonly furlTarget = new Map<string, number>();
  private readonly FURL_RATE = 0.6;

  private readonly gunCur:    Record<GunSide, number> = { S: 0, P: 0 };
  private readonly gunTarget: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly gunRecoil: Record<GunSide, number> = { S: 0, P: 0 };
  private readonly GUN_DEPLOY_RATE  = 1.4;
  private readonly GUN_RECOIL_DECAY = 5.0;

  // Single anchor: the game drops a side; we take whichever side is requested (max) for the one anchor.
  private readonly anchorReq: Record<GunSide, number> = { S: 0, P: 0 };
  private anchorCur = 0;
  private readonly ANCHOR_RATE = 0.7;

  // Sail-state → per-sail furl. USER CHOICE: reef the main, keep the jib.
  private static readonly SAIL_STATE_FURL: Record<SailState, Record<string, number>> = {
    full:     { Mainsail: 0.0, Jib: 0 },
    topsails: { Mainsail: 0.5, Jib: 0 },   // main reefed ~50%, jib still up
    reefed:   { Mainsail: 1.0, Jib: 1 },
  };

  private readonly FLAG_AXIS = Vector3.Up();   // flutter yaw axis (tunable)

  constructor(entries: InstantiatedEntries, root: TransformNode, manifest: RiggedManifest, scene: Scene) {
    this.root = root;
    this.scene = scene;
    this.manifest = manifest;
    this.skeleton = entries.skeletons[0]
      ?? (root.getChildMeshes(false).find((m) => (m as { skeleton?: Skeleton }).skeleton) as
            { skeleton?: Skeleton } | undefined)?.skeleton
      ?? null;
    this.frameEnd = manifest.frame_range?.[1] ?? 30;

    for (const g of entries.animationGroups) { g.stop(); this.clips.set(PinnaceController.strip(g.name), g); }

    for (const mesh of root.getChildMeshes(false)) {
      const name = PinnaceController.strip(mesh.name);
      const mgr = (mesh as { morphTargetManager?: MorphTargetManager }).morphTargetManager;
      if (mgr) this.morphs.set(name, mgr);

      // Wind-billow on the two sails (shared material → attach the plugin once).
      if ((name === 'MainSail' || name === 'Jib') && mesh.material instanceof PBRMaterial) {
        const mat = mesh.material;
        let plugin = mat.pluginManager?.getPlugin<SailBillowPlugin>('SailBillow') ?? null;
        if (!plugin) plugin = new SailBillowPlugin(mat);
        const bb = mesh.getBoundingInfo().boundingBox;
        plugin.configure(bb.minimum, bb.maximum);
      }
      // Surface the GLB's baked occlusion where present.
      if (mesh.material instanceof PBRMaterial) {
        const mat = mesh.material;
        if (mat.ambientTexture && !mat.pluginManager?.getPlugin('BakedAO')) { new BakedAOPlugin(mat); }
        mat.maxSimultaneousLights = 6;   // let the sun + cannon-flash point lights co-exist
      }
    }

    this.nodes.set(PinnaceController.strip(root.name), root);
    for (const n of root.getChildTransformNodes(false)) this.nodes.set(PinnaceController.strip(n.name), n);

    for (const p of manifest.sail_sheet_pairs ?? []) this.pairBySail.set(p.sail, p);

    // Capture rest rotation for the code-driven flag chain (the rudder is set absolutely, no rest needed).
    for (const name of ['Flag1', 'Flag2', 'Flag3']) {
      const n = this.nodes.get(name);
      if (n) {
        const q = n.rotationQuaternion ?? Quaternion.FromEulerAngles(n.rotation.x, n.rotation.y, n.rotation.z);
        n.rotationQuaternion = q.clone();
        this.restQ.set(name, q.clone());
      }
    }

    // Default pose: centre helm + trim, sails full, guns/anchor stowed.
    this.applyRudder();
    this.applyTrim();
    this.applySailState('full', true);
  }

  private static strip(name: string): string { return name.replace(/\.\d{3,}$/, ''); }

  private pose(clipName: string, frame: number): AnimationGroup | null {
    const g = this.clips.get(clipName);
    if (!g) return null;
    if (!g.animatables.length) { g.start(false, 1.0, g.from, g.to); g.pause(); }
    g.goToFrame(frame);
    return g;
  }

  // ── control surface ─────────────────────────────────────────────────────────
  setRudder(t: number): void {
    this.rudderTarget = Math.max(-1, Math.min(1, t));   // −1 hard port .. 0 centre .. +1 hard stbd
  }

  setSailTrim(sheetAngleDeg: number, isPortTack: boolean): void {
    // Symmetric lug trim: amidships (0.5) close-hauled, swung to the LEEWARD tack end as the sheet eases.
    const amount  = Math.max(0, Math.min(1, (sheetAngleDeg - 5) / 83));   // 0 close .. 1 fully eased
    const tackDir = isPortTack ? 1 : -1;                                  // port tack → swing to leeward (stbd end), stbd → port end
    this.trimTarget = 0.5 + tackDir * amount * 0.5;
  }

  applySailState(state: SailState, immediate = false): void {
    const table = PinnaceController.SAIL_STATE_FURL[state];
    for (const sail in table) {
      this.furlTarget.set(sail, table[sail]);
      if (immediate || !this.furlCur.has(sail)) { this.furlCur.set(sail, table[sail]); this.applyFurl(sail, table[sail]); }
    }
  }

  setGunDeployTarget(side: GunSide, t: number): void { this.gunTarget[side] = Math.max(0, Math.min(1, t)); }
  addGunRecoil(side: GunSide, kick = 0.7): void { this.gunRecoil[side] = Math.min(1, this.gunRecoil[side] + kick); }
  isGunReady(side: GunSide): boolean { return this.gunCur[side] >= 0.99; }
  gunSettled(side: GunSide): boolean {
    return Math.abs(this.gunCur[side] - this.gunTarget[side]) < 0.01 && this.gunRecoil[side] < 0.02;
  }
  setGunports(): void { /* pinnace has no gunport lids */ }

  dropAnchor(side: GunSide, t: number): void { this.anchorReq[side] = Math.max(0, Math.min(1, t)); }

  idleWind(windDirLocalRad: number, strength: number, t: number): void {
    const s = Math.max(0, Math.min(1.5, strength));
    // Travelling-wave flutter down the Flag1>Flag2>Flag3 chain (each local-yaw, bigger + more phase-lagged
    // toward the tip). Composed on rest; skeleton.prepare in tickRig applies it.
    const amp = [0.05, 0.10, 0.17], lag = [0, -0.5, -1.0];
    for (let i = 0; i < 3; i++) {
      const n = this.nodes.get('Flag' + (i + 1)); const rest = this.restQ.get('Flag' + (i + 1));
      if (n && rest) {
        const a = Math.sin(t * 3.0 + lag[i]) * amp[i] * s;
        n.rotationQuaternion = rest.multiply(Quaternion.RotationAxis(this.FLAG_AXIS, a));
      }
    }
    SailBillowPlugin.wind.strength = s;
    SailBillowPlugin.wind.time = t;
  }

  tickRig(dt: number): void {
    // Rudder + Trim — ease then re-scrub (centred default means we must pose every frame).
    this.rudderCur = approach(this.rudderCur, this.rudderTarget, this.RUDDER_RATE * dt);
    this.applyRudder();
    this.trimCur = approach(this.trimCur, this.trimTarget, this.TRIM_RATE * dt);
    this.applyTrim();

    // Furl — ease per sail.
    const step = this.FURL_RATE * dt;
    for (const [sail, target] of this.furlTarget) {
      let cur = this.furlCur.get(sail); if (cur === undefined) cur = target;
      if (cur !== target) { cur = cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step); this.furlCur.set(sail, cur); this.applyFurl(sail, cur); }
    }

    // Guns — ease run-out + decay recoil; pose only when not fully stowed.
    for (const side of ['S', 'P'] as const) {
      this.gunCur[side] = approach(this.gunCur[side], this.gunTarget[side], this.GUN_DEPLOY_RATE * dt);
      if (this.gunRecoil[side] > 0) { this.gunRecoil[side] = Math.max(0, this.gunRecoil[side] - this.GUN_RECOIL_DECAY * dt); }
      if (this.gunCur[side] !== 0 || this.gunTarget[side] !== 0 || this.gunRecoil[side] > 0) {
        const eff = Math.max(0, this.gunCur[side] - this.gunRecoil[side]);   // recoil kicks toward stowed
        this.pose(`Gun_${side}`, eff * this.frameEnd);
      }
    }

    // Anchor — single anchor; whichever side the game dropped (max) drives it.
    const anchorT = Math.max(this.anchorReq.S, this.anchorReq.P);
    this.anchorCur = approach(this.anchorCur, anchorT, this.ANCHOR_RATE * dt);
    if (this.anchorCur > 0.0001 || anchorT > 0) { this.pose('AnchorDrop', this.anchorCur * this.frameEnd); }

    // Recompute the skinned rigging (MainTrim/JibTrim bones + flag chain were just posed).
    if (this.skeleton) {
      (this.skeleton as unknown as { _isDirty: boolean })._isDirty = true;
      this.skeleton.prepare(true);
    }
  }

  getMeshes() { return this.root.getChildMeshes(false); }

  dispose(): void {
    for (const g of this.clips.values()) { g.stop(); g.dispose(); }
    this.clips.clear(); this.morphs.clear(); this.nodes.clear(); this.restQ.clear();
    this.furlCur.clear(); this.furlTarget.clear(); this.pairBySail.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private applyRudder(): void {
    // The Rudder node's animation is a PURE Y-yaw (verified from the GLB: every keyframe is (0, Y, 0),
    // centre = 0°, extremes ±30°). Its BIND pose, though, is yaw +30° (hard over), so we set the local
    // yaw ABSOLUTELY rather than composing on rest — t=0 is then dead centre, direction is one sign.
    const n = this.nodes.get('Rudder');
    if (n) n.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), this.rudderCur * this.RUDDER_MAX_RAD * this.RUDDER_SIGN);
  }
  private applyTrim(): void { this.pose('Trim', this.trimCur * this.frameEnd); }

  /** Drive a sail's furl morph + all its rigging morphs (sheets/tack/clew block) to the same value. */
  private applyFurl(sail: string, v: number): void {
    const pair = this.pairBySail.get(sail);
    if (!pair) return;
    this.setMorph(pair.sail_morph.node, pair.sail_morph.index, v);
    const rigging = (pair as { rigging_morphs?: { node: string; index: number }[] }).rigging_morphs ?? [];
    for (const r of rigging) this.setMorph(r.node, r.index, v);
    // Schema-1 compatibility (single sheet_morph), harmless if absent.
    const single = (pair as { sheet_morph?: { node: string; index: number } | null }).sheet_morph;
    if (single) this.setMorph(single.node, single.index, v);
  }

  private setMorph(meshNode: string, index: number, value: number): void {
    const target = this.morphs.get(meshNode)?.getTarget(index);
    if (target) target.influence = value;
  }
}

/** Move `cur` toward `target` by at most `maxStep` (linear ease). */
function approach(cur: number, target: number, maxStep: number): number {
  if (cur === target) return cur;
  const d = target - cur;
  return cur + Math.sign(d) * Math.min(Math.abs(d), maxStep);
}
