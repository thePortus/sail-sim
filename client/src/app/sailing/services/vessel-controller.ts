import { AbstractMesh, Color3, InstantiatedEntries, PBRMaterial, Scene, Texture, TransformNode } from '@babylonjs/core';
import { RiggedManifest, SailState } from '../models';
import { SloopController } from './rigged-vessel.controller';
import { PinnaceController } from './pinnace-vessel.controller';
import { BrigController } from './brig-vessel.controller';
import { MerchantmanController } from './merchantman-vessel.controller';
import { FrigateController } from './frigate-vessel.controller';

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
  /** Choose a visible loadout variant (e.g. the frigate's armament: 'heavy'|'medium'|'light'). Optional —
   *  only rigs that ship multiple toggleable variant meshes implement it. */
  setArmament?(variant: string): void;
  /** Mast damage from the `masts` HP zone: 1 = intact .. 0 = destroyed (mast comes down). Eased in
   *  tickRig; no-op on GLBs without a `mast_damage` rig. */
  setMastDamage(health: number): void;
  dropAnchor(side: GunSide, t: number): void;
  idleWind(windDirLocalRad: number, strength: number, t: number): void;
  tickRig(dt: number): void;
  getMeshes(): AbstractMesh[];
  dispose(): void;
}

/**
 * Per-rig sailing character for the v2 force model (localStorage.ignis_physics='v2'). Gives each vessel a
 * DISTINCT polar so boats feel different to sail; the legacy model ignores this. Mirror any change into the
 * server NPC sim (server/npc.js) when P6 lands — see sailing-physics-roadmap.
 */
export interface SailRig {
  /** Drive-coefficient polar: [apparentWindAngle°, coeff] breakpoints from the no-go angle out to 180°,
   *  linearly interpolated. Below the no-go angle the model ramps to a backwinded (negative) drive. */
  polar: ReadonlyArray<readonly [number, number]>;
  /** Drive-scale override (else the global SAIL_FORCE_K). A smaller/less-efficient sail plan → lower. */
  forceK?: number;
  /** Trim-tolerance multiplier (>1 = more forgiving; a simple workboat rig is less fussy than a tuned sloop). */
  trimForgive?: number;
  /** Leeway (sideways slip) multiplier (>1 = slips more; a shallow keel-less hull makes more leeway). */
  leewayK?: number;
}

/** Rig asset descriptor by vessel slug. Used by BOTH the local VesselService (which also has the full
 *  server vessel def) and MultiplayerService (which only knows a remote ship's slug). */
export interface VesselRig {
  glb: string;
  manifest: string;
  importFlipY: boolean;
  rightSign: 1 | -1;
  controller: 'sloop' | 'pinnace' | 'brig' | 'merchantman' | 'frigate';
  /** Loadout variant for a multi-variant hull (the frigate's armament: 'heavy'|'medium'|'light'). Applied to
   *  the controller via setArmament so it shows the right gun mesh. Omit → the controller's default. */
  armament?: string;
  /** Base yaw (deg, about world up) applied at import for models whose authored bow isn't +Z (the
   *  merchantman exports bow=+X, so −90 turns it to +Z). Omit → 0. */
  baseYawDeg?: number;
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
  /** Per-vessel buoyancy feel. pitchScale = how far the wave slope tilts it; heaveTau = vertical-follow time
   *  constant (LOWER = rides waves more); tiltTau = pitch/roll time constant. See VesselBuoyancyService. */
  buoyancy?: { pitchScale?: number; heaveTau?: number; tiltTau?: number };
  /** Approximate hull half-dimensions (m) for the aground check + wake emitter placement. */
  hullHalfLen: number;
  hullHalfBeam: number;
  /** Mask the FFT ocean out of the hull silhouette (open-cockpit boats need it so the sea doesn't show
   *  through the open deck). DECKED, deep-draft hulls should set FALSE — the stencil reveals their large
   *  underwater hull (you see the keel through the water) and cuts foreground waves. Default true. */
  oceanMask?: boolean;
  /** Hull-LOCAL Y below which the stencil proxy geometry is clamped away, so it masks ONLY the open deck
   *  above this — never the waterline/underwater hull (which otherwise shows the keel through the sea). Set
   *  to ~the weather-deck height (keel at local 0). Omit → mask the whole hull (fine for shallow open boats). */
  oceanMaskFloorY?: number;
  /** Hull-LOCAL |X| the stencil proxy is clamped to (removes the tumblehome bulge that pokes past the rail).
   *  A hull is widest at the WATERLINE; on a tumblehome hull (e.g. the frigate: waterline beam ~7 vs rail ~5.6)
   *  the proxy silhouette is that wide waterline beam, so the ocean gets cut ~1.4m outboard of the rail and the
   *  seabed shows in the gap. Clamp |X| to ~the rail half-beam so the cut hugs the deck. Omit → no beam clamp. */
  oceanMaskBeamX?: number;
  /** v2 sailing polar (omit → falls back to the legacy step curve). */
  sail?: SailRig;
}

