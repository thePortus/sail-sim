import {
  Scene, TransformNode, AnimationGroup, MorphTargetManager, Quaternion, Vector3, Matrix,
  InstantiatedEntries, Skeleton, PBRMaterial,
} from '@babylonjs/core';
import { RiggedManifest, SailState } from '../models';
import { SailBillowPlugin } from './sail-billow.plugin';
import { BakedAOPlugin } from './baked-ao.plugin';

/**
 * Per-vessel animation driver for a single rigged GLB (e.g. bermuda_sloop_rigged.glb).
 *
 * One instance wraps one instantiated model — the local ship (VesselService) and
 * every remote player (MultiplayerService) each own their own controller, all cloned
 * from one cached AssetContainer. Babylon's `instantiateModelsToScene` clones the
 * skeleton, animation groups, and morph managers per call, so each vessel animates
 * and furls independently.
 *
 * Animation mechanisms (only two, per the model briefing):
 *  • Skeletal clips — we SCRUB them (start once → pause → goToFrame each frame) to pose
 *    rudder/yard-trim, rather than play them. Recoil-style "play" clips are deferred.
 *  • Morph targets — sail furl + paired sheet ropes, driven directly by influence.
 *  • Free bones (flag / pennant / wheel) — no clip; rotated in code.
 *
 * Trim is HYBRID: the Trim clip scrubs the square YARDS, while the fore-aft B_Boom /
 * B_Gaff are overwritten each frame (after the clip scrub) so they swing to the correct
 * leeward side per tack — which a single one-sided clip can't represent.
 */
export class SloopController {
  readonly root: TransformNode;
  private readonly scene: Scene;
  private readonly manifest: RiggedManifest;
  /** Cloned skeleton driving the skinned rigging ropes; re-prepared each frame in tickRig. */
  private readonly skeleton: Skeleton | null;

  /** clip name (suffix-stripped) → cloned AnimationGroup */
  private readonly clips = new Map<string, AnimationGroup>();
  /** mesh node name (suffix-stripped) → its morph target manager */
  private readonly morphs = new Map<string, MorphTargetManager>();
  /** joint node name (suffix-stripped) → its TransformNode (bones link to these) */
  private readonly nodes = new Map<string, TransformNode>();
  /** rest-pose rotation captured per code-driven node, for offset composition */
  private readonly restQ = new Map<string, Quaternion>();
  /** sail name → its sheet-pairing entry (for furl + rope lockstep) */
  private readonly pairBySail = new Map<string, RiggedManifest['sail_sheet_pairs'][number]>();

  /** Animated furl state: current + target per sail, eased by tickRig so sail-state
   *  changes play out along the furl morph instead of snapping. */
  private readonly sailFurlCur = new Map<string, number>();
  private readonly sailFurlTarget = new Map<string, number>();
  private readonly FURL_RATE = 0.6;   // furl units/sec (~1.7s for a full furl or set)

  /** Animated yard-trim + boom/gaff swing. Eased by tickRig so an auto-trim jump or a
   *  tack change swings the boom across the deck instead of teleporting it. */
  private trimCur:  number | undefined;
  private trimTarget = 0;
  private boomCur:  number | undefined;
  private boomTarget = 0;
  private readonly TRIM_RATE       = 2.0;   // braced units/sec
  private readonly BOOM_SWING_RATE = 1.8;   // rad/sec (~1.2s for a 120° tack swing)

  /** Per-side gunnery animation (keyed 'S'/'P'). deploy 0 = stowed (gun in, lid closed),
   *  1 = ready (lid open, gun run out). The single eased value auto-orders the manifest
   *  rule: opening runs lid-then-gun, stowing runs gun-then-lid. recoil is subtracted from
   *  the gun term only (lid stays open while the barrel kicks). */
  private readonly gunDeployCur:    Record<'S' | 'P', number> = { S: 0, P: 0 };
  private readonly gunDeployTarget: Record<'S' | 'P', number> = { S: 0, P: 0 };
  private readonly gunRecoil:       Record<'S' | 'P', number> = { S: 0, P: 0 };
  private readonly GUN_DEPLOY_RATE  = 1.4;   // deploy units/sec (~0.7s to arm or stow)
  private readonly GUN_RECOIL_DECAY = 5.0;   // recoil kick decay per sec

