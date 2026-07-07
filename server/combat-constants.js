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
const TRAVEL_SCALE = 3.0;    // ship world-velocity = speed * TRAVEL_SCALE along heading

// ── Hull zone geometry (oriented box in vessel-local space) ───────────────────
// Legacy generic box (sloop/brig-sized) — kept as the fallback default. Per-ship boxes below hug each hull's
// real size so hits register on the visible timbers, not in the airspace around a one-size-fits-all box.
const HALF_LEN  = 9.0;    // fore-aft half-length (|lon| <= HALF_LEN)
const HALF_BEAM = 3.5;    // beam half-width   (|lat| <= HALF_BEAM)
const DECK_Y    = 3.0;    // top of the hull band (waterline 0 .. deck)
const BOW_LON   = 4.5;    // |lon| beyond this (toward the relevant end) = bow / stern
const MAST_LAT  = 1.2;    // centreline half-width for the mast column
const MAST_LON  = 5.0;    // mast column fore-aft half-extent
const MAST_Y_TOP = 22.0;  // top of the mast column

// Per-ship hull box, sized to each vessel's rendered hull (client shipScale ≈ 2·hullHalfLen). The mast column
// top is pulled down to roughly the real masthead per hull (was a flat 22 m for everyone — a tall pillar of
// empty air above the small ships), and its width kept tight so a 'masts' hit means the ball actually crossed
// the rig, not open sky beside it. halfBeam/deckY/bowLon scale with the hull too.
const HULL_DIMS_BY_SLUG = {
  //             halfLen halfBeam deckY  bowLon mastLat mastLon mastYTop
  pinnace:     { halfLen: 5.0,  halfBeam: 2.2, deckY: 2.4, bowLon: 2.8, mastLat: 1.0, mastLon: 3.0, mastYTop: 12.0 },
  sloop:       { halfLen: 8.0,  halfBeam: 3.0, deckY: 2.8, bowLon: 4.0, mastLat: 1.1, mastLon: 4.0, mastYTop: 16.0 },
  brig:        { halfLen: 13.0, halfBeam: 3.8, deckY: 3.2, bowLon: 6.5, mastLat: 1.3, mastLon: 6.0, mastYTop: 21.0 },
  merchantman: { halfLen: 16.0, halfBeam: 4.2, deckY: 3.4, bowLon: 8.0, mastLat: 1.3, mastLon: 7.0, mastYTop: 23.0 },
};
const HULL_DIMS_DEFAULT = { halfLen: HALF_LEN, halfBeam: HALF_BEAM, deckY: DECK_Y, bowLon: BOW_LON, mastLat: MAST_LAT, mastLon: MAST_LON, mastYTop: MAST_Y_TOP };
function hullDimsFor(slug) { return HULL_DIMS_BY_SLUG[slug] || HULL_DIMS_DEFAULT; }
// Widest hull half-length (merchantman) — the broad-phase reject pad is sized off this so no ship is missed.
const HULL_MAX_HALF_LEN = 16.0;

// Zone names. 'masts' is tracked but exempt from the sink rule and has no effect yet.
const ZONES = ['bow', 'stern', 'port', 'starboard', 'masts'];

// Starting hit points per zone, per vessel. Sides are the big broadside targets. The pinnace is
// lightly built — far fewer HP, so it sinks much faster than the sloop. Keep these in sync with the
// vessel defs (server/controllers/vessels.controller.js) and the client mirror (combat.constants.ts).
const ZONE_HP_BY_SLUG = {
  sloop:   { bow: 90,  stern: 90,  port: 130, starboard: 130, masts: 100 },
  pinnace: { bow: 55,  stern: 55,  port: 80,  starboard: 80,  masts: 60  },
  // Brigantine — a big, heavily-built warship: the toughest hull, and two masts to shoot away.
  brig:    { bow: 140, stern: 140, port: 200, starboard: 200, masts: 150 },
  // Merchantman / hagboat — the largest, most heavily-timbered hull (tankiest), but lightly gunned: a fat
  // trader that soaks punishment. Three masts collapse off the one masts zone.
  merchantman: { bow: 150, stern: 150, port: 220, starboard: 220, masts: 160 },
};
// ── Shipwright ARMOR upgrade ──────────────────────────────────────────────────────────────────────────────
// A once-per-hull armor upgrade adds +25% HP to the four HULL zones (masts excluded — they're rigging, not
// plating). Tuned so an upgraded hull stays BELOW the next ship up (e.g. an armored sloop broadside 163 < brig
// 200), so upgrading is a budget boost, not a way to leapfrog a tier. Returns a fresh per-zone HP map.
const ARMOR_UPGRADE_MULT = 1.25;
const ARMOR_ZONES = ['bow', 'stern', 'port', 'starboard'];   // hull plating (not masts)
function zoneHpFor(slug, armorUpgrade) {
  const base = ZONE_HP_BY_SLUG[slug] || ZONE_HP_BY_SLUG.sloop;
  if (!armorUpgrade) return base;
  const out = { ...base };
  for (const z of ARMOR_ZONES) if (out[z] != null) out[z] = Math.round(out[z] * ARMOR_UPGRADE_MULT);
  return out;
}
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

