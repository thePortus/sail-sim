'use strict';

/**
 * NPC merchant ships (NPC Traders — NP2 fleet sim).
 *
 * NPCs are entries in the SAME multiplayer `players` Map (id 'npc_<n>', isNpc:true, ws:{readyState:3}=CLOSED)
 * so the joiner snapshot, broadcastPose, combat shot-adjudication, and player↔ship collision all include them
 * for free, while every `ws.readyState===1` send loop skips them as recipients. The server integrates their
 * movement each tick along a baked sea route (nav.js) and broadcasts pose to everyone — so all players see the
 * same ships in the same place. They steer to avoid each other; players bump off them via the existing
 * ship-to-ship collision (NPCs carry an authPose). Trip logic here is a placeholder town→town hop; NP3 makes
 * it a real buy-at-source / sell-at-destination trade.
 */

const nav = require('./nav');
const economy = require('./economy');
const combat = require('./combat');
const Cc = require('./combat-constants');   // shared ballistic constants (G, HALF_BEAM, TRAVEL_SCALE) for NPC gunnery
const factions = require('./factions');
const moveConst = require('./movement-constants');
const { getVesselDef, crewFor } = require('./controllers/vessels.controller');
const weatherState = require('./weather-state');   // server-authoritative wind (speed + bearing)

const DEG = Math.PI / 180;
// Weighted merchant vessel pool: sloops + pinnaces are the common traders; the occasional brigantine (a fat,
// well-armed prize) shows up at ~1-in-5. Duplicates set the odds via the uniform pick().
const MERCHANT_SLUGS = ['sloop', 'sloop', 'pinnace', 'pinnace', 'brig'];
const MERCHANT_NAMES = ['Gull', 'Albatross', 'Petrel', 'Sea Marten', 'Wandering Star', 'Dutch Maid', 'Saltbox',
  'Tradewind', 'Far Cathay', 'Indiaman', 'Carrack', 'Lateen', 'Fair Profit', 'Doubloon', 'Marianne'];
const ARRIVE_M = 45;         // world units: "reached this waypoint"
const AVOID_R = 140;         // world units: NPC↔NPC separation radius
// Interest management — a client only RECEIVES (and so only renders) the nearest few merchants. Distant ships
// are never sent, so their GLB + crew are never built. Keeps draw cost bounded regardless of fleet size.
const VIEW_RADIUS = 3000;    // world units: merchant draw distance (only nearby merchants are sent + rendered)
const VIEW_R2 = VIEW_RADIUS * VIEW_RADIUS;
const MAX_VISIBLE = 5;       // at most this many merchants per client (the nearest ones)
const MERCHANT_LOAD = 8;     // units a merchant tries to buy + carry per trip
// Merchants cruise EASY so a player can run one down. A flat throttle on the wind-derived target speed: it
// scales the polar result, so light wind / a bad point of sail still slow them further (fully wind-dependent),
// but their comfortable cruising speed stays well under what a trimmed player ship makes in the same wind —
// closing the gap that made merchants near-impossible to chase. Tune up toward 1.0 to make them faster.
const MERCHANT_CRUISE = 0.68;
const SEED_GOLD = 1500;      // working capital a merchant spawns with (looted on a sinking — NP4)
// Trip selection — a soft-weighted score over the most urgent shortages. Each merchant flies a nation's flag
// and PREFERS to keep trade within it (own-faction destination + source add a bonus), but a severe enough rival
// shortage still wins, so goods flow where they're truly needed. Jitter < OWN_DEST_BONUS so the fleet spreads
// across similar needs without overturning a clear faction preference.
const CONSIDER = 12;         // evaluate the N most-urgent shortages
const W_DISTRESS = 1.0;      // urgency per day a shortage has gone unmet
const W_SCARCITY = 8.0;      // urgency per (1 - stock level) — fresh-but-deep shortages still pull
const OWN_DEST_BONUS = 6.0;  // delivering to a home-nation town in need
const OWN_SRC_BONUS  = 2.0;  // sourcing from a home-nation producer
let TRIP_JITTER = 3.0;       // random spread so same-faction merchants don't all chase the single top need (test seam can zero it)
const SINK_LINGER_MS = 4000; // keep a sunk merchant around this long so the capsize animation plays, then despawn

// ── NPC combat (NP-combat) — a merchant shoots back when fired upon ───────────────────────────────────────
// Aggro is a timed grudge against the last attacker: each new hit refreshes it, and it lapses after AGGRO_MS
// of no further damage (the merchant then resumes its trade route). The tactical helm + gunnery that consume
// these fields live in later phases (A2–A4); A1 only records who's shooting and until when.
const AGGRO_MS = 45000;      // ms a merchant stays hostile after the last hit (refreshed per hit)
let seq = 0;

const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Fleet size scales with the number of towns. Bumped (8–15 → 11–20, 0.25 → 0.33/town) to offset the
// wind-bound merchants now sailing ~40% slower + tacking upwind, so overall trade throughput holds up.
function targetFleet(townCount) { return Math.max(11, Math.min(20, Math.round(townCount * 0.5))); }

// ── Convoys ───────────────────────────────────────────────────────────────────────────────────────────────
// Some "fleet slots" spawn as a CONVOY of 2–3 merchants that travel together (escorts trail the leader in
// formation), share threats (one attacked → all hostile), flee or fight in UNISON, and weigh their COMBINED
// strength when sizing up a foe. A convoy counts as ONE slot toward the fleet target (npcCount), so convoys
// don't inflate the world's ship count.
const CONVOY_CHANCE      = 0.22;   // fraction of new fleet slots that spawn as a convoy rather than a lone trader
const CONVOY_MIN         = 2;      // smallest convoy
const CONVOY_MAX         = 3;      // largest convoy
const CONVOY_SPACING     = 24;     // world units between formation slots
const CONVOY_SQUAD_RANGE = 2500;   // a player's squadron-mate only reinforces the threat if within this of the convoy

/** Fleet-slot count: each solo merchant is one slot, each distinct convoy is ONE slot (regardless of 2–3 ships). */
function npcCount(players) {
  let solo = 0; const convoys = new Set();
  for (const [, p] of players) {
    if (!p.isNpc) continue;
    if (p.convoyId) convoys.add(p.convoyId); else solo++;
  }
  return solo + convoys.size;
}

/** Heading (deg, atan2(x,z) convention) from a→b. */
function headingTo(ax, az, bx, bz) { return (Math.atan2(bx - ax, bz - az) * 180 / Math.PI + 360) % 360; }
/** Smallest signed angle a→b in degrees, in [-180,180]. */
function angleDelta(a, b) { let d = (b - a + 540) % 360 - 180; return d; }
/** Turn `cur` toward `target` by at most `maxStep` degrees. */
function turnToward(cur, target, maxStep) { const d = angleDelta(cur, target); return (cur + Math.max(-maxStep, Math.min(maxStep, d)) + 360) % 360; }
/** Blend two headings on the circle (t=0→a, 1→b) via unit vectors. */
function blendHeading(a, b, t) {
  const ax = Math.sin(a * DEG), az = Math.cos(a * DEG), bx = Math.sin(b * DEG), bz = Math.cos(b * DEG);
  const x = ax * (1 - t) + bx * t, z = az * (1 - t) + bz * t;
  return (Math.atan2(x, z) * 180 / Math.PI + 360) % 360;
}

// ── Wind sailing model — MIRRORS the player's VesselService so merchants are bound by the same wind envelope.
// NPCs sail full-canvas, perfectly trimmed (no trim model needed). Drive now comes from PER-RIG POLARS so a
// sloop and a pinnace sail differently, exactly like players (P3/P6). NPCs read the TRUE wind angle (no
// apparent-wind shift, no momentum/heel/reefing of the player force model) — a deliberate simplification: the
// polar SHAPE + no-go are the visible parity, and NPC speed stays a wind-proportional target, not a force sim.

/** Angle (deg) between a heading and the wind's FROM-bearing, in [0,180] — 0 = bow into the wind. */
function angleFromWind(heading, windBearing) {
  const d = ((heading - windBearing) % 360 + 360) % 360;
  return d > 180 ? 360 - d : d;
}

// PER-RIG drive polars — MIRROR the client (vessel-controller.ts SLOOP_SAIL / PINNACE_SAIL). Keep in sync.
// Both fore-and-aft: the sloop points higher and is stronger on a reach but weak dead-downwind; the pinnace
// points a touch lower and holds its drive far better on the run. [apparentAngle°, coeff], interpolated.
// The brig (square fore + gaff main) points LOW but holds strong drive on a reach and dead downwind.
const SAIL_POLARS = {
  sloop:   [[32, 0.46], [45, 0.64], [60, 0.80], [90, 0.93], [120, 1.00], [150, 0.82], [180, 0.66]],
  pinnace: [[34, 0.42], [55, 0.62], [80, 0.82], [100, 0.92], [125, 0.97], [150, 0.90], [180, 0.80]],
  brig:    [[50, 0.40], [70, 0.62], [90, 0.82], [120, 1.00], [150, 0.95], [180, 0.86]],
};

/** Per-rig drive coefficient at wind angle `aw` (0 = bow into wind). Below the no-go angle the sail
 *  luffs → backwinds (ramps to −0.30); above it, interpolate the rig's polar. Falls back to the sloop polar. */