  private readonly frameEnd: number;

  // Sail-state → per-sail furl table (0 = set, 1 = furled). Semantic per-sail mapping;
  // tunable per future ship. Keep keys aligned with manifest sail names.
  private static readonly SAIL_STATE_FURL: Record<SailState, Record<string, number>> = {
    full:     { Mainsail: 0, Topsail: 0, Topgallant: 0, Course: 0, ForeStaysail: 0, Jib: 0 },
    topsails: { Mainsail: 1, Topsail: 0, Topgallant: 1, Course: 1, ForeStaysail: 0, Jib: 0 },
    reefed:   { Mainsail: 1, Topsail: 1, Topgallant: 1, Course: 1, ForeStaysail: 1, Jib: 1 },
  };

  // Runtime-tunable rig calibration (see verification notes). Sign/axis eyeballed once
  // against the rendered model; centralized here so tuning is a one-line change.
  private readonly BOOM_SWING_AXIS = Vector3.Up();   // ship-vertical swing axis (parent frame)
  private readonly WHEEL_MAX_RAD   = Math.PI * 2;    // ~one turn lock-to-lock
  private readonly WHEEL_AXIS      = Vector3.Up();   // wheel spins about its OWN axle = local Y (re-aimed in the GLB)
  private readonly RUDDER_MAX_RAD  = 35 * Math.PI / 180; // ±35° hard-over (from manifest)
  private readonly RUDDER_SIGN     = 1;               // deflect direction (matches helm/turn)
  // Constant correction for the flag's rest bearing (the flag's rest streams along the
  // flipped hull's aft, ≈180° off downwind). Tunable — nudge by ±π/2 if it's off by a
  // quarter-turn, or flip sign if it streams upwind.
  private FLAG_YAW_OFFSET = Math.PI;