// Per-vessel cannon CALIBER → damage multiplier. Bigger ships carry heavier guns with real stopping power, so a
// brig's ball hurts far more than a pinnace's — ON TOP of the brig carrying more guns AND more hull HP (armour).
// Net: a brig wrecks a pinnace fast, while a pinnace peppering a brig barely dents it. Keyed by the SHOOTER slug.
// The merchantman is a TRADER: lightly gunned (modest caliber) despite its size — its tough hull, not its
// guns, is what keeps it alive.
const CALIBER_BY_SLUG = { pinnace: 0.8, sloop: 1.0, brig: 1.7, merchantman: 1.1 };
// Shipwright CANNON upgrade (once per hull): heavier guns → more stopping power, but tuned to stay BELOW the
// next ship up (armed pinnace 0.9 < sloop 1.0; armed sloop 1.3 < brig 1.7) so it never matches the next tier.
// The brig (top tier) gets a flat ~+24% with no cap.
const CALIBER_UPGRADED_BY_SLUG = { pinnace: 0.9, sloop: 1.3, brig: 2.1, merchantman: 1.4 };
function caliberFor(slug, cannonUpgrade) {
  if (cannonUpgrade) return CALIBER_UPGRADED_BY_SLUG[slug] || ((CALIBER_BY_SLUG[slug] || 1.0) * 1.2);
  return CALIBER_BY_SLUG[slug] || 1.0;
}

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

// ── Mast → sail-power curve (mirrors client combat.constants.ts mastSpeedMult) ─────────────────────────────
// Sail drive falls once mast health drops below the onset, easing to MAST_SLOW_FLOOR just above destroyed and
// 0 at fully destroyed (coasts like furled sails). Used server-side to slow NPC merchants when demasted.
const MAST_DAMAGE_ONSET = SEV_GREEN_MIN;   // 0.60 — penalty begins below this mast-health fraction
const MAST_SLOW_FLOOR   = 0.30;            // worst partial sail-power just above destroyed — a shot-up rig really
                                           // bleeds speed now (was 0.70, which barely slowed a damaged mast), so a
                                           // demasted ship can be run down. 0 at fully destroyed (coasts).
function mastSpeedMult(h) {
  if (h <= 0) return 0;
  if (h >= MAST_DAMAGE_ONSET) return 1;
  return MAST_SLOW_FLOOR + (1 - MAST_SLOW_FLOOR) * (h / MAST_DAMAGE_ONSET);
}

// ── Mast self-repair ──────────────────────────────────────────────────────────
// When the masts zone is shot to 0, a jury-rig repair starts automatically and, after this long,
// brings the mast back to a fraction of full (a partial fix — full repair still needs a port). The
// base duration; crew/morale modifiers will scale it later.
const MAST_REPAIR_MS   = 60000;   // 60 s base time to jury-rig the mast back up (a demasting should really cost you)
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
const RATE_WINDOW_MS   = 7000;      // (legacy; superseded by the per-side reload token bucket) sliding window
const RATE_MAX_SHOTS   = 18;        // (legacy)
const RATE_MIN_GAP_MS  = 90;        // (legacy) minimum spacing between any two shots