// Both vessels are FORE-AND-AFT rigged but with distinct character (see sailing-physics-roadmap):
//  • Sloop — Bermuda rig: points high (no-go 32°), strong on a reach, peak drive ~120°, but the main
//    blankets the jib dead downwind so the run falls off. A tuned rig → fussier trim.
//  • Pinnace — handy sprit/lug: points a touch lower (no-go 34°), lower peak, but a simple low sail holds
//    its drive much better dead downwind, and the workboat rig is more forgiving of sloppy trim.
const SLOOP_SAIL: SailRig = {
  polar: [[32, 0.46], [45, 0.64], [60, 0.80], [90, 0.93], [120, 1.00], [150, 0.82], [180, 0.66]],
  trimForgive: 1.0, leewayK: 1.0,
};
const PINNACE_SAIL: SailRig = {
  polar: [[34, 0.42], [55, 0.62], [80, 0.82], [100, 0.92], [125, 0.97], [150, 0.90], [180, 0.80]],
  trimForgive: 1.25, leewayK: 1.4,
};
//  • Brig — square-rigged foremast + gaff main: points LOW (no-go 50°; square sails can't sail close), but
//    a big spread of canvas gives strong drive on a reach and HOLDS it dead downwind (square sails love a
//    run, peak ~120°). Heavy deep hull → little leeway; the square rig is fairly forgiving of sloppy trim.
const BRIG_SAIL: SailRig = {
  polar: [[50, 0.40], [70, 0.62], [90, 0.82], [120, 1.00], [150, 0.95], [180, 0.86]],
  forceK: 1.12, trimForgive: 1.1, leewayK: 0.9,
};
//  • Merchantman — three-masted square-rigger (fore + main square, mizzen spanker): a big spread of canvas
//    on a heavy, deep merchant hull. Points even lower than the brig (no-go 52°), but huge drive on a reach
//    and HOLDS it dead downwind. Slow to accelerate, little leeway, and forgiving of sloppy trim.
const MERCHANTMAN_SAIL: SailRig = {
  polar: [[52, 0.38], [72, 0.60], [92, 0.80], [120, 1.00], [150, 0.96], [180, 0.88]],
  forceK: 1.18, trimForgive: 1.15, leewayK: 0.85,
};
//  • Frigate — heavy three-masted square-rigger (Constitution type). A huge, efficient sail plan on a fine,
//    fast man-of-war hull: points a touch better than the merchantman (no-go 48°), the biggest peak drive on a
//    reach, and holds it downwind; deep keel → little leeway, and a well-drilled rig is fairly forgiving.
const FRIGATE_SAIL: SailRig = {
  polar: [[48, 0.42], [68, 0.64], [90, 0.84], [120, 1.00], [150, 0.95], [180, 0.86]],
  forceK: 1.22, trimForgive: 1.1, leewayK: 0.8,
};