  constructor(entries: InstantiatedEntries, root: TransformNode, manifest: RiggedManifest, scene: Scene) {
    this.root = root;
    this.scene = scene;
    this.manifest = manifest;
    // Prefer the cloned skeleton from the instantiate entries; fall back to whatever a
    // skinned child mesh references (so the rigging ropes always have a skeleton to drive).
    this.skeleton = entries.skeletons[0]
      ?? (root.getChildMeshes(false).find((m) => (m as { skeleton?: Skeleton }).skeleton) as
            { skeleton?: Skeleton } | undefined)?.skeleton
      ?? null;
    this.frameEnd = manifest.frame_range?.[1] ?? 30;

    // Index animation clips and stop any that the loader may have auto-started.
    for (const g of entries.animationGroups) {
      g.stop();
      this.clips.set(SloopController.strip(g.name), g);
    }

    // Index morph managers by their owning mesh's (stripped) name, and attach the
    // wind-driven billow plugin to each sail's (shared) PBR material.
    for (const mesh of root.getChildMeshes(false)) {
      const name = SloopController.strip(mesh.name);
      const mgr = (mesh as { morphTargetManager?: MorphTargetManager }).morphTargetManager;
      if (mgr) this.morphs.set(name, mgr);

      if (name.startsWith('Sail_') && mesh.material instanceof PBRMaterial) {
        const mat = mesh.material;
        // Material is shared across vessels → create the plugin once, reuse it thereafter.
        let plugin = mat.pluginManager?.getPlugin<SailBillowPlugin>('SailBillow') ?? null;
        if (!plugin) plugin = new SailBillowPlugin(mat);
        const bb = mesh.getBoundingInfo().boundingBox;
        plugin.configure(bb.minimum, bb.maximum);
      }

      // Surface the GLB's baked AO (ORM occlusion) on every PBR part — Babylon only applies it
      // to (absent) IBL, so without this the bake is invisible. Shared material → attach once.
      if (mesh.material instanceof PBRMaterial &&
          !mesh.material.pluginManager?.getPlugin('BakedAO')) {
        // Full-strength baked AO up close; the plugin itself fades it out with camera distance so the
        // occlusion map's coarse (darker) mips can't drive the ship toward black at range — see
        // BakedAOPlugin.bindForSubMesh.
        new BakedAOPlugin(mesh.material);
        // Allow the sun + several cannon muzzle-flash point lights at once, so a nearby
        // broadside lights this hull without displacing the sun (which would darken the ship).
        mesh.material.maxSimultaneousLights = 6;
      }
    }

    // Index every descendant TransformNode (glTF joints link bones to these).
    this.nodes.set(SloopController.strip(root.name), root);
    for (const n of root.getChildTransformNodes(false)) {
      this.nodes.set(SloopController.strip(n.name), n);
    }

    // Build the sail → sheet-pair lookup.
    for (const p of manifest.sail_sheet_pairs ?? []) this.pairBySail.set(p.sail, p);

    // Capture rest rotation for the code-driven bones so swings compose onto rest pose.
    for (const name of ['B_Boom', 'B_Gaff', 'B_Flag', 'B_Pennant', 'B_Wheel', 'B_Rudder']) {
      const n = this.nodes.get(name);
      if (n) {
        const q = n.rotationQuaternion
          ?? Quaternion.FromEulerAngles(n.rotation.x, n.rotation.y, n.rotation.z);
        n.rotationQuaternion = q.clone();
        this.restQ.set(name, q.clone());
      }
    }

    // Default pose: sails set, rudder centered, gunports shut, anchors stowed.
    this.applySailState('full', true);
    this.setRudder(0);
    this.setTrim(0);
    // Guns stowed: pose both Lid (→closed) and Gun (→pulled in) to frame 0. The lid bind
    // pose is OPEN, so this is required to start shut; deploy stays 0 until a side is armed.
    this.applyGunPose('S');
    this.applyGunPose('P');
    this.dropAnchor('S', 0);
    this.dropAnchor('P', 0);

    // One-time sanity check: the skinned rigging ropes must be weighted to the spar bones
    // (e.g. Course_Sheets tops → B_Yard_Low) to follow trim. If this logs only ROOT, the GLB
    // is missing those vertex weights and the ropes stay planted regardless of code.
    if (!SloopController._loggedWeights) {
      SloopController._loggedWeights = true;
      const cs = root.getChildMeshes(false).find((m) => SloopController.strip(m.name) === 'Course_Sheets');
      const idx = cs?.getVerticesData?.('matricesIndices');
      const wts = cs?.getVerticesData?.('matricesWeights');
      if (cs && idx && wts) {
        const used = new Set<number>();
        for (let i = 0; i < idx.length; i++) if (wts[i] > 0.01) used.add(idx[i]);
        console.log('[Sloop] Course_Sheets weighted to bones →',
          [...used].sort((a, b) => a - b).map((bi) => this.skeleton?.bones[bi]?.name ?? bi).join(', '));
      }
    }
  }

  private static _loggedWeights = false;

  // ── name helpers ───────────────────────────────────────────────────────────
  /** Strip the loader's `.NNN` duplicate-datablock suffix (mesh names get it; node
   *  names stay clean, so this is a no-op for nodes). */
  private static strip(name: string): string { return name.replace(/\.\d{3,}$/, ''); }

  // ── clip scrubbing ─────────────────────────────────────────────────────────
  /** Pose a scrub clip at an absolute frame without playing it. Lazily starts+pauses
   *  the group so goToFrame has live animatables to write through. */
  private pose(clipName: string, frame: number): AnimationGroup | null {
    const g = this.clips.get(clipName);
    if (!g) return null;
    if (!g.animatables.length) {
      g.start(false, 1.0, g.from, g.to);
      g.pause();
    }
    g.goToFrame(frame);
    return g;
  }

  // ── public control surface ─────────────────────────────────────────────────

