import { AbstractMesh, InstantiatedEntries, Scene, TransformNode } from '@babylonjs/core';
import { RiggedManifest, SailState } from '../models';
import { SloopController } from './rigged-vessel.controller';
import { PinnaceController } from './pinnace-vessel.controller';

export type GunSide = 'S' | 'P';

/**
 * The game-facing contract every vessel's animation driver implements. VesselService (local ship) and
 * MultiplayerService (remotes) drive vessels ONLY through this interface, so rigs can differ wildly under
 * the hood (the sloop scrubs a brace clip + spins a wheel + 6 sails; the pinnace scrubs symmetric
 * rudder/trim clips + 2 morph-furled sails + a Flag bone chain) without the callers caring.
 */
export interface VesselController {
  readonly root: TransformNode;
  /** -1 hard port .. 0 center .. +1 hard starboard. */
  setRudder(t: number): void;
  /** Trim the sails for the current sheet-eased amount + tack. Each rig maps it to its own yards/booms. */
  setSailTrim(sheetAngleDeg: number, isPortTack: boolean): void;
  /** Map the game's 3-state sail model onto this rig. immediate=true snaps (initial spawn pose). */
  applySailState(state: SailState, immediate?: boolean): void;
  setGunDeployTarget(side: GunSide, t: number): void;
  addGunRecoil(side: GunSide, kick?: number): void;
  isGunReady(side: GunSide): boolean;
  gunSettled(side: GunSide): boolean;
  setGunports(side: GunSide, open: number): void;   // no-op on rigs without gunport lids
  /** Mast damage from the `masts` HP zone: 1 = intact .. 0 = destroyed (mast comes down). Eased in
   *  tickRig; no-op on GLBs without a `mast_damage` rig. */
  setMastDamage(health: number): void;
  dropAnchor(side: GunSide, t: number): void;
  idleWind(windDirLocalRad: number, strength: number, t: number): void;
  tickRig(dt: number): void;
  getMeshes(): AbstractMesh[];
  dispose(): void;
}

/** Rig asset descriptor by vessel slug. Used by BOTH the local VesselService (which also has the full
 *  server vessel def) and MultiplayerService (which only knows a remote ship's slug). */
export interface VesselRig {
  glb: string;
  manifest: string;
  importFlipY: boolean;
  rightSign: 1 | -1;
  controller: 'sloop' | 'pinnace';
  /** Extra metres to raise the hull out of the water (a shallow open boat shows the surface otherwise). */
  floatDraft: number;
  /** Resting fore-aft trim bias (radians, + = BOW-UP / stern-down) — models a rearward centre of gravity so a
   *  bow-heavy boat doesn't lean forward under sail and lift its rudder clear of the water. Omit → 0 (level). */
  trimPitch?: number;
  /** Clip the sea out of the hull's INTERIOR (open, low-sitting boats only) so wave crests never show
   *  inside the floor while the sea still laps the outer planking. Uses a baked hull-silhouette mask +
   *  a height-aware cut (see OceanService.setHullCutProfile / bakeHullCutProfile). Omit → no cut.
   *   - floorY:    metres above the vessel root origin of the cockpit floor; sea inside the hull ABOVE
   *                this world height is cut (dry interior), below it is kept (no see-through on troughs).
   *   - alongSign: +1 if the boat's forward heading is +Z in the root frame; flip to -1 if bow/stern read swapped.
   *   - waterlineY: root-local Y of the waterline plane the footprint is SLICED at (the rig origin is authored
   *                 at the waterline, so 0 is right; nudge ± if the cut sits a touch high/low on the hull). */
  hullCut?: { floorY: number; alongSign: 1 | -1; waterlineY?: number };
  /** Per-vessel buoyancy feel (omit → generic sloop response). pitchScale = how far the wave slope tilts it;
   *  heaveTau = vertical-follow time constant (LOWER = rides waves more, sits at an average level less);
   *  tiltTau = pitch/roll time constant (LOWER = snaps onto the slope + drops back faster). See VesselBuoyancyService. */
  buoyancy?: { pitchScale?: number; heaveTau?: number; tiltTau?: number };
  /** Approximate hull half-dimensions (m) for the aground check + wake emitter placement. */
  hullHalfLen: number;
  hullHalfBeam: number;
}

export const VESSEL_RIGS: Record<string, VesselRig> = {
  sloop:   { glb: 'bermuda_sloop_rigged.glb', manifest: 'bermuda_sloop_rigged.manifest.json', importFlipY: true,  rightSign: 1,  controller: 'sloop',   floatDraft: 0,    hullHalfLen: 7.0, hullHalfBeam: 2.2 },
  pinnace: { glb: 'pinnace.glb',              manifest: 'pinnace.manifest.json',              importFlipY: false, rightSign: -1, controller: 'pinnace', floatDraft: -0.25, hullHalfLen: 4.1, hullHalfBeam: 1.1, hullCut: { floorY: 0.15, alongSign: 1 }, trimPitch: 0.05, buoyancy: { pitchScale: 0.13, heaveTau: 0.65, tiltTau: 0.3 } },
};

export function rigForSlug(slug: string | undefined): VesselRig {
  return VESSEL_RIGS[slug ?? ''] ?? VESSEL_RIGS['sloop'];
}

/** Build the right controller for a vessel slug from an instantiated rigged GLB + its manifest. */
export function createVesselController(
  slug: string | undefined, entries: InstantiatedEntries, root: TransformNode, manifest: RiggedManifest, scene: Scene,
): VesselController {
  return rigForSlug(slug).controller === 'pinnace'
    ? new PinnaceController(entries, root, manifest, scene)
    : new SloopController(entries, root, manifest, scene);
}