export const VESSEL_RIGS: Record<string, VesselRig> = {
  sloop:   { glb: 'bermuda_sloop_rigged.glb', manifest: 'bermuda_sloop_rigged.manifest.json', importFlipY: true,  rightSign: 1,  controller: 'sloop',   floatDraft: 0,    hullHalfLen: 7.0, hullHalfBeam: 2.2, sail: SLOOP_SAIL },
  pinnace: { glb: 'pinnace.glb',              manifest: 'pinnace.manifest.json',              importFlipY: false, rightSign: -1, controller: 'pinnace', floatDraft: -0.5,  hullHalfLen: 4.1, hullHalfBeam: 1.1, hullCut: { floorY: 0.15, alongSign: 1 }, trimPitch: 0.05, buoyancy: { pitchScale: 0.16, heaveTau: 0.45, tiltTau: 0.30 }, sail: PINNACE_SAIL },
  // Brigantine — a big, decked two-master. Sits at normal draft (no hull cut). A heavy hull rides the swell
  // ponderously (low pitchScale, longer time constants) rather than bobbing like the open boats.
  // floatDraft −2.0 (was −2.3): +0.3m FREEBOARD so the low waist deck (deck-local ~3.6 → world ~1.6) clears the
  // wave crests that were occasionally washing it. waterlineY tracks −floatDraft (=2.0) so the cut footprint
  // sits at the real waterline. floorY −0.3 keeps the interior sink deep (root.y −2.0 + −0.3 − 0.38 ≈ −2.7, at
  // the hull bottom) so no water reads through the gratings.
  brig:    { glb: 'brig.glb',                  manifest: 'brig.manifest.json',                 importFlipY: false, rightSign: 1,  controller: 'brig',    floatDraft: -2.0,  hullHalfLen: 12.0, hullHalfBeam: 3.2, oceanMask: false, hullCut: { floorY: -0.3, alongSign: 1, waterlineY: 2.0 }, buoyancy: { pitchScale: 0.07, heaveTau: 1.0, tiltTau: 0.6 }, sail: BRIG_SAIL },
  // Merchantman / hagboat — the biggest, heaviest hull. Authored bow=+X; baseYawDeg=90 turns it to the
  // fleet's bow=+Z (live-confirmed: 45° got halfway, 90° lands it). Override via localStorage.ignis_yaw_merchantman.
  // Model origin is at the KEEL (bboxMin Y=0), so floatDraft sinks it ~2.7m to float the waterline. A very heavy
  // hull rides the swell ponderously. floatDraft / hullCut.waterlineY / buoyancy are STARTING values — tune live.
  merchantman: { glb: 'merchantman.glb', manifest: 'merchantman.manifest.json', importFlipY: false, rightSign: 1, controller: 'merchantman', baseYawDeg: 90, floatDraft: -3.8, hullHalfLen: 15.0, hullHalfBeam: 3.6, oceanMaskFloorY: 6.5, hullCut: { floorY: 0.2, alongSign: 1, waterlineY: 3.8 }, buoyancy: { pitchScale: 0.06, heaveTau: 1.1, tiltTau: 0.65 }, sail: MERCHANTMAN_SAIL },
  // Frigate (USS Constitution type) — the largest, deepest hull. Authored bow=-Y (brig convention) → exports
  // bow=+Z, so NO baseYaw. Model origin is at the LWL (waterline Z0; keel at -6.4m), so floatDraft ~0 floats it
  // right. floatDraft / hullCut.waterlineY / buoyancy are STARTING values — tune live (ignis_draft_frigate etc).
  // A very heavy man-of-war rides the swell ponderously (low pitchScale, long time constants).
  // oceanMaskFloorY drops to the waterline (frigate has no modeled underwater body, just a keel fin) so the stencil
  // proxy's flattened disk sits at sea level instead of floating up at the rail; oceanMaskBeamX clamps the proxy beam
  // in to the rail so the wide tumblehome waterline outline (beam ~7) stops cutting the ocean ~1.4m past the rail
  // (~5.6) and revealing the seabed. See buildHullStencilProxy. Tune live: localStorage ignis_maskfloor_frigate.
  frigate: { glb: 'frigate.glb', manifest: 'frigate.manifest.json', importFlipY: false, rightSign: 1, controller: 'frigate', floatDraft: 0, hullHalfLen: 24.0, hullHalfBeam: 5.5, oceanMaskFloorY: 0.5, oceanMaskBeamX: 5.7, hullCut: { floorY: 0.2, alongSign: 1, waterlineY: 0 }, buoyancy: { pitchScale: 0.05, heaveTau: 1.2, tiltTau: 0.7 }, sail: FRIGATE_SAIL },
};

export function rigForSlug(slug: string | undefined): VesselRig {
  if (slug && VESSEL_RIGS[slug]) return VESSEL_RIGS[slug];
  // Frigate armament variants (frigate_heavy/medium/light) all share the one 'frigate' rig/asset; the suffix
  // just selects the visible gun mesh (armament) — no separate rig entry needed.
  if (slug && slug.startsWith('frigate')) {
    return { ...VESSEL_RIGS['frigate'], armament: slug.split('_')[1] || 'heavy' };
  }
  return VESSEL_RIGS['sloop'];
}

/** Base import yaw (deg) for a slug, with a live `localStorage.ignis_yaw_<slug>` override so a mis-oriented
 *  hull can be re-aimed without a rebuild (e.g. ignis_yaw_merchantman='90'). Falls back to the rig's
 *  baseYawDeg. Crew/meshes share the yawed root, so they follow whatever this returns. */
export function baseYawDegFor(slug: string | undefined, rig: VesselRig): number {
  if (typeof localStorage !== 'undefined' && slug) {
    const o = localStorage.getItem('ignis_yaw_' + slug);
    if (o !== null && o.trim() !== '' && !isNaN(parseFloat(o))) return parseFloat(o);
  }
  return rig.baseYawDeg ?? 0;
}

/** Hull-local Y below which the ocean-mask stencil proxy is clamped (mask only the deck above it), with a
 *  live `localStorage.ignis_maskfloor_<slug>` override. Returns undefined → mask the whole hull. */