function npcDrive(aw, slug, minTack) {
  if (aw < minTack) return -0.30 * (1 - aw / Math.max(1, minTack));   // luff → backwind in the no-go zone
  const p = SAIL_POLARS[slug] || SAIL_POLARS.sloop;
  if (aw <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (aw <= p[i][0]) {
      const t = (aw - p[i - 1][0]) / (p[i][0] - p[i - 1][0]);
      return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t;
    }
  }
  return p[p.length - 1][1];
}

/** Legacy step curve — kept for back-compat / tests; live NPC sailing now uses the per-rig npcDrive() above. */
function sailEff(aw, minTack) {
  if (aw < minTack) return -0.30;   // in irons
  if (aw < 45)  return 0.52;        // close-hauled
  if (aw < 60)  return 0.72;        // close reach
  if (aw < 90)  return 0.86;        // beam reach
  if (aw < 115) return 0.95;
  if (aw < 145) return 1.00;        // broad reach — peak
  if (aw < 165) return 0.88;        // running
  return 0.72;                      // dead downwind
}

/**
 * Upwind tacking: a sailing ship can't make way straight into the wind, so if the bearing to the waypoint
 * lies in the no-go zone (within minTack of the wind), return a close-hauled heading on a maintained tack
 * (zig-zagging toward it) instead. Hysteresis (TACK_HYST) stops it chattering near dead-upwind. Otherwise
 * sail straight at the waypoint.
 */
const TACK_HYST = 6;   // deg the waypoint must swing past the wind axis before the tack flips
function tackedHeading(bearingToWp, windBearing, minTack, npc) {
  const rel = ((bearingToWp - windBearing + 540) % 360) - 180;   // signed [-180,180]; 0 = dead upwind
  if (Math.abs(rel) >= minTack) return bearingToWp;              // sailable directly
  if (npc.tack !== 1 && npc.tack !== -1) npc.tack = rel >= 0 ? 1 : -1;
  if      (rel >  TACK_HYST) npc.tack = 1;
  else if (rel < -TACK_HYST) npc.tack = -1;
  return (windBearing + npc.tack * minTack + 360) % 360;
}

/**
 * Record that `npc` was just hit by `shooterId`: make it hostile toward that attacker and (re)arm the aggro
 * timer. Called from the combat shot-resolver for any NPC victim. No-op on a non-NPC or already-sunk ship, or
 * if the shooter is the merchant itself. The actual fighting (steer-for-broadside + return fire) is driven by
 * these fields in tickNpcs (A2–A4) — this just flips the switch.
 */
function markHostile(npc, shooterId, nowMs) {
  if (!npc || !npc.isNpc || !shooterId || shooterId === npc.id) return;
  if (npc.combat && npc.combat.sunk) return;
  npc.hostileToward = shooterId;
  npc.aggroUntil = nowMs + AGGRO_MS;
}

/** True while the merchant is actively hostile (has a target and the aggro timer hasn't lapsed). */
function isHostile(npc, nowMs) {
  return !!(npc.hostileToward && npc.aggroUntil > nowMs);
}

/** Crew-efficiency factor 0.5..1 (floor 0.5 with no crew) — mirrors the player/server formula; scales the
 *  merchant's sailing + turn when grapeshot has thinned its crew. */
function crewFactor(npc) {
  const max = npc.maxCrew | 0;
  if (!max) return 1;
  return 0.5 + 0.5 * Math.max(0, Math.min(1, (npc.crew | 0) / max));
}

// ── Tactical helm (A2) ────────────────────────────────────────────────────────────────────────────────────
// A hostile merchant abandons its trade route and jockeys to lay a broadside on its attacker. It steers for a
// heading perpendicular to the bearing-to-target (a clean side-on shot), closing when out of range and opening
// when too near so it never bow-rushes. Crucially it's still bound by the wind: of the two broadside options
// (target ±90°) it commits to whichever sails better in the current wind, so a merchant pinned on a bad point
// of sail manoeuvres realistically rather than magically holding the slot.
const FIRE_RANGE = 150;       // world units: ideal broadside standoff (well within round-shot reach) — tunable
const BROADSIDE_HYST = 0.12;  // the other tack must score this much higher (fractional) to flip the broadside side
// Weather gage (E1): a skilled NPC works to hold the WINDWARD position of its foe — from up-wind it can close or
// hold at will. When not yet to windward it favours the broadside tack that claws it up-wind (weighted by skill).
const GAGE_WEIGHT = 0.8;      // how hard a veteran prefers the windward tack (× skill × up-wind component of the heading)
const GAGE_MARGIN = 45;       // world units up-wind of the foe past which it stops clawing and just holds the broadside
// Raking (E2): if the foe shows its BOW or STERN to us (we sit near its fore-aft axis), a veteran seizes the rake —
// closes and pours its broadside DOWN the foe's length (the damage model already rewards square-on bow/stern hits +
// those zones have less HP). So showing a veteran escort your stern (e.g. to flee) is genuinely punishing.
const RAKE_CONE  = 42;        // deg: foe end within this of pointing at us = a rake opportunity
const RAKE_SKILL = 0.6;       // only captains this skilled bother to rake / anti-rake
const GIVE_UP_RANGE = 700;    // world units: a foe that opens past this is "lost" → drop the grudge, resume trade
const FLEE_HEALTH = 0.35;     // hull fraction at/below which a merchant breaks off and runs (fighting → fleeing)

/** Fraction of total HULL hit points (non-mast zones) remaining, 0..1. Drives the fight-vs-flee decision. */
function hullFraction(combat) {
  if (!combat) return 1;
  let cur = 0, max = 0;
  for (const z of Cc.ZONES) {
    if (z === 'masts') continue;
    cur += combat.zones[z] || 0; max += combat.maxHp[z] || 0;
  }
  return max > 0 ? cur / max : 1;
}

// ── D3: faction-hostility + relative-strength engagement ────────────────────────────────────────────────────
// A merchant treats a player its NATION hates (rep ≤ HOSTILE_REP with npc.faction) as an enemy even unprovoked —
// but whether it FIGHTS, AVOIDS, or simply watches depends on RELATIVE STRENGTH. shipStrength weighs CURRENT hull
// HP + broadside guns + top speed, so the comparison stays meaningful as bigger, better-armed ships enter play.
const HOSTILE_REP  = -70;    // a player at/below this standing with the merchant's nation is treated as an enemy on
                             // sight. Deliberately deep (was -25 ≈ ONE sink): with ~-25 rep per kill it takes
                             // ~3 sinkings of a nation's shipping to become a notorious-enough pirate that its
                             // OTHER ships auto-aggro you. (The ship you actually fire on still defends itself —
                             // that's the separate PROVOKED path, unaffected by this.)
const DETECT_RANGE = 650;    // world units: how far off a merchant notices a hated player (to start avoiding / closing)
const ENGAGE_RANGE = 320;    // world units: an even/stronger merchant defends its lane once a hated player closes to here
const AVOID_RATIO  = 1.25;   // the foe must be ≥25% stronger for the merchant to break off and run rather than fight
const STR_HULL_W   = 1.0;    // strength per current hull point
const STR_GUN_W    = 30.0;   // strength per broadside gun
const STR_SPEED_W  = 8.0;    // strength per knot of top speed
// NPC helm = the PLAYER'S helm. These mirror client vessel.service exactly so an NPC sloop turns like a player
// sloop, an NPC brig like a player brig: a speed-dependent Lorentzian rudder authority (vesselTurnRate), eased
// in through angular inertia (YAW_RESPONSE), and capped hard once the mast is down — no instant combat pivots.
const YAW_RESPONSE      = 4;    // how fast yaw eases to the target rate (1/s) — matches the player
const MAST_DOWN_TURN_MAX = 6;   // deg/s helm cap once the mast is down (matches client combat.constants)
/** Speed-dependent max yaw (deg/s), IDENTICAL to vessel.service.turnRate(): peaks at ~28% of hull speed, falls
 *  off sharply when fast and to a barely-steerable floor when nearly stopped. maxSpeed = this vessel's def. */
function vesselTurnRate(speed, maxSpeed) {
  const sf = Math.abs(speed) / (maxSpeed || 8);
  if (sf < 0.03) return 4;
  const p = 0.28;
  const rate = 155 * sf / (1 + (sf / p) * (sf / p));
  return Math.max(4, Math.min(30, rate));
}

// ── v2 force-model constants — MIRROR client vessel.service.physicsStep EXACTLY so an NPC sails like a
// same-class player (apparent wind + thrust-vs-quadratic-drag + mass momentum). Keep in sync if the client
// retunes. (Sea drag + the wave surf-nudge are omitted: the server has no per-NPC sea state — a minor
// difference only in rough/head seas.) ──
const SAIL_FORCE_K  = 0.26;   // default drive scale (brig overrides below)
const DRAG_K        = 1.0;    // quadratic hull drag — sets where drive=drag (top speed)
const FORCE_RESPONSE = 0.04;  // accel gain (with mass → momentum / time constant)
const WEIGHT_REF    = 2800;   // sloop weight → massK = weight / WEIGHT_REF
const TURN_SCRUB    = 0.06;   // speed bled by a hard turn (broadside drag)
const HEEL_K        = 0.22;   // heel = HEEL_K·SAF·V_app²·sin(angle) (canvas=1, NPCs full sail)
const COMFORT_HEEL  = 16;     // ° before the sail spills wind
const SPILL_RANGE   = 14;     // ° of heel over comfort that ramps spill 0→1
const SPILL_MAX     = 0.75;   // max forward-drive fraction lost to an over-pressed (heeled) sail
const FORCE_K_BY_SLUG = { sloop: SAIL_FORCE_K, pinnace: SAIL_FORCE_K, brig: 1.12 };   // mirrors VESSEL_RIGS sail.forceK

