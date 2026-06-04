/**
 * Player-facing combat constants — MIRROR of server/combat-constants.js.
 * The server is authoritative for geometry/damage; the client only needs the zone
 * list, per-zone max HP (to turn the authoritative HP into a fraction) and the
 * severity thresholds for the HUD damage diagram. Keep these in sync with the server.
 */

export type Zone = 'bow' | 'stern' | 'port' | 'starboard' | 'masts';

/** Diagram-friendly order. */
export const ZONES: Zone[] = ['bow', 'port', 'starboard', 'stern', 'masts'];

/** Starting / max hit points per zone (must match server ZONE_HP). */
export const ZONE_HP: Record<Zone, number> = {
  bow: 90, stern: 90, port: 130, starboard: 130, masts: 100,
};

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
}

/** Server → ALL clients: a ship's authoritative hull state. Drives the victim's HUD
 *  diagram and every client's damage-listing tilt for that ship. */
export interface CombatStateMsg {
  type:     'combat_state';
  playerId: string;          // whose hull this is (own id → also feeds the HUD)
  zones:    ZoneState;
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
export function listingFor(z: ZoneState | null | undefined): { roll: number; pitch: number } {
  if (!z) return { roll: 0, pitch: 0 };
  const dmg = (zone: Zone) => {
    const frac = 1 - Math.max(0, Math.min(1, (z[zone] ?? ZONE_HP[zone]) / ZONE_HP[zone]));
    return Math.pow(frac, LIST_CURVE);   // partial damage lists sooner
  };
  return {
    roll:  LIST_ROLL_MAX  * (dmg('port')  - dmg('starboard')),  // lean toward the holed beam
    pitch: LIST_PITCH_MAX * (dmg('bow')   - dmg('stern')),      // settle by the damaged end
  };
}

export type Severity = 'none' | 'green' | 'yellow' | 'red' | 'destroyed';

/** Map a zone's current HP to a severity band for the HUD. */
export function severityFor(zone: Zone, hp: number): Severity {
  const frac = Math.max(0, Math.min(1, hp / ZONE_HP[zone]));
  if (frac >= 1)              return 'none';
  if (frac <= 0)              return 'destroyed';
  if (frac >= SEV_GREEN_MIN)  return 'green';
  if (frac >= SEV_YELLOW_MIN) return 'yellow';
  return 'red';
}