  /** -1 hard port .. 0 center .. +1 hard starboard. Drives the rudder bone directly (the
   *  authored Rudder clip only deflects one way), and spins the wheel. */
  setRudder(t: number): void {
    const a = Math.max(-1, Math.min(1, t));
    this.composeSpin('B_Rudder', Vector3.Up(), a * this.RUDDER_MAX_RAD * this.RUDDER_SIGN);
    // Wheel: spin about the bone's OWN re-aimed axle (local Y), composing the spin in the bone's LOCAL
    // frame (rest ⊗ spin) — unlike the parent-frame composeSpin used for the boom/gaff/rudder. The GLB now
    // weights only the disc (not the stand) to B_Wheel, so just the wheel turns.
    const w = this.nodes.get('B_Wheel');
    const wRest = this.restQ.get('B_Wheel');
    if (w && wRest) {
      w.rotationQuaternion = wRest.multiply(Quaternion.RotationAxis(this.WHEEL_AXIS, a * this.WHEEL_MAX_RAD));
    }
  }

  /** 0 = square (running) .. 1 = fully braced (close-hauled). Sets the yard-trim TARGET;
   *  tickRig() eases the Trim clip toward it so auto-trim doesn't snap the yards. */
  setTrim(braced: number): void {
    this.trimTarget = Math.max(0, Math.min(1, braced));
    if (this.trimCur === undefined) { this.trimCur = this.trimTarget; this.applyTrim(); }
  }

  private applyTrim(): void {
    this.pose('Trim', (this.trimCur ?? 0) * this.frameEnd);
  }

  /** Gunport lids per side: 0 = closed (default), 1 = open. */
  setGunports(side: 'S' | 'P', open: number): void {
    this.pose(`Lid_${side}`, Math.max(0, Math.min(1, open)) * this.frameEnd);
  }

  // ── Gunnery: run-out / stow / recoil (eased + applied in tickRig) ──────────
  /** Set the run-out target for a side: 0 = stowed (gun in, lid closed),
   *  1 = ready (lid open, gun run out). tickRig eases toward it. */
  setGunDeployTarget(side: 'S' | 'P', t: number): void {
    this.gunDeployTarget[side] = Math.max(0, Math.min(1, t));
  }

  /** Add a recoil impulse to a side (call once per cannon shot); decays in tickRig. */
  addGunRecoil(side: 'S' | 'P', kick = 0.7): void {
    this.gunRecoil[side] = Math.min(1, this.gunRecoil[side] + kick);
  }

  /** True once the side has fully run out (safe to fire). */
  isGunReady(side: 'S' | 'P'): boolean { return this.gunDeployCur[side] >= 0.99; }

  /** True once the side reached its target and recoil has settled (stow complete). */
  gunSettled(side: 'S' | 'P'): boolean {
    return Math.abs(this.gunDeployCur[side] - this.gunDeployTarget[side]) < 0.01
        && this.gunRecoil[side] < 0.02;
  }

  /** Derive lid + gun (recoil on the gun term only) from the current deploy value. */
  private applyGunPose(side: 'S' | 'P'): void {
    const dep = this.gunDeployCur[side];
    const lid = Math.max(0, Math.min(1, dep * 2));
    const gun = Math.max(0, Math.min(1, dep * 2 - 1) - this.gunRecoil[side]);
    this.pose(`Lid_${side}`, lid * this.frameEnd);
    this.pose(`Gun_${side}`, gun * this.frameEnd);
  }

  /** Anchor per side: 0 = stowed, 1 = fully lowered. */
  dropAnchor(side: 'S' | 'P', t: number): void {
    this.pose(`AnchorDrop_${side}`, Math.max(0, Math.min(1, t)) * this.frameEnd);
  }

  /** Tack-correct fore-aft swing TARGET for B_Boom + B_Gaff (about the ship-vertical axis).
   *  tickRig() eases the actual swing toward it so a tack change swings the boom across the
   *  deck instead of teleporting, and re-applies it each frame so it wins over the Trim clip. */
  setBoomSwing(swingRad: number): void {
    this.boomTarget = swingRad;
    if (this.boomCur === undefined) { this.boomCur = swingRad; this.applyBoomSwing(); }
  }