/** Current (and max) non-mast hull points of a combat state. */
function hullPoints(combat) {
  let cur = 0, max = 0;
  if (combat) for (const z of Cc.ZONES) { if (z === 'masts') continue; cur += combat.zones[z] || 0; max += combat.maxHp[z] || 0; }
  return { cur, max };
}
/** Relative fighting strength of ANY ship entry (player or merchant): CURRENT hull + broadside firepower + speed.
 *  A shot-up ship reads weaker (current hull), more guns / a faster hull read stronger — so the assessment scales
 *  naturally to the heavier vessels coming. Slug from state.vesselSlug (merchant/player) or the owned ship. */
function shipStrength(entry) {
  const slug = (entry.state && entry.state.vesselSlug) || entry.ship || 'pinnace';
  const def = getVesselDef(slug) || {};
  const guns = (def.cannons && def.cannons.port && def.cannons.port.length) || 1;
  const speed = (def.physics && def.physics.maxSpeed) || 8;
  const hull = entry.combat ? hullPoints(entry.combat).cur : 100;
  return Math.max(1, hull * STR_HULL_W + guns * STR_GUN_W + speed * STR_SPEED_W);
}
/** A player's standing with `faction` (0 if absent / not yet loaded). */
function repWith(player, faction) {
  return (player && player.factionRep && Number.isFinite(player.factionRep[faction])) ? player.factionRep[faction] : 0;
}

// ── Role-scaled skill (NPC combat realism E0) ────────────────────────────────────────────────────────────────
// One `skill` scalar (0 = timid/clumsy lone trader … 1 = veteran convoy escort) modulates the EXISTING combat
// knobs so a panicky merchant feels nothing like a sharp escort, WITHOUT (yet) any new maneuvers. Set at spawn by
// role (see makeMerchant). Kept on the fair side — even a veteran scatters its shot and breaks off when truly
// outmatched, so the player can always out-sail it.
const SKILL_TRADER_SOLO   = 0.28;   // lone merchant — clumsy, panics early
const SKILL_TRADER_CONVOY = 0.45;   // a trader emboldened by sailing with an escort
const SKILL_ESCORT        = 0.9;    // veteran warship escort
function npcSkill(npc) { return typeof npc.skill === 'number' ? npc.skill : SKILL_TRADER_SOLO; }
/** Hull fraction at/below which it runs: timid bolts at 50%, a veteran fights down to ~22%. */
function fleeHealthFor(skill) { return 0.5 - 0.28 * skill; }
/** How much stronger the foe must be before it breaks off: timid flees at parity, a veteran holds till foe ~60% up. */
function avoidRatioFor(skill) { return 1.0 + 0.6 * skill; }
/** Gunnery scatter multiplier: timid sprays (1.5×), a veteran is tight (0.6×) — never zero, so it's still beatable. */
function aimSpreadMul(skill) { return 1.5 - 0.9 * skill; }
/** Escape-line wobble amplitude (deg): timid wanders badly (~12°, easy to run down), a veteran flees clean (~3°). */
function fleeWanderAmp(skill) { return 12 - 9 * skill; }

/** The threat a merchant should react to this tick: its PROVOKED attacker (it was fired on — existing aggro) or,
 *  failing that, the nearest player its nation HATES within DETECT_RANGE. Returns { foe, provoked } or null. */
