/**
 * Player-facing combat constants — MIRROR of server/combat-constants.js.
 * The server is authoritative for geometry/damage; the client only needs the zone
 * list, per-zone max HP (to turn the authoritative HP into a fraction) and the
 * severity thresholds for the HUD damage diagram. Keep these in sync with the server.
 */

export type Zone = 'bow' | 'stern' | 'port' | 'starboard' | 'masts';

/** Diagram-friendly order. */
export const ZONES: Zone[] = ['bow', 'port', 'starboard', 'stern', 'masts'];

/** Starting / max hit points per zone, per vessel (must match server ZONE_HP_BY_SLUG). The pinnace
 *  is lightly built — far fewer HP, so it sinks faster. */
export const ZONE_HP_BY_SLUG: Record<string, Record<Zone, number>> = {
  sloop:   { bow: 90,  stern: 90,  port: 130, starboard: 130, masts: 100 },
  pinnace: { bow: 55,  stern: 55,  port: 80,  starboard: 80,  masts: 60  },
  // Brigantine — a big, heavily-built warship: the toughest hull, and two masts to shoot away.
  brig:    { bow: 140, stern: 140, port: 200, starboard: 200, masts: 150 },
  // Merchantman / hagboat — the largest, most heavily-timbered hull (tankiest), but lightly gunned: a fat
  // trader that soaks punishment. Three masts collapse off the one masts zone.
  merchantman: { bow: 150, stern: 150, port: 220, starboard: 220, masts: 160 },
};

/** Per-zone max HP for a vessel slug (defaults to the sloop). */
export function zoneHpFor(slug: string | undefined): Record<Zone, number> {
  return ZONE_HP_BY_SLUG[slug ?? ''] ?? ZONE_HP_BY_SLUG['sloop'];
}

/** Default (sloop) per-zone max HP — used when a caller has no per-vessel table. */
export const ZONE_HP: Record<Zone, number> = ZONE_HP_BY_SLUG['sloop'];

export const SEV_GREEN_MIN  = 0.60;
export const SEV_YELLOW_MIN = 0.30;

/** Authoritative per-zone HP, as sent by the server `combat_state` message. */
export type ZoneState = Record<Zone, number>;

/** Server → all clients: an adjudicated hit (drives cosmetics + shudder). */
export interface CombatHitMsg {
  type: 'combat_hit';
  shooterId: string;
  victimId:  string;
  seq:       number;          // matches the firing client's shot seq
  zone:      Zone;
  hx: number; hy: number; hz: number;   // world impact point
  side: 'port' | 'stbd';                // struck side (for the shudder)
  tof?: number;                         // server time-of-flight (s) — defer the hit FX to ball arrival
  grape?: boolean;                      // grapeshot pellet (anti-crew) — no hull damage, no scorch, light shudder
}

/** Server → ALL clients: a ship's authoritative hull state. Drives the victim's HUD
 *  diagram and every client's damage-listing tilt for that ship. */
export interface CombatStateMsg {
  type:     'combat_state';
  playerId: string;          // whose hull this is (own id → also feeds the HUD)
  zones:    ZoneState;
  maxHp?:   ZoneState;       // per-vessel full-HP (sizes the HUD severity bands); omitted = sloop default
}

/** Server → victim + shooter: a sinking (messages only, for now). */
export interface CombatSunkMsg {
  type: 'combat_sunk';
  victimId:  string;
  shooterId: string;
}

// ── Damage listing (visual hull tilt from battle damage) ──────────────────────
// A flooded side/end drags the ship down: damaged port/starboard rolls her toward the
// holed beam; a damaged bow/stern settles her by the head/stern. Tuned to read clearly
// over the wave roll — pronounced, but still short of capsizing. Both offsets are added
// on top of the wave/heel/recoil rotation.
export const LIST_ROLL_MAX  = 0.32;   // rad (~18°) at total loss of one beam
export const LIST_PITCH_MAX = 0.24;   // rad (~14°) at total loss of bow or stern
// Response curve: <1 makes partial damage list much more (a half-holed side already
// leans hard) instead of only showing near total destruction.
export const LIST_CURVE     = 0.55;

/**
 * Listing offsets (radians) from a hull state, matching the float conventions:
 * roll `+` = starboard-down, pitch `+` = bow-up.
 * Returns {0,0} for a pristine / unknown hull.
 */
export function listingFor(
  z: ZoneState | null | undefined, maxHp: Record<Zone, number> = ZONE_HP,
): { roll: number; pitch: number } {
  if (!z) return { roll: 0, pitch: 0 };
  const dmg = (zone: Zone) => {
    const frac = 1 - Math.max(0, Math.min(1, (z[zone] ?? maxHp[zone]) / maxHp[zone]));
    return Math.pow(frac, LIST_CURVE);   // partial damage lists sooner
  };
  return {
    roll:  LIST_ROLL_MAX  * (dmg('port')  - dmg('starboard')),  // lean toward the holed beam
    pitch: LIST_PITCH_MAX * (dmg('bow')   - dmg('stern')),      // settle by the damaged end
  };
}

// ── Sink / capsize animation (dramatic wreck when a ship is sunk) ─────────────
// When a hull is sunk we drive a shared 0→1 progress that (a) drops the whole hull DRAFT and (b)
// amplifies the damage listing into a real capsize — far past the gentle in-combat LIST_* tilt. The
// pose is held (boat awash, listing hard) until the player repairs, then eased back out.
export const SINK_DUR        = 3.2;          // seconds to reach the fully-wrecked pose
export const SINK_DEPTH      = 3.2;          // metres the hull settles into the water at full sink
export const CAPSIZE_ROLL_MAX  = 0.96;       // rad (~55°) heel toward the holed beam at full sink
export const CAPSIZE_PITCH_MAX = 0.49;       // rad (~28°) plunge by the damaged end at full sink
export const SINK_REVEAL_MS  = SINK_DUR * 1000 + 700;   // delay before the local "you were sunk" card