  private applyBoomSwing(): void {
    const a = this.boomCur ?? 0;
    this.composeSpin('B_Boom', this.BOOM_SWING_AXIS, a);
    this.composeSpin('B_Gaff', this.BOOM_SWING_AXIS, a);
  }

  /** Drive one sail's furl morph (0 set .. 1 furled) plus its paired sheet rope. */
  setSailFurl(sail: string, furl: number): void {
    const v = Math.max(0, Math.min(1, furl));
    const pair = this.pairBySail.get(sail);
    if (!pair) return;
    this.setMorph(pair.sail_morph.node, pair.sail_morph.index, v);
    if (pair.sheet_morph) this.setMorph(pair.sheet_morph.node, pair.sheet_morph.index, v);
  }

  /** Map the game's 3-state sail model onto per-sail furl TARGETS (semantic mapping).
   *  tickRig() eases the current furl toward these so the change animates. Pass
   *  immediate=true to snap (initial spawn pose, no animation). */
  applySailState(state: SailState, immediate = false): void {
    const table = SloopController.SAIL_STATE_FURL[state];
    for (const sail in table) {
      this.sailFurlTarget.set(sail, table[sail]);
      if (immediate || !this.sailFurlCur.has(sail)) {
        this.sailFurlCur.set(sail, table[sail]);
        this.setSailFurl(sail, table[sail]);
      }
    }
  }

  /** Per-frame easing of everything that should move gradually rather than snap: yard
   *  trim, boom/gaff swing, and sail furl. Call every frame AFTER setTrim/setBoomSwing/
   *  applySailState have set the targets. */
  tickRig(dt: number): void {
    // Yard trim — ease so auto-trim doesn't snap, and RE-SCRUB the Trim clip every frame so
    // the bone nodes are freshly posed right before we re-prepare the skeleton (below).
    if (this.trimCur !== undefined) {
      if (this.trimCur !== this.trimTarget) {
        const d = this.trimTarget - this.trimCur;
        this.trimCur += Math.sign(d) * Math.min(Math.abs(d), this.TRIM_RATE * dt);
      }
      this.applyTrim();
    }

    // Boom/gaff — ease toward the target and re-apply every frame so the manual swing
    // keeps overwriting the Trim clip's one-sided boom/gaff channels.
    if (this.boomCur !== undefined) {
      if (this.boomCur !== this.boomTarget) {
        const d = this.boomTarget - this.boomCur;
        this.boomCur += Math.sign(d) * Math.min(Math.abs(d), this.BOOM_SWING_RATE * dt);
      }
      this.applyBoomSwing();
    }

    // Sail furl — ease toward the per-sail target so sail-state changes play out.
    const step = this.FURL_RATE * dt;
    for (const [sail, target] of this.sailFurlTarget) {
      let cur = this.sailFurlCur.get(sail);
      if (cur === undefined) cur = target;
      if (cur === target) continue;
      cur = cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
      this.sailFurlCur.set(sail, cur);
      this.setSailFurl(sail, cur);
    }

    // Gunnery — ease run-out/stow toward target + decay recoil, then pose the Gun/Lid clips.
    // Skip sides that are fully stowed with no recoil so we don't fight the default pose
    // (and so remote vessels that never arm stay shut).
    for (const side of ['S', 'P'] as const) {
      const cur = this.gunDeployCur[side], tgt = this.gunDeployTarget[side];
      if (cur !== tgt) {
        const d = tgt - cur;
        this.gunDeployCur[side] = cur + Math.sign(d) * Math.min(Math.abs(d), this.GUN_DEPLOY_RATE * dt);
      }
      if (this.gunRecoil[side] > 0) {
        this.gunRecoil[side] = Math.max(0, this.gunRecoil[side] - this.GUN_RECOIL_DECAY * dt);
      }
      if (this.gunDeployCur[side] !== 0 || tgt !== 0 || this.gunRecoil[side] > 0) {
        this.applyGunPose(side);
      }
    }

    // Recompute the skeleton from the bone nodes we just posed. The yard/boom meshes are
    // parented children of bone nodes (they move for free), but the rigging ROPES
    // (Course_Sheets, Yard_Lifts_Braces, Gaff_Boom_Rig, …) are SKINNED — they only deform
    // when the skin matrices recompute. prepare() syncs the bones from their linked nodes,
    // but the recompute is gated behind the skeleton's dirty flag, which writing the NODES
    // never sets. Force it dirty, then prepare, or the ropes stay frozen at the bind pose.
    if (this.skeleton) {
      (this.skeleton as unknown as { _isDirty: boolean })._isDirty = true;
      this.skeleton.prepare(true);
    }

  }