// ── Per-side, PER-SHIP reload gate (authoritative; mirrors the client per-gun reload) ─────────────────────────
// The fire-rate ceiling is the ship's OWN battery, not a fixed number, so a future ship with a bigger broadside
// isn't throttled and a small one isn't over-permitted: each side gets a token bucket of capacity = that ship's
// guns-per-side (grape: ×GRAPE_PELLET_CAP, a multi-pellet volley), refilling over one reload window. Firing a full
// broadside empties the side; you can't fire it again until it genuinely reloads — so cancel-and-re-run-out can't
// bypass the reload (the exploit). RELOAD_BASE_MS matches the client's default reloadWindow (6 s); it's divided by
// the crewFactor (0.5..1) so a short-handed gun crew reloads slower, exactly like the client.
const RELOAD_BASE_MS   = 6000;      // base per-gun reload window (full crew), matches client physics.reloadWindow ?? 6
const RELOAD_SLACK     = 0.9;       // refill a hair faster than nominal to tolerate the client's ±reload variance
const GRAPE_PELLET_CAP = 8;         // grape tokens per gun, per side (a volley is ~5 pellets/gun → one volley fits)

// ── Shot types (ammunition) ─────────────────────────────────────────────────────
// Per-type muzzle speed `v` (range ∝ v², so a slower ball falls short), the anti-exploit speed band
// the server checks the claimed |velocity| against, and per-zone damage multipliers applied in
// computeDamage (`hull` covers bow/stern/port/starboard; `masts` is the rigging column).
//   round = solid shot: full range, full hull damage, but poor against rigging (×0.33 mast).
//   bar   = bar/dismantling shot: ~45% range (37/55)², 1.6× mast damage, 0.6× hull damage.
//   grape = grapeshot/canister: SHORTEST range ((26/55)²≈22%), does NO hull/mast damage — it's anti-crew. A
//           gun throws a fanned SPREAD of pellets; each pellet that connects attrites `crew` sailors (a small
//           fraction, so it takes several broadsides to clear a full crew). `crew` is the per-pellet attrition.
const SHOT_TYPES = {
  round: { v: 55, vMin: VALID_V_MIN, vMax: VALID_V_MAX, dmg: { masts: 0.33, hull: 1.0 } },
  bar:   { v: 37, vMin: 30,          vMax: 45,          dmg: { masts: 1.6,  hull: 0.6 } },
  grape: { v: 26, vMin: 20,          vMax: 32,          dmg: { masts: 0,    hull: 0   }, crew: 0.15 },
};
function shotDef(type) { return SHOT_TYPES[type] || SHOT_TYPES.round; }

// Grapeshot fires many pellets per broadside, so the standard fire-rate cap (RATE_MAX_SHOTS) would reject the
// burst. Grape gets its own generous per-window budget (a sloop broadside ≈ 15 pellets; this allows ~4-5
// broadsides per window) and no min-gap, since the pellets leave together. Harmless if abused — grape can't
// sink a ship, only thin its crew (which is capped at the crew count).
const GRAPE_RATE_MAX = 72;

module.exports = {
  G, TRAVEL_SCALE,
  HALF_LEN, HALF_BEAM, DECK_Y, BOW_LON, MAST_LAT, MAST_LON, MAST_Y_TOP,
  HULL_DIMS_BY_SLUG, hullDimsFor, HULL_MAX_HALF_LEN,
  ZONES, ZONE_HP, ZONE_HP_BY_SLUG, zoneHpFor, ZONE_NORMAL, ARMOR_UPGRADE_MULT, ARMOR_ZONES,
  DMG_K, DMG_PERP_EXP, WATERLINE_BONUS_MAX, WATERLINE_BAND, CALIBER_BY_SLUG, CALIBER_UPGRADED_BY_SLUG, caliberFor,
  SEV_GREEN_MIN, SEV_YELLOW_MIN,
  MAST_DAMAGE_ONSET, MAST_SLOW_FLOOR, mastSpeedMult,
  MAST_REPAIR_MS, MAST_REPAIR_FRAC,
  SIM_DT, SIM_MAX_T, SIM_WATER_Y, BROADPHASE_PAD,
  VALID_ORIGIN_RADIUS, VALID_V_MIN, VALID_V_MAX,
  RATE_WINDOW_MS, RATE_MAX_SHOTS, RATE_MIN_GAP_MS,
  RELOAD_BASE_MS, RELOAD_SLACK, GRAPE_PELLET_CAP,
  SHOT_TYPES, shotDef, GRAPE_RATE_MAX,
};