function findThreat(npc, players, nowMs) {
  const provoked = engageTarget(npc, players, nowMs);   // existing grudge (hit → hostileToward), already stale/sunk/escape-checked
  if (provoked) return { foe: provoked, provoked: true };
  // Unprovoked: scan for the nearest HATED player in detection range (its nation's enemy by reputation).
  let best = null, bestD2 = DETECT_RANGE * DETECT_RANGE;
  for (const [, p] of players) {
    if (p.isNpc || !p.state || (p.combat && p.combat.sunk)) continue;
    if (repWith(p, npc.faction) > HOSTILE_REP) continue;   // not hated enough → ignored
    const dx = p.state.x - npc.state.x, dz = p.state.z - npc.state.z, d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  return best ? { foe: best, provoked: false } : null;
}

/** Decide a merchant's stance toward a threat: 'fight' | 'flee' | 'route' (hold the trade run). Badly-hurt → always
 *  flee. Outmatched (foe ≥ AVOID_RATIO stronger) → flee/avoid. Otherwise a PROVOKED merchant fights back; an
 *  UNPROVOKED (merely hated) one holds its lane and only engages defensively once the player closes to ENGAGE_RANGE
 *  — it won't chase a hated stranger across the sea, but it won't be boarded for free either. */
function combatStance(npc, foe, provoked) {
  const skill = npcSkill(npc);
  if (hullFraction(npc.combat) < fleeHealthFor(skill)) return 'flee';
  const ratio = shipStrength(foe) / shipStrength(npc);
  if (ratio > avoidRatioFor(skill)) return 'flee';           // they're stronger → keep away / run
  if (provoked) return 'fight';                              // attacked + can hold our own → fight back
  const dx = foe.state.x - npc.state.x, dz = foe.state.z - npc.state.z;
  return (dx * dx + dz * dz) <= ENGAGE_RANGE * ENGAGE_RANGE ? 'fight' : 'route';
}

// ── Convoy tactics ───────────────────────────────────────────────────────────────────────────────────────────
/** Effective strength of a threat: the foe PLUS any squadron-mates within CONVOY_SQUAD_RANGE of the convoy (a
 *  far-off squad-mate isn't part of THIS fight). (refX,refZ) = the convoy's centre. Solo foe → just its strength. */
function threatStrength(foe, players, refX, refZ) {
  let s = shipStrength(foe);
  if (foe.squadron) {
    const R2 = CONVOY_SQUAD_RANGE * CONVOY_SQUAD_RANGE;
    for (const [, p] of players) {
      if (p === foe || p.isNpc || !p.state || (p.combat && p.combat.sunk)) continue;
      if (p.squadron !== foe.squadron) continue;
      const dx = p.state.x - refX, dz = p.state.z - refZ;
      if (dx * dx + dz * dz <= R2) s += shipStrength(p);   // only nearby squad-mates reinforce the threat
    }
  }
  return s;
}

/** All live members of `npc`'s convoy (including itself), or just [npc] if it sails alone. */
function convoyMembers(npc, players) {
  if (!npc.convoyId) return [npc];
  const out = [];
  for (const [, p] of players) {
    if (p.isNpc && p.convoyId === npc.convoyId && !(p.combat && p.combat.sunk)) out.push(p);
  }
  return out.length ? out : [npc];
}

/** ONE stance for a whole convoy, applied to every member so they fight or flee in UNISON, weighing their
 *  COMBINED strength against the foe (+ its nearby squadron). Badly-hurt convoy (mean hull < FLEE_HEALTH) or an
 *  outmatched one runs; a provoked convoy that can hold its own fights; an unprovoked one engages only once the
 *  foe closes on any member. */
function convoyStance(members, foe, provoked, players) {
  let cx = 0, cz = 0, ourStr = 0, hullSum = 0, skill = 0;
  for (const m of members) {
    cx += m.state.x; cz += m.state.z; ourStr += shipStrength(m); hullSum += hullFraction(m.combat);
    skill = Math.max(skill, npcSkill(m));   // the escort emboldens the whole convoy → use the bravest member's nerve
  }
  cx /= members.length; cz /= members.length;
  if (hullSum / members.length < fleeHealthFor(skill)) return 'flee';
  if (threatStrength(foe, players, cx, cz) / Math.max(1, ourStr) > avoidRatioFor(skill)) return 'flee';
  if (provoked) return 'fight';
  const R2 = ENGAGE_RANGE * ENGAGE_RANGE;
  const near = members.some((m) => {
    const dx = foe.state.x - m.state.x, dz = foe.state.z - m.state.z; return dx * dx + dz * dz <= R2;
  });
  return near ? 'fight' : 'route';
}

/** The convoy's live leader (routes + trades for the group), or null if it's been sunk/despawned. */
function convoyLeader(convoyId, players) {
  for (const [, p] of players) {
    if (p.isNpc && p.convoyId === convoyId && p.convoyRole === 'leader' && !(p.combat && p.combat.sunk)) return p;
  }
  return null;
}

/** Heading for an ESCORT to hold its formation slot astern-and-abeam of the convoy leader. Returns null (→ route
 *  normally) when there's no leader — the escort PROMOTES itself to leader so a beheaded convoy keeps trading. */
function convoyFollowHeading(npc, players) {
  const leader = convoyLeader(npc.convoyId, players);
  if (!leader) {
    // Leader lost. The lowest-slot survivor takes command (deterministic → exactly one new leader); the rest route
    // for a tick, then fall in behind it next tick.
    const members = convoyMembers(npc, players);
    let lead = members[0]; for (const m of members) { if ((m.convoySlot | 0) < (lead.convoySlot | 0)) lead = m; }
    if (lead === npc) { npc.convoyRole = 'leader'; npc.route = null; }
    return null;
  }
  const hr = leader.state.heading * DEG;
  const fx = Math.sin(hr), fz = Math.cos(hr);      // leader forward
  const rx = Math.cos(hr), rz = -Math.sin(hr);     // leader starboard
  const slot = npc.convoySlot || 1;
  const side = (slot % 2 === 1) ? 1 : -1;          // alternate sides
  const lane = Math.ceil(slot / 2);                // how far astern
  const tx = leader.state.x - fx * CONVOY_SPACING * lane + rx * side * CONVOY_SPACING * 0.7;
  const tz = leader.state.z - fz * CONVOY_SPACING * lane + rz * side * CONVOY_SPACING * 0.7;
  return headingTo(npc.state.x, npc.state.z, tx, tz);
}

/** The live foe this merchant is engaging, or null. Clears the grudge if the target has vanished, sunk, or
 *  opened past GIVE_UP_RANGE (it escaped / was lost) — at which point the merchant resumes its trade route. */
function engageTarget(npc, players, nowMs) {
  if (!isHostile(npc, nowMs)) return null;
  const foe = players.get(npc.hostileToward);
  if (!foe || !foe.state || (foe.combat && foe.combat.sunk)) {   // disconnected / sunk → stand down
    npc.hostileToward = null; npc.aggroUntil = 0; return null;
  }
  const dx = foe.state.x - npc.state.x, dz = foe.state.z - npc.state.z;
  if (dx * dx + dz * dz > GIVE_UP_RANGE * GIVE_UP_RANGE) {        // foe broke contact → give up the chase
    npc.hostileToward = null; npc.aggroUntil = 0; return null;
  }
  return foe;
}

/** Desired heading to present a broadside to the foe ENTRY `foe`. RANGE BAND scales with relative strength —
 *  stronger → close for a decisive exchange, weaker → stand off and pepper at round-shot range. SIDE choice takes
 *  the more sailable tack AND, for a skilled captain not yet up-wind of the foe, the one that claws toward the
 *  WEATHER GAGE (the windward position lets it dictate range). Hysteresis stops tack-chatter. */
function engageHeading(npc, foe, wind, ph) {
  const fs = foe.state;
  const B = headingTo(npc.state.x, npc.state.z, fs.x, fs.z);
  const dist = Math.hypot(fs.x - npc.state.x, fs.z - npc.state.z);
  const skill = npcSkill(npc);

  // Rake opportunity: is the foe showing us its bow or stern? (we sit near its fore-aft axis.) A skilled captain
  // then CLOSES to drive a raking broadside down the exposed end (and flags it so the gunnery loads round, not bar).
  const aspect = Math.abs(angleDelta(fs.heading, (B + 180) % 360));   // 0 = off foe's bow, 180 = off its stern, 90 = abeam
  const raking = skill >= RAKE_SKILL && (aspect < RAKE_CONE || aspect > 180 - RAKE_CONE);
  npc.raking = raking;

  // Range band by relative strength: stronger → close in; weaker → keep the range open and pepper with round shot.
  // A rake overrides toward a punchy close range to land it before the foe can turn its broadside back to us.
  const strRatio = shipStrength(npc) / Math.max(1, shipStrength(foe));
  const desiredRange = raking ? FIRE_RANGE * 0.7
                     : strRatio > 1.2 ? FIRE_RANGE * 0.8
                     : strRatio < 0.85 ? Math.min(MAX_FIRE_RANGE * 0.9, FIRE_RANGE * 1.7)
                     : FIRE_RANGE;
  // Close offset: a skilled captain angles in more BEAM-on (anti-rake — don't expose our own bow on the approach).
  const closeOffset = 55 + 18 * skill;
  let offset;
  if (dist > desiredRange * 1.3)      offset = closeOffset;   // well out → angle in to close (skill = more beam-on)
  else if (dist < desiredRange * 0.7) offset = 120;           // too near → open out, avoid fouling / ramming
  else                                offset = 90;            // in the slot → hold a clean broadside (orbits at range)
  const hPlus  = (B + offset + 360) % 360;
  const hMinus = (B - offset + 360) % 360;

  // Weather-gage seek: claw up-wind until we're GAGE_MARGIN to windward of the foe (then just hold). Skip it while
  // raking — the exposed end is the prize NOW, no time to work the wind.
  const wb = wind.windBearing * DEG, Ux = Math.sin(wb), Uz = Math.cos(wb);   // unit vector toward the wind's SOURCE (up-wind)
  const windwardNow = (npc.state.x - fs.x) * Ux + (npc.state.z - fs.z) * Uz;  // >0 already to windward of the foe
  const seekGage = !raking && windwardNow < GAGE_MARGIN;
  const slug = npc.state.vesselSlug;
  const score = (h) => {
    const eff = Math.max(0, npcDrive(angleFromWind(h, wind.windBearing), slug, ph.minTackAngle));
    if (!seekGage) return eff;
    const upwind = Math.sin(h * DEG) * Ux + Math.cos(h * DEG) * Uz;   // how much this heading carries us up-wind
    return eff * (1 + GAGE_WEIGHT * skill * Math.max(0, upwind));
  };
  const sPlus = score(hPlus), sMinus = score(hMinus);
  let side = (npc.broadsideSide === 1 || npc.broadsideSide === -1) ? npc.broadsideSide : (sPlus >= sMinus ? 1 : -1);
  if      (side === 1  && sMinus > sPlus  * (1 + BROADSIDE_HYST)) side = -1;
  else if (side === -1 && sPlus  > sMinus * (1 + BROADSIDE_HYST)) side = 1;
  npc.broadsideSide = side;
  return side === 1 ? hPlus : hMinus;
}

/**
 * Flee helm (A4): a badly-hurt merchant runs for it. Picks the heading that best trades off OPENING distance
 * from the foe against SPEED — so it doesn't blindly point straight away onto a dead-slow upwind beat; it bears
 * off downwind onto a fast broad reach that still carries it clear. (It keeps firing opportunistically: the
 * gunnery's arc gate lets a stern-chasing foe eat a parting broadside whenever it swings abeam — no extra code.)
 */
function escapeHeading(npc, foe, wind, ph) {
  const fs = foe.state;
  const away = (headingTo(npc.state.x, npc.state.z, fs.x, fs.z) + 180) % 360;   // straight away from foe
  const awayX = Math.sin(away * DEG), awayZ = Math.cos(away * DEG);
  const skill = npcSkill(npc);
  // Wind-craft escape: pick the heading that opens distance fastest RELATIVE to the pursuer's own polar. A weatherly
  // ship out-points a square-rigger, so it claws up-wind to shake it; a downwind-fast ship just runs off. The foe's
  // speed on the same point of sail (it chases roughly parallel) is subtracted, weighted by skill — so a clumsy
  // trader just runs fastest-away (own speed only) while a veteran out-thinks the chaser's rig.
  const foeSlug = (fs && fs.vesselSlug) || foe.ship || 'pinnace';
  const foeTack = (getVesselDef(foeSlug)?.physics?.minTackAngle) || 36;
  let best = away, bestRate = -Infinity;
  for (let h = 0; h < 360; h += 15) {
    const opening = Math.sin(h * DEG) * awayX + Math.cos(h * DEG) * awayZ;   // -1 (toward foe) .. 1 (dead away)
    if (opening <= 0) continue;                                              // only headings that actually open range
    const mine   = Math.max(0, npcDrive(angleFromWind(h, wind.windBearing), npc.state.vesselSlug, ph.minTackAngle));
    const theirs = Math.max(0, npcDrive(angleFromWind(h, wind.windBearing), foeSlug, foeTack));
    const rate = (mine - theirs * skill) * opening;   // skill 0 → fastest-away; skill 1 → maximise the gap vs the chaser
    if (rate > bestRate) { bestRate = rate; best = h; }
  }
  return best;
}

// ── Gunnery (A3) — the merchant returns fire ────────────────────────────────────────────────────────────────
// When a gun bears (target roughly abeam) and within range, the NPC computes a leading ballistic solution at
// fixed muzzle speed, scatters it for moderate accuracy, and hands the shot to the server's shared adjudicator
// (same activeShots the player feeds — so the merchant's ball can be dodged exactly like a player's). Everything
// is in COMBAT world units (HALF_BEAM/G/TRAVEL_SCALE), NOT the GLB-scale cannon offsets in the vessel def.
const NPC_MUZZLE_V    = Cc.SHOT_TYPES.round.v;  // 55 u/s — default round shot (anti-hull); NPCs also mix in bar (anti-rig)
const FIRE_ARC        = 50;        // deg off pure-beam the target may be for a gun to bear
const MAX_FIRE_RANGE  = 260;       // world units: don't open fire beyond this (well inside round-shot max reach)
const NPC_RELOAD_MS   = 4200;      // min ms between a merchant's shots (one aimed ball per reload — deliberately unhurried)
const NPC_AZ_SPREAD   = 7.5;       // deg: half-width of random bearing scatter (loosened — merchants miss more)
const NPC_EL_SPREAD   = 3.5;       // deg: half-width of random elevation scatter (more over/undershoot)
const MUZZLE_Y        = 2.6;       // gun height above the waterline (world units, ~deck)
const AIM_Y           = 1.4;       // aim point on the target hull (mid-freeboard)
// Bar/dismantling shot (anti-rig) — NPCs now mix it in when a real captain would: to bring a foe's MASTS down so
// it can't flee or give chase. Bar flies slower (≈37 u/s → ~140 u reach), so only choose it within BAR_RANGE.
const BAR_RANGE       = 130;       // world units: bar's effective reach (well under round's) — don't pick it beyond
const BAR_CHANCE      = 0.6;       // probability of choosing bar when the tactical case for crippling the rig fits

/** Foe's mast-health fraction (1 if unknown) — bar shot is only worth firing while the target still has a rig. */
function foeMastFrac(foe) {
  const c = foe && foe.combat;
  return (c && c.maxHp && c.maxHp.masts) ? (c.zones.masts / c.maxHp.masts) : 1;
}

/** Pick the NPC's shot type — ROUND (anti-hull) or BAR (anti-rig). NPCs never fire grape at players (anti-crew —
 *  kept out so the player isn't forever re-crewing). RAKING → round, to pour solid shot down the exposed length.
 *  Otherwise BAR when the case fits: within bar's short reach, the foe still has masts worth shooting, AND we're
 *  running for our life (rake the pursuer's rig) or can't out-sail the foe (slow it). Probabilistic; round dominates. */
function chooseNpcShot(npc, foe, dist) {
  if (npc.raking) return 'round';                                       // raking the hull → solid shot
  if (dist > BAR_RANGE || foeMastFrac(foe) <= 0.15) return 'round';
  const foeFaster = foe.state && Math.abs(foe.state.speed) > (npc.state.speed || 0) + 0.3;
  if ((npc.fleeing || foeFaster) && Math.random() < BAR_CHANCE) return 'bar';
  return 'round';
}

/** Uniform scatter in [-half, half] degrees, returned in radians. */
function spreadRad(halfDeg) { return (Math.random() * 2 - 1) * halfDeg * DEG; }

/**
 * Leading ballistic firing solution against a moving target, or null if no gun bears / target is out of range /
 * the range is unreachable at muzzle speed. Iterates the lead (aim where the target WILL be after the ball's
 * flight), solves the low-arc launch elevation for that range + height drop, then adds azimuth/elevation
 * scatter. Speed of the returned velocity stays exactly NPC_MUZZLE_V, so it sits in the round-shot band.
 * Returns world-space { ox, oy, oz, vx, vy, vz }.
 */
function firingSolution(npc, foeState, muzzleV) {
  const hr = npc.state.heading * DEG;
  const sx = Math.cos(hr), sz = -Math.sin(hr);   // starboard (right) unit vector in world XZ
  const dx = foeState.x - npc.state.x, dz = foeState.z - npc.state.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3 || dist > MAX_FIRE_RANGE) return null;
  // Which beam faces the target (lat>0 = starboard), and does a gun on that side actually bear?
  const lat = dx * Math.cos(hr) - dz * Math.sin(hr);
  const sgn = lat >= 0 ? 1 : -1;
  const beamX = sgn * sx, beamZ = sgn * sz;            // unit vector out the firing rail
  const cosOff = (dx * beamX + dz * beamZ) / dist;     // alignment of target with the beam
  if (cosOff < Math.cos(FIRE_ARC * DEG)) return null;  // target not abeam yet → hold fire (helm still turning)

  // Muzzle: ship centre pushed out to the firing rail at gun height.
  const ox = npc.state.x + beamX * Cc.HALF_BEAM, oz = npc.state.z + beamZ * Cc.HALF_BEAM;
  // Target world velocity (same dead-reckoning the adjudicator uses).
  const vW = (foeState.speed || 0) * Cc.TRAVEL_SCALE;
  const tvx = Math.sin(foeState.heading * DEG) * vW, tvz = Math.cos(foeState.heading * DEG) * vW;
  const v = muzzleV || NPC_MUZZLE_V, v2 = v * v, dY = AIM_Y - MUZZLE_Y;

  // Iterate: lead → range → flight-time → re-lead.
  let tof = dist / (v * 0.97), vh = v, theta = 0, px = foeState.x, pz = foeState.z, R = dist;
  for (let k = 0; k < 3; k++) {
    px = foeState.x + tvx * tof; pz = foeState.z + tvz * tof;   // where the target will be
    R = Math.hypot(px - ox, pz - oz);
    const disc = v2 * v2 - Cc.G * (Cc.G * R * R + 2 * dY * v2);
    if (disc < 0) return null;                                  // out of ballistic reach
    theta = Math.atan2(v2 - Math.sqrt(disc), Cc.G * R);         // low (direct-fire) arc
    vh = v * Math.cos(theta);
    tof = R / vh;
  }
  // Aim azimuth at the lead point, then scatter both axes (speed magnitude preserved → stays in band).
  const sm = aimSpreadMul(npcSkill(npc));   // veteran tight, timid sprays (role-scaled accuracy)
  const az = Math.atan2(px - ox, pz - oz) + spreadRad(NPC_AZ_SPREAD * sm);
  const el = theta + spreadRad(NPC_EL_SPREAD * sm);
  const vhs = v * Math.cos(el);
  return { ox, oy: MUZZLE_Y, oz, vx: vhs * Math.sin(az), vy: v * Math.sin(el), vz: vhs * Math.cos(az) };
}