  /** Flag + pennant flutter. windDirLocalRad = downwind direction relative to the hull
   *  heading (windToDir − heading). The bones are yawed about WORLD up (not the heeling
   *  parent's up) while keeping their rest tilt, so the flag streams downwind, stays
   *  horizontal, and doesn't wobble with heel. The pennant lags/exaggerates the flag. */
  idleWind(windDirLocalRad: number, strength: number, t: number): void {
    const s = Math.max(0, Math.min(1.5, strength));
    const base = windDirLocalRad + this.FLAG_YAW_OFFSET;
    this.spinBoneAboutWorldY('B_Flag',    base + Math.sin(t * 2.0) * 0.15 * s);
    this.spinBoneAboutWorldY('B_Pennant', base + Math.sin(t * 1.6 - 0.4) * 0.30 * s);

    // Wind is scene-global → drive the shared sail-billow plugin once per frame.
    SailBillowPlugin.wind.strength = s;
    SailBillowPlugin.wind.time = t;
  }

  /** Rotate a bone node about the WORLD vertical by `phi`, composed onto its captured rest
   *  pose. Row-vector convention (world = local · parent), so a world-space yaw applied AFTER
   *  the rest is: R_local = R_rest · R_parent · RotationY(phi) · R_parent⁻¹. Preserves the
   *  bone's authored tilt (flag stays horizontal) and is heel-independent. */
  private spinBoneAboutWorldY(name: string, phi: number): void {
    const n = this.nodes.get(name);
    const restQ = this.restQ.get(name);
    if (!n || !restQ) return;
    const restM = new Matrix();
    restQ.toRotationMatrix(restM);
    const parent = n.parent as TransformNode | null;
    let local: Matrix;
    if (parent) {
      parent.computeWorldMatrix(true);
      const pq = new Quaternion();
      parent.getWorldMatrix().decompose(undefined, pq, undefined);
      const rPw = new Matrix();
      pq.toRotationMatrix(rPw);
      local = restM.multiply(rPw).multiply(Matrix.RotationY(phi)).multiply(Matrix.Invert(rPw));
    } else {
      local = restM.multiply(Matrix.RotationY(phi));
    }
    const q = new Quaternion();
    local.decompose(undefined, q, undefined);
    n.rotationQuaternion = q;
  }

  /** All descendant meshes — for ocean reflection + shadow registration by callers. */
  getMeshes() { return this.root.getChildMeshes(false); }

  dispose(): void {
    for (const g of this.clips.values()) { g.stop(); g.dispose(); }
    this.clips.clear();
    this.morphs.clear();
    this.nodes.clear();
    this.restQ.clear();
    this.sailFurlCur.clear();
    this.sailFurlTarget.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private setMorph(meshNode: string, index: number, value: number): void {
    const mgr = this.morphs.get(meshNode);
    const target = mgr?.getTarget(index);
    if (target) target.influence = value;
  }

  /** Compose a parent-frame axis rotation onto a node's captured rest pose. */
  private composeSpin(nodeName: string, axis: Vector3, angle: number): void {
    const n = this.nodes.get(nodeName);
    const rest = this.restQ.get(nodeName);
    if (!n || !rest) return;
    n.rotationQuaternion = Quaternion.RotationAxis(axis, angle).multiply(rest);
  }
}