export function maskFloorFor(slug: string | undefined, rig: VesselRig): number | undefined {
  if (typeof localStorage !== 'undefined' && slug) {
    const o = localStorage.getItem('ignis_maskfloor_' + slug);
    if (o !== null && o.trim() !== '' && !isNaN(parseFloat(o))) return parseFloat(o);
  }
  return rig.oceanMaskFloorY;
}

/** How deep a hull floats (metres, more negative = deeper), with a live `localStorage.ignis_draft_<slug>`
 *  override so the waterline can be dialled in without a rebuild (e.g. ignis_draft_merchantman='-4.0'). */
export function floatDraftFor(slug: string | undefined, rig: VesselRig): number {
  if (typeof localStorage !== 'undefined' && slug) {
    const o = localStorage.getItem('ignis_draft_' + slug);
    if (o !== null && o.trim() !== '' && !isNaN(parseFloat(o))) return parseFloat(o);
  }
  return rig.floatDraft;
}

/** Build the right controller for a vessel slug from an instantiated rigged GLB + its manifest. */
export function createVesselController(
  slug: string | undefined, entries: InstantiatedEntries, root: TransformNode, manifest: RiggedManifest, scene: Scene,
): VesselController {
  const kind = rigForSlug(slug).controller;
  if (kind === 'pinnace')     return new PinnaceController(entries, root, manifest, scene);
  if (kind === 'brig')        return new BrigController(entries, root, manifest, scene);
  if (kind === 'merchantman') return new MerchantmanController(entries, root, manifest, scene);
  if (kind === 'frigate') {
    const c = new FrigateController(entries, root, manifest, scene);
    const arm = rigForSlug(slug).armament;   // heavy/medium/light from the vessel slug
    if (arm) c.setArmament(arm);
    return c;
  }
  return new SloopController(entries, root, manifest, scene);
}

/**
 * Give a freshly-loaded ship's METAL materials something to reflect. The brig (and any GLB whose metals are
 * factor-only — `SHIP_IRON`/`SHIP_BRASS` with metallic=1 and no baked albedo/ORM) reflect the scene environment
 * for their colour; but sail-sim runs NO scene-wide `environmentTexture` (it makes harbor metals + water read
 * black — see SceneService.getSkyEnvTexture), so without a per-material reflection those metals render as a flat
 * BLACK void (the user's "cannons are all black"). Hand each metal material the procedural-sky LUT as a scoped
 * reflection — same trick as harbor.service.applyEnvReflection — so it catches sky radiance, reads as dark iron
 * (not a silhouette), and tracks time of day for free. No-op on the WebGL fallback (no LUT) and on non-metals.
 * Idempotent (skips a material that already has a reflection), and materials are shared across instances so the
 * fix lands once per unique material.
 */
export function applyShipMetalEnv(meshes: AbstractMesh[], env: Texture | null): void {
  for (const mesh of meshes) {
    const mat = mesh.material;
    if (!(mat instanceof PBRMaterial)) continue;
    if (!/iron|brass|bronze|steel|metal/i.test(mat.name)) continue;
    // ROOT CAUSE: these are factor-only metals (metallic=1, no baked albedo/ORM). A pure metal has NO diffuse
    // response, so with no scene environmentTexture it renders BLACK under any light — the sun can't light it.
    // Reflection alone doesn't save it (and the LUT may not be built yet at ship-load → was null → stayed black).
    // FIX, env-independent: drop metalness so the sun lights it as dark iron, and floor a near-black albedo to
    // gunmetal so a cannon barrel reads with form, not as a black cutout.
    const a = mat.albedoColor;
    const nearBlack = !a || (a.r < 0.12 && a.g < 0.12 && a.b < 0.12);
    if (/iron|steel/i.test(mat.name) || nearBlack) {
      mat.metallic  = 0.45;                                  // enough diffuse for the sun to render dark iron
      mat.roughness = Math.max(mat.roughness ?? 0.5, 0.5);
      if (nearBlack) mat.albedoColor = new Color3(0.30, 0.30, 0.33);   // lighter gunmetal (was 0.14 — read too dark)
    } else {
      mat.metallic = Math.min(mat.metallic ?? 1, 0.6);       // brass/bronze: keep a goldish sheen, allow diffuse
    }
    // Bonus when the sky LUT is ready: a scoped reflection adds highlights and tracks time of day (same trick as
    // harbor.service.applyEnvReflection). Skipped silently if the sky isn't built yet — the metal is already lit.
    if (env && !mat.reflectionTexture) { mat.reflectionTexture = env; mat.environmentIntensity = 0.6; }
  }
}