// ── Land avoidance ──────────────────────────────────────────────────────────────────────────────────────────
// NPCs must NEVER sail through land — not even in combat, where they steer a FREE heading (engage/escape) off the
// A* route. Probe a lookahead along the intended heading; if it would cross land, sweep outward (alternating
// left/right) to the nearest heading whose lookahead stays on navigable water, so they round the shore instead of
// ploughing through it. Lookahead scales with speed so a fast ship turns away in time.
const LAND_LOOK_BASE = 130;   // base lookahead (m): a hull-length-plus reaction buffer before any open-water term
const LAND_LOOK_SEC  = 7;     // + this many SECONDS of world travel, so a faster ship commits to the turn earlier
const LAND_TURN_BIAS = 0.7;   // metres of open water "worth" of penalty per degree of detour — prefer the smallest
                              // turn that still clears, so merchants hug straight lines and only swing wide near land
const LAND_COMMIT    = 0.35;  // probe from this fraction of the lookahead AHEAD on the CURRENT heading: the ship keeps
                              // surging forward while the helm swings, so test from where it WILL be, not where it is

/** Open-water distance ahead on `headingDeg` from (x,z), capped at lookM (graduated — see nav.openDistance). */
function openAhead(x, z, headingDeg, lookM) {
  const hr = headingDeg * DEG;
  return nav.openDistance(x, z, x + Math.sin(hr) * lookM, z + Math.cos(hr) * lookM);
}
// Steer AROUND land — even in combat, where the helm follows a FREE heading (engage/escape) off the A* route.
// Probe a speed-scaled lookahead; if the intended heading would fetch up on land, sweep outward and take the
// heading with the MOST open water ahead, biased toward the smallest detour. Crucially it NEVER holds a blocked
// heading: a boxed-in merchant (bay, concave headland, or a turn it can't finish in time) turns toward the most
// open water it can find instead of ploughing straight in — the old version fell through and beached itself.
function avoidLand(npc, desired) {
  const speedW = Math.abs(npc.state.speed) * moveConst.TRAVEL_SCALE;   // world units/s
  const lookM  = LAND_LOOK_BASE + speedW * LAND_LOOK_SEC;
  // Origin a little ahead on the current heading (turn-in lag), but only if that point is still on water.
  const hr = npc.state.heading * DEG;
  const commit = Math.min(lookM * LAND_COMMIT, speedW * 1.5);
  let ox = npc.state.x, oz = npc.state.z;
  const cx = ox + Math.sin(hr) * commit, cz = oz + Math.cos(hr) * commit;
  if (commit > 1 && nav.clearLine(ox, oz, cx, cz)) { ox = cx; oz = cz; }

  if (openAhead(ox, oz, desired, lookM) >= lookM) return desired;   // intended heading stays clear → keep it
  let best = desired, bestScore = -Infinity;
  for (let off = 12; off <= 180; off += 12) {
    for (const cand of [(desired + off) % 360, (desired - off + 360) % 360]) {
      const open = openAhead(ox, oz, cand, lookM);
      if (open >= lookM) return cand;                 // first fully-clear detour wins (smallest offset, by sweep order)
      const score = open - off * LAND_TURN_BIAS;
      if (score > bestScore) { bestScore = score; best = cand; }
    }
  }
  return best;   // most-open heading found — turn toward water rather than hold course into the rocks
}

/** A heading pointing away from nearby merchants (separation), or null if none are close. */
function avoidanceHeading(npc, fleet) {
  let sx = 0, sz = 0, n = 0;
  for (const o of fleet) {
    if (o === npc) continue;
    const dx = npc.state.x - o.state.x, dz = npc.state.z - o.state.z, d = Math.hypot(dx, dz);
    if (d > 1e-3 && d < AVOID_R) { const w = (AVOID_R - d) / AVOID_R; sx += (dx / d) * w; sz += (dz / d) * w; n++; }
  }
  return n ? (Math.atan2(sx, sz) * 180 / Math.PI + 360) % 360 : null;
}