/** Eased sink progress in [0,1] from seconds elapsed since the sinking began (smoothstep → settles). */
export function sinkProgress(elapsedSec: number): number {
  const t = Math.max(0, Math.min(1, elapsedSec / SINK_DUR));
  return t * t * (3 - 2 * t);
}

/**
 * Dramatic capsize tilt (radians) for a sunk hull — same direction conventions as listingFor (roll + =
 * stbd-down toward the holed beam; pitch + = bow-up), scaled to the capsize maxima. If the damage is too
 * symmetric to pick a side, force a default heel so she always rolls over rather than settling flat.
 */
export function capsizeFor(
  z: ZoneState | null | undefined, maxHp: Record<Zone, number> = ZONE_HP,
): { roll: number; pitch: number } {
  const dmg = (zone: Zone) =>
    1 - Math.max(0, Math.min(1, (z?.[zone] ?? maxHp[zone]) / maxHp[zone]));   // 0..1, raw (no curve)
  let rollN  = z ? dmg('port') - dmg('starboard') : 0;   // matches listingFor's sign
  const pitchN = z ? dmg('bow') - dmg('stern')      : 0;
  // Always tip: if neither beam nor end dominates, lean to one side (sign-preserving) so she capsizes.
  if (Math.abs(rollN) < 0.15 && Math.abs(pitchN) < 0.35) { rollN = (rollN >= 0 ? 1 : -1) * 0.6; }
  const clampU = (v: number) => Math.max(-1, Math.min(1, v));
  return { roll: CAPSIZE_ROLL_MAX * clampU(rollN), pitch: CAPSIZE_PITCH_MAX * clampU(pitchN) };
}

// ── Mast damage (dismasting): visual collapse + sailing penalty from the `masts` zone ──
// All derived from the authoritative masts-zone HP, so local + remote + the controller stay in
// lockstep. Onset is the HUD green→yellow boundary: above it the mast is fine; below it she leans,
// cracks, and slows; at 0 HP the mast comes down and the ship acts as if her sails were furled.
export const MAST_DAMAGE_ONSET  = SEV_GREEN_MIN;   // 0.60 — damage shows / penalty begins below this health
export const MAST_SLOW_FLOOR    = 0.30;            // worst partial sail-power multiplier (just above destroyed) —
                                                   // a shot-up rig really bleeds speed (was 0.70); 0 at destroyed
export const MAST_DOWN_TURN_MAX = 6;               // deg/s helm cap once the mast is down (pivots slowly only)

/** Mast health fraction (1 = intact .. 0 = destroyed) from a hull state. Unknown hull → 1. */
export function mastHealth(z: ZoneState | null | undefined, maxHp: Record<Zone, number> = ZONE_HP): number {
  if (!z) return 1;
  return Math.max(0, Math.min(1, (z.masts ?? maxHp.masts) / maxHp.masts));
}

/** MastDown scrub (0 = upright .. 1 = fully collapsed). Below the onset the mast leans VISIBLY and
 *  progressively (front-loaded so even moderate damage shows), topping out at ~0.55 just above destroyed;
 *  the clip's 0.55..1 range is the final topple, reserved for 0 HP — she only fully comes down when the
 *  mast is totally shot through. */
export function mastDownAmount(health: number): number {
  if (health <= 0)               return 1;   // destroyed → full collapse
  if (health >= MAST_DAMAGE_ONSET) return 0; // intact
  const t = (MAST_DAMAGE_ONSET - health) / MAST_DAMAGE_ONSET;   // 0 at onset .. 1 approaching destroyed
  return Math.sqrt(t) * 0.55;                                   // sqrt front-loads the lean so it reads early
}

/** Splinter/break morph influence (0..1) — cracks grow linearly across the whole damage band (onset → 0),
 *  so a moderately-damaged mast already shows splintering, not just a clean lean. */
export function mastBreakAmount(health: number): number {
  if (health >= MAST_DAMAGE_ONSET) return 0;
  return (MAST_DAMAGE_ONSET - Math.max(0, health)) / MAST_DAMAGE_ONSET;
}

/** Sail-power multiplier from mast health: 1 above onset, easing to MAST_SLOW_FLOOR just above
 *  destroyed, 0 when fully destroyed (no drive → coasts to a stop, like furled sails). */
export function mastSpeedMult(health: number): number {
  if (health <= 0)               return 0;
  if (health >= MAST_DAMAGE_ONSET) return 1;
  return MAST_SLOW_FLOOR + (1 - MAST_SLOW_FLOOR) * (health / MAST_DAMAGE_ONSET);
}

export type Severity = 'none' | 'green' | 'yellow' | 'red' | 'destroyed';

/** Map a zone's current HP to a severity band for the HUD (against the vessel's per-zone max). */
export function severityFor(zone: Zone, hp: number, maxHp: Record<Zone, number> = ZONE_HP): Severity {
  const frac = Math.max(0, Math.min(1, hp / maxHp[zone]));
  if (frac >= 1)              return 'none';
  if (frac <= 0)              return 'destroyed';
  if (frac >= SEV_GREEN_MIN)  return 'green';
  if (frac >= SEV_YELLOW_MIN) return 'yellow';
  return 'red';
}
