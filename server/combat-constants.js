'use strict';

/**
 * Canonical combat tuning — the single source of truth for hit zones, hull geometry,
 * damage and shot validation. The CLIENT mirrors the player-facing subset of these
 * numbers in client/src/app/sailing/services/combat.constants.ts; if you change a
 * shared value here (zone names, hit points, severity thresholds) update that file too.
 *
 * Vessel-local frame (from the sloop manifest): +Z = bow, +X = starboard,
 * heading 0deg = North (+Z). World units == metres for geometry; ship TRANSLATION
 * advances at TRAVEL_SCALE x physics speed (map compression), but the hull SIZE and
 * cannonball positions/velocities are in plain world units.
 */

const G            = 9.81;   // cannonball gravity (world units/s^2) — matches client cannon
const TRAVEL_SCALE = 5.0;    // ship world-velocity = speed * TRAVEL_SCALE along heading

// ── Hull zone geometry (oriented box in vessel-local space) ───────────────────
const HALF_LEN  = 9.0;    // fore-aft half-length (|lon| <= HALF_LEN)
const HALF_BEAM = 3.5;    // beam half-width   (|lat| <= HALF_BEAM)
const DECK_Y    = 3.0;    // top of the hull band (waterline 0 .. deck)
const BOW_LON   = 4.5;    // |lon| beyond this (toward the relevant end) = bow / stern
const MAST_LAT  = 1.2;    // centreline half-width for the mast column
const MAST_LON  = 5.0;    // mast column fore-aft half-extent
const MAST_Y_TOP = 22.0;  // top of the mast column

// Zone names. 'masts' is tracked but exempt from the sink rule and has no effect yet.
const ZONES = ['bow', 'stern', 'port', 'starboard', 'masts'];

// Starting hit points per zone, per vessel. Sides are the big broadside targets. The pinnace is
// lightly built — far fewer HP, so it sinks much faster than the sloop. Keep these in sync with the
// vessel defs (server/controllers/vessels.controller.js) and the client mirror (combat.constants.ts).
const ZONE_HP_BY_SLUG = {
  sloop:   { bow: 90, stern: 90, port: 130, starboard: 130, masts: 100 },
  pinnace: { bow: 55, stern: 55, port: 80,  starboard: 80,  masts: 60  },
};
function zoneHpFor(slug) { return ZONE_HP_BY_SLUG[slug] || ZONE_HP_BY_SLUG.sloop; }
// Back-compat default (sloop) for any caller without a slug.
const ZONE_HP = ZONE_HP_BY_SLUG.sloop;

// Outward face normal of each hull zone in vessel-local (lat = +X/starboard, lon = +Z/bow).
const ZONE_NORMAL = {
  bow:       { lat: 0,  lon: 1 },
  stern:     { lat: 0,  lon: -1 },
  port:      { lat: -1, lon: 0 },
  starboard: { lat: 1,  lon: 0 },
  masts:     { lat: 0,  lon: 0 },
};

// ── Damage model ──────────────────────────────────────────────────────────────
// dmg = DMG_K * relSpeed * perp^DMG_PERP_EXP
//   relSpeed = |ballVel - victimVel|  (world units/s) — head-on/closing hits hit harder
//   perp     = |dot(horizontal ballDir, zone outward normal)|  (1 square-on .. 0 glancing)
// Calibrated so a square-on ~55 u/s hit on a stationary ship ~= 28 dmg.
const DMG_K        = 0.5;
const DMG_PERP_EXP = 1.3;

// Waterline bonus: a shot striking at/near the waterline holes the ship below the
// floodline and hurts far more. Hull y runs 0 (waterline) .. DECK_Y (deck). A hit at or
// below y=0 gets the full bonus; it fades to nothing by WATERLINE_BAND above the water.
//   dmg *= 1 + WATERLINE_BONUS_MAX * clamp((WATERLINE_BAND - hitY) / WATERLINE_BAND, 0, 1)
const WATERLINE_BONUS_MAX = 0.6;   // up to +60% for a clean waterline hole
const WATERLINE_BAND      = 1.6;   // metres above the waterline over which the bonus fades

// ── Severity bands (fraction of a zone's max HP) for the HUD diagram ───────────
//   frac == 1            -> none (unlit)
//   GREEN_MIN <= f < 1   -> green
//   YELLOW_MIN <= f < .  -> yellow
//   0 < f < YELLOW_MIN   -> red
//   f == 0               -> destroyed (sink if non-mast)
const SEV_GREEN_MIN  = 0.60;
const SEV_YELLOW_MIN = 0.30;

// ── Mast self-repair ──────────────────────────────────────────────────────────
// When the masts zone is shot to 0, a jury-rig repair starts automatically and, after this long,
// brings the mast back to a fraction of full (a partial fix — full repair still needs a port). The
// base duration; crew/morale modifiers will scale it later.
const MAST_REPAIR_MS   = 45000;   // 45 s base time to jury-rig the mast back up
const MAST_REPAIR_FRAC = 0.5;     // restore to 50 % of max masts HP

// ── Ballistic simulation ──────────────────────────────────────────────────────
const SIM_DT        = 0.02;   // integration step (s)
const SIM_MAX_T     = 6.0;    // give up after this long in flight
const SIM_WATER_Y   = 0.5;    // ball below this with no hull hit = miss into the sea
const BROADPHASE_PAD = 4.0;   // extra metres around the hull for the cheap proximity reject

// ── Shot validation (anti-exploit) ────────────────────────────────────────────
const VALID_ORIGIN_RADIUS = 16.0;   // muzzle must be within this of the shooter's known pos
const VALID_V_MIN = 45.0;           // |muzzle velocity| plausible band (fixed cannon ~= 55)
const VALID_V_MAX = 66.0;
const RATE_WINDOW_MS   = 7000;      // sliding window for the fire-rate cap
const RATE_MAX_SHOTS   = 7;         // <= 2 full 3-ball broadsides + slack per window
const RATE_MIN_GAP_MS  = 90;        // minimum spacing between any two shots

module.exports = {
  G, TRAVEL_SCALE,
  HALF_LEN, HALF_BEAM, DECK_Y, BOW_LON, MAST_LAT, MAST_LON, MAST_Y_TOP,
  ZONES, ZONE_HP, ZONE_HP_BY_SLUG, zoneHpFor, ZONE_NORMAL,
  DMG_K, DMG_PERP_EXP, WATERLINE_BONUS_MAX, WATERLINE_BAND,
  SEV_GREEN_MIN, SEV_YELLOW_MIN,
  MAST_REPAIR_MS, MAST_REPAIR_FRAC,
  SIM_DT, SIM_MAX_T, SIM_WATER_Y, BROADPHASE_PAD,
  VALID_ORIGIN_RADIUS, VALID_V_MIN, VALID_V_MAX,
  RATE_WINDOW_MS, RATE_MAX_SHOTS, RATE_MIN_GAP_MS,
};