/** Pick a nation for a new merchant, weighted by how many towns each nation holds (more towns → more traders). */
function pickFaction(towns) {
  const ids = factions.factionIds();
  const counts = {}; for (const id of ids) counts[id] = 0;
  for (const t of towns) if (t.faction && counts[t.faction] != null) counts[t.faction]++;
  const total = ids.reduce((s, id) => s + counts[id], 0);
  if (!total) return pick(ids);
  let r = Math.random() * total;
  for (const id of ids) { r -= counts[id]; if (r < 0) return id; }
  return ids[ids.length - 1];
}

/** Build + register one merchant at `town`. `convoy` = {id, role:'leader'|'follower', slot, ox, oz} or null.
 *  `skill` (0..1) + `combatRole` ('trader'|'escort') drive the role-scaled combat behaviour (E0). */
function makeMerchant(players, town, faction, slug, convoy, skill, combatRole) {
  const id = 'npc_' + (++seq);
  const ox = convoy ? convoy.ox : 0, oz = convoy ? convoy.oz : 0;
  const sx = town.x + ox, sz = town.z + oz;
  const npc = {
    id, isNpc: true, ws: { readyState: 3 }, faction,
    state: {
      x: sx, z: sz, heading: 0, speed: 0, turnRate: 0, sheetAngle: 0,
      isPortTack: false, anchored: false, sailState: 'full',
      vesselName: 'Merchant ' + pick(MERCHANT_NAMES), vesselSlug: slug, callsign: '',
    },
    authPose: { x: sx, z: sz, heading: 0, speed: 0 },
    combat: combat.newCombatState(slug),
    lastUpdateMs: Date.now(),
    physics: getVesselDef(slug)?.physics || { maxSpeed: 8, accelerationRate: 0.28, minTackAngle: 36, sailAreaFactor: 0.34 },
    tack: 1,   // current tack (+1/−1) for upwind zig-zagging
    route: null, routeIdx: 0, curTownId: town.id, legTarget: null,
    gold: SEED_GOLD, cargo: {}, trip: null, phase: null,   // trip = {goodId,srcTownId,destTownId,qty}; phase = toSource|toDest
    // NP-combat: set by markHostile() when this merchant is hit; consumed by the tactical helm + gunnery (A2–A4).
    hostileToward: null, aggroUntil: 0, lastShotAt: 0, shotSeq: 0,
    // Crew: merchants carry a full complement too, so grapeshot attrites it (and slows them) like a player ship.
    maxCrew: crewFor(slug), crew: crewFor(slug), crewWound: 0,
    // Convoy: null = sails alone. Members share convoyId; the 'leader' routes/trades, 'follower's hold formation.
    convoyId: convoy ? convoy.id : null, convoyRole: convoy ? convoy.role : null, convoySlot: convoy ? convoy.slot : 0,
    // E0 combat realism: skill scales the existing knobs; combatRole splits convoy behaviour (escort fights, trader evades).
    skill: typeof skill === 'number' ? skill : SKILL_TRADER_SOLO, combatRole: combatRole || 'trader',
  };
  players.set(id, npc);
  return npc;
}

/** Pick a faction + one of its home towns (or anywhere if it holds none yet). */
function pickHome(towns) {
  const faction = pickFaction(towns);
  const home = towns.filter((t) => t.faction === faction);
  return { faction, town: pick(home.length ? home : towns) };
}

/** Spawn ONE fleet slot: usually a lone trader, occasionally (CONVOY_CHANCE) a 2–3 ship convoy. Returns the
 *  (lead) merchant. The convoy counts as a single slot toward the fleet target (see npcCount). */
function spawnNpc(players, towns) {
  if (Math.random() < CONVOY_CHANCE) return spawnConvoy(players, towns);
  const { faction, town } = pickHome(towns);
  return makeMerchant(players, town, faction, pick(MERCHANT_SLUGS), null, SKILL_TRADER_SOLO, 'trader');
}

function spawnConvoy(players, towns) {
  const { faction, town } = pickHome(towns);
  const size = CONVOY_MIN + Math.floor(Math.random() * (CONVOY_MAX - CONVOY_MIN + 1));
  const convoyId = 'cvy_' + (++seq);
  const ESCORT_SLOT = 1;   // one follower is an ARMED escort: a veteran brig that fights to protect the traders
  let leader = null;
  for (let i = 0; i < size; i++) {
    // Stagger the spawn positions so the ships don't stack at the pier.
    const ox = (i - (size - 1) / 2) * CONVOY_SPACING, oz = (i % 2 ? 1 : -1) * CONVOY_SPACING * 0.5;
    const isEscort = i === ESCORT_SLOT;
    const slug = isEscort ? 'brig' : pick(MERCHANT_SLUGS);
    const m = makeMerchant(players, town, faction, slug,
      { id: convoyId, role: i === 0 ? 'leader' : 'follower', slot: i, ox, oz },
      isEscort ? SKILL_ESCORT : SKILL_TRADER_CONVOY,
      isEscort ? 'escort' : 'trader');
    if (i === 0) leader = m;
  }
  return leader;
}

/** Route the NPC from its current position to `town`. Returns true if a route was found. */
function routeTo(npc, town) {
  const r = town && nav.findPath(npc.state.x, npc.state.z, town.x, town.z);
  if (r && r.length >= 2) { npc.route = r; npc.routeIdx = 1; npc.legTarget = town.id; return true; }
  npc.route = null; return false;
}

/** Idle wander to a random different town (fallback when there's nothing to trade). */
function wander(npc, towns) {
  for (let tries = 0; tries < 6; tries++) {
    const t = pick(towns);
    if (t.id !== npc.curTownId && routeTo(npc, t)) { npc.phase = 'wander'; return; }
  }
  npc.route = null;
}

/** Demand × faction score for a candidate need: urgency (unmet days + scarcity) plus a home-nation bonus when
 *  the destination — and/or the source — flies the merchant's flag. Jitter spreads the fleet across like needs. */
function scoreNeed(npc, need, srcFaction) {
  const destFaction = (economy.getTown(need.townId) || {}).faction || null;
  let s = need.distressDays * W_DISTRESS + Math.max(0, 1 - need.level) * W_SCARCITY;
  if (npc && npc.faction) {
    if (destFaction === npc.faction) s += OWN_DEST_BONUS;
    if (srcFaction === npc.faction) s += OWN_SRC_BONUS;
  }
  return s + Math.random() * TRIP_JITTER;
}

/** Choose a trade, driven by demand AND nation: among the most urgent shortages (a town low on a good it
 *  consumes), score each by urgency + faction affinity and pick the best with a reachable producer. Merchants
 *  thus prefer to keep goods flowing within their own nation, but a severe enough rival shortage still wins —
 *  "willing to go beyond to get the goods they need." Returns { goodId, srcTownId, destTownId } or null (nothing
 *  needed → the caller idles/wanders). No generic arbitrage — they move only because somewhere needs the cargo. */
function chooseTrip(npc) {
  const needs = economy.needList();
  if (!needs.length) return null;
  let best = null, bestScore = -Infinity;
  for (const need of needs.slice(0, CONSIDER)) {
    const src = economy.bestSellerFor(need.goodId, need.townId);
    if (!src || src.townId === need.townId) continue;          // no reachable producer with stock → skip
    const srcFaction = (economy.getTown(src.townId) || {}).faction || null;
    const score = scoreNeed(npc, need, srcFaction);
    if (score > bestScore) { bestScore = score; best = { goodId: need.goodId, srcTownId: src.townId, destTownId: need.townId }; }
  }
  return best;
}

/** Buy up to the trip's qty at the source (unit-by-unit so partial fills are fine). Returns units bought. */
function doBuy(npc) {
  let bought = 0;
  for (let i = 0; i < npc.trip.qty; i++) {
    if (!economy.npcBuy(npc, npc.trip.srcTownId, npc.trip.goodId, 1).ok) break;
    bought++;
  }
  return bought;
}

/** Sell everything held of the trip good at the destination (unit-by-unit; stops if the town can't afford more). */
function doSell(npc) {
  while ((npc.cargo[npc.trip.goodId] || 0) > 0) {
    if (!economy.npcSell(npc, npc.trip.destTownId, npc.trip.goodId, 1).ok) break;
  }
}

/** Plan a new trip and start sailing to its source (buying immediately if already there). */
function planTrip(npc, towns) {
  npc.route = null; npc.trip = null; npc.phase = null;
  const chosen = chooseTrip(npc);
  if (!chosen) { wander(npc, towns); return; }
  npc.trip = { ...chosen, qty: Math.min(MERCHANT_LOAD, economy.capacityFor(npc.state.vesselSlug)) };
  if (npc.curTownId === chosen.srcTownId) {
    // already at the source → buy + head to the destination
    doBuy(npc);
    const dest = economy.getTown(chosen.destTownId);
    if ((npc.cargo[chosen.goodId] || 0) > 0 && dest && routeTo(npc, dest)) { npc.phase = 'toDest'; return; }
    wander(npc, towns);
  } else {
    const src = economy.getTown(chosen.srcTownId);
    if (routeTo(npc, src)) { npc.phase = 'toSource'; return; }
    wander(npc, towns);
  }
}

