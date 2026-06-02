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
}

/** Server → the victim: their authoritative hull state (drives the HUD diagram). */
export interface CombatStateMsg {
  type:  'combat_state';
  zones: ZoneState;
}

/** Server → victim + shooter: a sinking (messages only, for now). */
export interface CombatSunkMsg {
  type: 'combat_sunk';
  victimId:  string;
  shooterId: string;
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