/** Reached the end of the current route leg — act on it and start the next leg. */
function onArrive(npc, towns) {
  npc.curTownId = npc.legTarget; npc.route = null; npc.state.speed = 0;
  if (npc.phase === 'toSource' && npc.trip) {
    doBuy(npc);
    const dest = economy.getTown(npc.trip.destTownId);
    if ((npc.cargo[npc.trip.goodId] || 0) > 0 && dest && routeTo(npc, dest)) { npc.phase = 'toDest'; return; }
    planTrip(npc, towns);           // bought nothing / no route → re-plan
  } else if (npc.phase === 'toDest' && npc.trip) {
    doSell(npc);                    // deliver — relieves the shortage on the shared market
    planTrip(npc, towns);
  } else {
    planTrip(npc, towns);           // finished a wander → look for real trade
  }
}

/** Advance every NPC one step (dtSec), steering toward its route + away from other merchants. Pose is sent
 *  separately by broadcastInterest (interest-managed), NOT here. */
function tickNpcs(players, dtSec, broadcastLeave, nowMs, fireShot) {
  const towns = economy.townList();
  if (towns.length < 2) return;
  const fleet = [];
  for (const [, p] of players) if (p.isNpc) fleet.push(p);
  const wind = weatherState.snapshot();   // { windSpeed (m/s), windBearing (deg FROM) } — same wind the player feels

  // CONVOY pre-pass: decide each convoy's SHARED threat + a SINGLE stance, so members react in unison and pool
  // their strength. Shared threat = the attacker ANY member is fighting (provoked → the whole convoy defends it),
  // else the nearest nation-hated player any member detects. convoyId → { foe, provoked, stance }.
  const convoyPlan = new Map();
  const convoyGroups = new Map();
  for (const npc of fleet) {
    if (npc.combat && npc.combat.sunk) continue;
    if (npc.convoyId) { (convoyGroups.get(npc.convoyId) || convoyGroups.set(npc.convoyId, []).get(npc.convoyId)).push(npc); }
  }
  for (const [cid, members] of convoyGroups) {
    let threat = null;
    for (const m of members) { const f = engageTarget(m, players, nowMs); if (f) { threat = { foe: f, provoked: true }; break; } }
    if (!threat) { for (const m of members) { const t = findThreat(m, players, nowMs); if (t) { threat = t; break; } } }
    const stance = threat ? convoyStance(members, threat.foe, threat.provoked, players) : 'route';
    convoyPlan.set(cid, { foe: threat && threat.foe, provoked: !!(threat && threat.provoked), stance });
  }

  for (const npc of fleet) {
    // A sunk merchant (salvage already dropped by resolveHit) lingers briefly so its capsize plays, then despawns.
    if (npc.combat && npc.combat.sunk) {
      if (!npc.sinkAt) npc.sinkAt = nowMs;
      if (nowMs - npc.sinkAt >= SINK_LINGER_MS) { players.delete(npc.id); broadcastLeave(npc.id); }
      continue;
    }

    const ph = npc.physics;
    let desired;
    npc.raking = false;   // re-armed by engageHeading each tick it actually has a rake; cleared otherwise
    // D3: react to the right threat — a PROVOKED attacker (was fired on) or a nation-HATED player within range —
    // with the stance set by RELATIVE STRENGTH: fight if it can hold its own, flee/avoid if outmatched or badly
    // hurt, or just hold the trade lane (route) while a hated stranger lurks beyond ENGAGE_RANGE.
    // Convoy members take the SHARED plan (same foe + stance → unison); solo merchants assess for themselves.
    let threat, stance;
    if (npc.convoyId && convoyPlan.has(npc.convoyId)) {
      const plan = convoyPlan.get(npc.convoyId);
      threat = plan.foe ? { foe: plan.foe, provoked: plan.provoked } : null;
      stance = plan.stance;
      // Every member commits the grudge to the shared foe so its OWN gunnery bears + it gives chase / flees as one.
      if (threat && (stance === 'fight' || stance === 'flee')) markHostile(npc, plan.foe.id, nowMs);
    } else {
      threat = findThreat(npc, players, nowMs);
      stance = threat ? combatStance(npc, threat.foe, threat.provoked) : 'route';
    }
    const foe = (stance === 'fight' || stance === 'flee') ? threat.foe : null;
    if (foe) {
      // Combat helm: jockey for a broadside when fighting (A2), bear off and run when fleeing (A4). BOTH stay
      // "engaged" so the gunnery arc gate can still loose a parting broadside while running. An UNPROVOKED merchant
      // that elects to fight commits a timed grudge so it presses the engagement instead of chattering at the range
      // edge; the grudge lapses (GIVE_UP_RANGE / AGGRO_MS) and it returns to trade once the foe breaks off.
      if (stance === 'fight' && !threat.provoked) markHostile(npc, threat.foe.id, nowMs);
      npc.engaged = true;
      // Convoy roles: when the convoy FIGHTS, the armed ESCORT engages while the cargo TRADERS evade (the escort
      // covers them — a real convoy screen); when it FLEES, everyone runs. A lone trader / escort just does the
      // group stance. (E0 keeps the EVADE simple — flat-out away; E3 adds true interposition / screening.)
      const evade = stance === 'flee' || (npc.convoyId && npc.combatRole === 'trader' && stance === 'fight');
      npc.fleeing = evade;
      desired = evade ? escapeHeading(npc, foe, wind, ph) : engageHeading(npc, foe, wind, ph);
      if (npc.fleeing) {
        // Imperfect helmsman under pressure: a slowly-drifting heading error around the optimal escape line, scaled
        // by skill — a panicky trader wanders badly (easy to run down), a veteran flees on a clean line. CATCH-UP
        // lever, not a stat nerf (hull/sails unchanged).
        npc.fleeWander = (npc.fleeWander || 0) * 0.96 + (Math.random() - 0.5) * fleeWanderAmp(npcSkill(npc));
        desired = (desired + npc.fleeWander + 360) % 360;
      }
    } else {
      npc.engaged = false; npc.fleeing = false;   // no threat (or watching from afar) → sail the trade route
      // A convoy ESCORT just holds formation on the leader (which routes + trades for the group); a leader/solo
      // sails its own trade route. A beheaded escort promotes itself (convoyFollowHeading → null) and falls through.
      let follow = null;
      if (npc.convoyId && npc.convoyRole === 'follower') { follow = convoyFollowHeading(npc, players); }
      if (follow != null) {
        desired = tackedHeading(follow, wind.windBearing, ph.minTackAngle, npc);
      } else {
        if (!npc.route) { planTrip(npc, towns); if (!npc.route) continue; }
        const wp = npc.route[npc.routeIdx];
        const dx = wp.x - npc.state.x, dz = wp.z - npc.state.z, dist = Math.hypot(dx, dz);
        if (dist < ARRIVE_M) {
          if (++npc.routeIdx >= npc.route.length) { onArrive(npc, towns); continue; }   // leg done → trade + next leg
          continue;
        }
        desired = headingTo(npc.state.x, npc.state.z, wp.x, wp.z);
        desired = tackedHeading(desired, wind.windBearing, ph.minTackAngle, npc);   // zig-zag through upwind legs
      }
    }
    const avoid = avoidanceHeading(npc, fleet);
    if (avoid !== null) desired = blendHeading(desired, avoid, 0.45);
    desired = avoidLand(npc, desired);   // never steer through land — round the shore (incl. in combat)

    // Combat attrition slows a merchant EXACTLY like a player: a demasted hull bleeds sail power (mastMul, in
    // the drive coefficient below) and a thinned crew works the sails + helm less effectively (crewMul). Both
    // are the SAME terms the player feels — no NPC-only penalties (so an undamaged merchant matches a player).
    const mastFrac = (npc.combat && npc.combat.maxHp && npc.combat.maxHp.masts)
      ? (npc.combat.zones.masts / npc.combat.maxHp.masts) : 1;
    const mastMul = Cc.mastSpeedMult(mastFrac);
    const crewMul = crewFactor(npc);

    // Helm = the PLAYER'S helm (turn EXACTLY like a same-class player, no instant pivots): speed-dependent max
    // yaw, capped when demasted, scaled by crew (short-handed → slower on the helm, like the player), eased in
    // through angular inertia, never overshooting the desired heading.
    const prev = npc.state.heading;
    let maxYaw = vesselTurnRate(npc.state.speed, ph.maxSpeed);
    if (mastFrac <= 0) maxYaw = Math.min(maxYaw, MAST_DOWN_TURN_MAX);
    maxYaw *= crewMul;                                                // short-handed → slower helm (player parity)
    const delta = angleDelta(prev, desired);                          // signed deg to turn
    const rudder = Math.abs(delta) < 0.5 ? 0 : (delta > 0 ? 1 : -1);
    npc.yawRate = (npc.yawRate || 0) + (rudder * maxYaw - (npc.yawRate || 0)) * Math.min(1, YAW_RESPONSE * dtSec);
    let stepDeg = npc.yawRate * dtSec;
    if (Math.abs(stepDeg) > Math.abs(delta)) { stepDeg = delta; npc.yawRate = dtSec > 0 ? delta / dtSec : 0; }  // settle, don't overshoot
    npc.state.heading = (prev + stepDeg + 360) % 360;
    npc.state.turnRate = angleDelta(prev, npc.state.heading) / dtSec;

    // ── Speed: the PLAYER'S v2 FORCE MODEL (mirrors client vessel.service.physicsStep) so an NPC <type> sails
    // exactly like a player <type>. Apparent wind (true-wind − boat-velocity) → per-rig drive coefficient →
    // thrust ∝ forceK·SAF·driveC·V_app²; drag ∝ DRAG_K·v² + turn scrub; a = (thrust−drag)·response/mass. The
    // ONLY merchant difference: capped at MERCHANT_CRUISE·maxSpeed so they never reach a player's full speed.
    const hrr = npc.state.heading * DEG;
    const vNow = npc.state.speed;
    const bvx = Math.sin(hrr) * vNow, bvz = Math.cos(hrr) * vNow;                  // boat velocity
    const wf  = wind.windBearing * DEG;
    const wvx = -Math.sin(wf) * wind.windSpeed, wvz = -Math.cos(wf) * wind.windSpeed;   // true wind (blows TO = from+180°)
    const axw = wvx - bvx, azw = wvz - bvz;                                        // apparent wind velocity
    const appWind = Math.hypot(axw, azw);
    const cosA = (-axw * Math.sin(hrr) - azw * Math.cos(hrr)) / (appWind || 1);
    const appAngle = Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI;   // 0 = bow into apparent wind
    const eff = npcDrive(appAngle, npc.state.vesselSlug, ph.minTackAngle);         // full-sail, perfect-trim drive (trim=1)
    // Heel spill: an over-pressed sail in a blow spills wind → forward drive falls off (matches the player).
    const heelRaw   = HEEL_K * ph.sailAreaFactor * appWind * appWind * Math.sin(appAngle * DEG);
    const heelSpill = Math.max(0, Math.min(1, (heelRaw - COMFORT_HEEL) / SPILL_RANGE));
    const driveC = eff * mastMul * crewMul * (1 - SPILL_MAX * heelSpill);
    const forceK = FORCE_K_BY_SLUG[npc.state.vesselSlug] || SAIL_FORCE_K;
    const thrust = forceK * ph.sailAreaFactor * driveC * appWind * appWind;
    const drag   = DRAG_K * vNow * Math.abs(vNow) + TURN_SCRUB * Math.abs(npc.yawRate || 0) * Math.abs(vNow);
    const massK  = Math.max(0.2, (ph.weight || WEIGHT_REF) / WEIGHT_REF);
    let sp = vNow + (thrust - drag) * FORCE_RESPONSE / massK * dtSec;
    sp = Math.max(-1.5, Math.min(ph.maxSpeed * MERCHANT_CRUISE, sp));              // merchants never hit full speed
    npc.state.speed = Math.abs(sp) < 0.001 ? 0 : sp;
    npc.state.isPortTack = (((npc.state.heading - wind.windBearing) % 360 + 360) % 360) <= 180;
    const hr = npc.state.heading * DEG, step = npc.state.speed * moveConst.TRAVEL_SCALE * dtSec;
    npc.state.x += Math.sin(hr) * step;
    npc.state.z += Math.cos(hr) * step;
    // keep the authoritative pose in sync so player↔NPC collision (which reads authPose) works
    npc.authPose.x = npc.state.x; npc.authPose.z = npc.state.z;
    npc.authPose.heading = npc.state.heading; npc.authPose.speed = npc.state.speed;
    npc.lastUpdateMs = nowMs;

    // ── Return fire (A3): when engaged, a gun bears, and the reload is up, hand a leading solution to the
    // server's shared shot adjudicator. The reload SCALES WITH CREW (a thinned crew works the guns slower — the
    // same crewMul the player feels via getReloadWindow), and the merchant picks round vs bar shot tactically.
    if (npc.engaged && foe && fireShot && nowMs - (npc.lastShotAt || 0) >= NPC_RELOAD_MS / crewMul) {
      const dist = Math.hypot(foe.state.x - npc.state.x, foe.state.z - npc.state.z);
      const shot = chooseNpcShot(npc, foe, dist);
      const sol = firingSolution(npc, foe.state, Cc.SHOT_TYPES[shot].v);
      if (sol) { fireShot(npc, sol, shot); npc.lastShotAt = nowMs; }
    }
  }
}

/**
 * Interest-managed broadcast: each connected player only receives the MAX_VISIBLE nearest merchants within
 * VIEW_RADIUS — distant ones are never sent, so the client never builds their GLB + crew (the perf lever).
 * Sends an 'update' for each newly/still-visible NPC and a 'leave' for any that dropped out of range.
 */
function broadcastInterest(players, nowMs) {
  const npcs = [];
  for (const [, p] of players) if (p.isNpc) npcs.push(p);
  const msgCache = new Map();
  const msgFor = (n) => {
    let m = msgCache.get(n.id);
    if (!m) { m = JSON.stringify({ type: 'update', id: n.id, ...n.state, npc: true, faction: n.faction || null, ts: nowMs, seq: 0 }); msgCache.set(n.id, m); }
    return m;
  };
  // Full-fleet map feed for staff: Owners/Admins get every merchant's position on the minimap (render is still
  // interest-managed below — this is map markers only, no extra ships built). Built once, reused for all staff.
  let allMsg = null;
  const allMerchantsMsg = () => {
    if (allMsg === null) {
      allMsg = JSON.stringify({
        type: 'all_merchants',
        ships: npcs.map((n) => ({ x: +n.state.x.toFixed(1), z: +n.state.z.toFixed(1) })),
      });
    }
    return allMsg;
  };
  for (const [, p] of players) {
    if (p.isNpc || !p.ws || p.ws.readyState !== 1 || !p.state) continue;
    const near = [];
    let nrX = null, nrZ = null, nrD2 = Infinity;   // the single GLOBAL nearest merchant (any distance, for the map)
    for (const n of npcs) {
      const dx = n.state.x - p.state.x, dz = n.state.z - p.state.z, d2 = dx * dx + dz * dz;
      if (d2 < nrD2) { nrD2 = d2; nrX = n.state.x; nrZ = n.state.z; }
      if (d2 <= VIEW_R2) near.push({ n, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);
    const visible = new Set();
    for (let i = 0; i < near.length && i < MAX_VISIBLE; i++) visible.add(near[i].n.id);
    // Always render this player's tavern-rumour target (so its map marker + hull persist while they hunt it
    // down, even past the normal nearest-N cutoff). Auto-clear the grudge once the ship has despawned/sunk.
    if (p.rumorShipId) {
      if (players.has(p.rumorShipId)) visible.add(p.rumorShipId);
      else p.rumorShipId = null;
    }
    if (!p._visNpcs) p._visNpcs = new Set();
    for (const id of visible) p.ws.send(msgFor(players.get(id)));               // RENDER updates for nearby merchants
    for (const id of p._visNpcs) if (!visible.has(id)) p.ws.send(JSON.stringify({ type: 'leave', id })); // dropped → despawn client-side
    p._visNpcs = visible;
    // Map markers. Staff see the whole fleet; everyone else sees a beacon to the single nearest merchant
    // (position-only, regardless of render distance — no ship is built for a far one).
    const staff = p.auth && (p.auth.role === 'Owner' || p.auth.role === 'Admin');
    if (staff) {
      p.ws.send(allMerchantsMsg());
    } else {
      p.ws.send(nrX === null ? JSON.stringify({ type: 'nearest_merchant', x: null })
        : JSON.stringify({ type: 'nearest_merchant', x: +nrX.toFixed(1), z: +nrZ.toFixed(1) }));
    }
  }
}

/** Keep the merchant fleet topped up to the target size; spawn fresh ships at town piers. */
function spawnerTick(players) {
  const towns = economy.townList();
  if (towns.length < 2) return;
  const target = targetFleet(towns.length);
  let spawned = 0;
  while (npcCount(players) < target && spawned < 3) { spawnNpc(players, towns); spawned++; }   // ramp up gradually
}

module.exports = {
  tickNpcs, broadcastInterest, spawnerTick, targetFleet, npcCount, markHostile, isHostile,
  _test: {
    spawnNpc, planTrip, chooseTrip, scoreNeed, pickFaction, onArrive, tickNpcs, broadcastInterest,
    avoidanceHeading, headingTo, turnToward, blendHeading, angleDelta, VIEW_RADIUS, MAX_VISIBLE,
    setJitter(j) { TRIP_JITTER = j; }, OWN_DEST_BONUS, OWN_SRC_BONUS,
    markHostile, isHostile, AGGRO_MS, engageTarget, engageHeading, angleFromWind, sailEff, npcDrive, FIRE_RANGE,
    firingSolution, NPC_MUZZLE_V, MAX_FIRE_RANGE, FIRE_ARC, NPC_RELOAD_MS,
    escapeHeading, hullFraction, FLEE_HEALTH, GIVE_UP_RANGE,
    shipStrength, hullPoints, repWith, findThreat, combatStance,
    HOSTILE_REP, DETECT_RANGE, ENGAGE_RANGE, AVOID_RATIO,
    spawnConvoy, npcCount, convoyMembers, convoyStance, threatStrength, convoyLeader, convoyFollowHeading,
    CONVOY_CHANCE, CONVOY_MIN, CONVOY_MAX, CONVOY_SQUAD_RANGE,
    npcSkill, fleeHealthFor, avoidRatioFor, aimSpreadMul, fleeWanderAmp,
    SKILL_TRADER_SOLO, SKILL_TRADER_CONVOY, SKILL_ESCORT,
    chooseNpcShot, foeMastFrac, RAKE_CONE, RAKE_SKILL,
  },
};
