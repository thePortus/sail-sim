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
const { getVesselDef } = require('./controllers/vessels.controller');
const weatherState = require('./weather-state');   // server-authoritative wind (speed + bearing)

const DEG = Math.PI / 180;
const MERCHANT_SLUGS = ['sloop', 'pinnace'];
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
function npcCount(players) { let n = 0; for (const [, p] of players) if (p.isNpc) n++; return n; }

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

// ── Wind sailing model — MIRRORS the player's VesselService.sailEfficiency so merchants are bound by the
// exact same wind envelope (no more flat "insanely fast" cruise). NPCs sail full-canvas, perfectly trimmed.

/** Angle (deg) between a heading and the wind's FROM-bearing, in [0,180] — 0 = bow into the wind. */
function angleFromWind(heading, windBearing) {
  const d = ((heading - windBearing) % 360 + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Point-of-sail efficiency curve (identical thresholds/multipliers to the player). <minTack = no-go zone. */
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

// ── Tactical helm (A2) ────────────────────────────────────────────────────────────────────────────────────
// A hostile merchant abandons its trade route and jockeys to lay a broadside on its attacker. It steers for a
// heading perpendicular to the bearing-to-target (a clean side-on shot), closing when out of range and opening
// when too near so it never bow-rushes. Crucially it's still bound by the wind: of the two broadside options
// (target ±90°) it commits to whichever sails better in the current wind, so a merchant pinned on a bad point
// of sail manoeuvres realistically rather than magically holding the slot.
const FIRE_RANGE = 150;       // world units: ideal broadside standoff (well within round-shot reach) — tunable
const BROADSIDE_HYST = 0.12;  // point-of-sail-efficiency margin the other tack must beat to flip the broadside side
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

/** Desired heading to present a broadside to `foeState`, biased to close/open toward FIRE_RANGE and to take the
 *  more sailable of the two beam options in the current wind (with hysteresis so it doesn't chatter tacks). */
function engageHeading(npc, foeState, wind, ph) {
  const B = headingTo(npc.state.x, npc.state.z, foeState.x, foeState.z);
  const dist = Math.hypot(foeState.x - npc.state.x, foeState.z - npc.state.z);
  let offset;
  if (dist > FIRE_RANGE * 1.3)      offset = 55;    // well out → angle in to close (not a bow-on charge)
  else if (dist < FIRE_RANGE * 0.7) offset = 120;   // too near → open out, avoid fouling / ramming
  else                              offset = 90;     // in the slot → hold a clean broadside (orbits at range)
  const hPlus  = (B + offset + 360) % 360;
  const hMinus = (B - offset + 360) % 360;
  const effPlus  = sailEff(angleFromWind(hPlus,  wind.windBearing), ph.minTackAngle);
  const effMinus = sailEff(angleFromWind(hMinus, wind.windBearing), ph.minTackAngle);
  let side = (npc.broadsideSide === 1 || npc.broadsideSide === -1) ? npc.broadsideSide
           : (effPlus >= effMinus ? 1 : -1);
  if      (side === 1  && effMinus > effPlus  + BROADSIDE_HYST) side = -1;
  else if (side === -1 && effPlus  > effMinus + BROADSIDE_HYST) side = 1;
  npc.broadsideSide = side;
  return side === 1 ? hPlus : hMinus;
}

/**
 * Flee helm (A4): a badly-hurt merchant runs for it. Picks the heading that best trades off OPENING distance
 * from the foe against SPEED — so it doesn't blindly point straight away onto a dead-slow upwind beat; it bears
 * off downwind onto a fast broad reach that still carries it clear. (It keeps firing opportunistically: the
 * gunnery's arc gate lets a stern-chasing foe eat a parting broadside whenever it swings abeam — no extra code.)
 */
function escapeHeading(npc, foeState, wind, ph) {
  const away = (headingTo(npc.state.x, npc.state.z, foeState.x, foeState.z) + 180) % 360;   // straight away from foe
  const awayX = Math.sin(away * DEG), awayZ = Math.cos(away * DEG);
  // Maximise the OUTBOUND velocity component = boat speed × (heading · away). Sweeping all headings finds the
  // fastest way to actually pull clear: if dead-away is upwind (slow), it bears off onto a reach that opens
  // distance faster despite the angle; if away is downwind, it just runs. In-irons efficiency is clamped to 0
  // (a stalled heading makes no progress, however "away" it points).
  let best = away, bestRate = -Infinity;
  for (let h = 0; h < 360; h += 15) {
    const opening = Math.sin(h * DEG) * awayX + Math.cos(h * DEG) * awayZ;   // -1 (toward foe) .. 1 (dead away)
    const rate = Math.max(0, sailEff(angleFromWind(h, wind.windBearing), ph.minTackAngle)) * opening;
    if (rate > bestRate) { bestRate = rate; best = h; }
  }
  return best;
}

// ── Gunnery (A3) — the merchant returns fire ────────────────────────────────────────────────────────────────
// When a gun bears (target roughly abeam) and within range, the NPC computes a leading ballistic solution at
// fixed muzzle speed, scatters it for moderate accuracy, and hands the shot to the server's shared adjudicator
// (same activeShots the player feeds — so the merchant's ball can be dodged exactly like a player's). Everything
// is in COMBAT world units (HALF_BEAM/G/TRAVEL_SCALE), NOT the GLB-scale cannon offsets in the vessel def.
const NPC_MUZZLE_V    = Cc.SHOT_TYPES.round.v;  // 55 u/s — NPCs fire solid round shot (anti-hull)
const FIRE_ARC        = 50;        // deg off pure-beam the target may be for a gun to bear
const MAX_FIRE_RANGE  = 260;       // world units: don't open fire beyond this (well inside round-shot max reach)
const NPC_RELOAD_MS   = 4200;      // min ms between a merchant's shots (one aimed ball per reload — deliberately unhurried)
const NPC_AZ_SPREAD   = 4.5;       // deg: half-width of random bearing scatter (moderate accuracy → dodgeable)
const NPC_EL_SPREAD   = 2.0;       // deg: half-width of random elevation scatter
const MUZZLE_Y        = 2.6;       // gun height above the waterline (world units, ~deck)
const AIM_Y           = 1.4;       // aim point on the target hull (mid-freeboard)

/** Uniform scatter in [-half, half] degrees, returned in radians. */
function spreadRad(halfDeg) { return (Math.random() * 2 - 1) * halfDeg * DEG; }

/**
 * Leading ballistic firing solution against a moving target, or null if no gun bears / target is out of range /
 * the range is unreachable at muzzle speed. Iterates the lead (aim where the target WILL be after the ball's
 * flight), solves the low-arc launch elevation for that range + height drop, then adds azimuth/elevation
 * scatter. Speed of the returned velocity stays exactly NPC_MUZZLE_V, so it sits in the round-shot band.
 * Returns world-space { ox, oy, oz, vx, vy, vz }.
 */
function firingSolution(npc, foeState) {
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
  const v = NPC_MUZZLE_V, v2 = v * v, dY = AIM_Y - MUZZLE_Y;

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
  const az = Math.atan2(px - ox, pz - oz) + spreadRad(NPC_AZ_SPREAD);
  const el = theta + spreadRad(NPC_EL_SPREAD);
  const vhs = v * Math.cos(el);
  return { ox, oy: MUZZLE_Y, oz, vx: vhs * Math.sin(az), vy: v * Math.sin(el), vz: vhs * Math.cos(az) };
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

function spawnNpc(players, towns) {
  const faction = pickFaction(towns);
  // Prefer to spawn at one of its own nation's towns (falls back to anywhere if it holds none yet).
  const home = towns.filter((t) => t.faction === faction);
  const town = pick(home.length ? home : towns);
  const slug = pick(MERCHANT_SLUGS);
  const id = 'npc_' + (++seq);
  const npc = {
    id, isNpc: true, ws: { readyState: 3 }, faction,
    state: {
      x: town.x, z: town.z, heading: 0, speed: 0, turnRate: 0, sheetAngle: 0,
      isPortTack: false, anchored: false, sailState: 'full',
      vesselName: 'Merchant ' + pick(MERCHANT_NAMES), vesselSlug: slug, callsign: '',
    },
    authPose: { x: town.x, z: town.z, heading: 0, speed: 0 },
    combat: combat.newCombatState(slug),
    lastUpdateMs: Date.now(),
    physics: getVesselDef(slug)?.physics || { maxSpeed: 8, accelerationRate: 0.28, minTackAngle: 36, sailAreaFactor: 0.34 },
    tack: 1,   // current tack (+1/−1) for upwind zig-zagging
    route: null, routeIdx: 0, curTownId: town.id, legTarget: null,
    gold: SEED_GOLD, cargo: {}, trip: null, phase: null,   // trip = {goodId,srcTownId,destTownId,qty}; phase = toSource|toDest
    // NP-combat: set by markHostile() when this merchant is hit; consumed by the tactical helm + gunnery (A2–A4).
    hostileToward: null, aggroUntil: 0, lastShotAt: 0, shotSeq: 0,
  };
  players.set(id, npc);
  return npc;
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

  for (const npc of fleet) {
    // A sunk merchant (salvage already dropped by resolveHit) lingers briefly so its capsize plays, then despawns.
    if (npc.combat && npc.combat.sunk) {
      if (!npc.sinkAt) npc.sinkAt = nowMs;
      if (nowMs - npc.sinkAt >= SINK_LINGER_MS) { players.delete(npc.id); broadcastLeave(npc.id); }
      continue;
    }

    const ph = npc.physics;
    let desired;
    const foe = engageTarget(npc, players, nowMs);   // hostile + live attacker → fight; else trade route
    if (foe) {
      // ── Combat helm: drop the route to fight. Healthy → jockey for a broadside (A2); once the hull is shot
      // below FLEE_HEALTH it commits to running (A4) — hull doesn't self-heal, so the decision never flip-flops.
      // The route is left untouched so the merchant resumes its trade run once it disengages (escapes / lapses).
      npc.engaged = true;
      if (!npc.fleeing && hullFraction(npc.combat) < FLEE_HEALTH) npc.fleeing = true;
      desired = npc.fleeing ? escapeHeading(npc, foe.state, wind, ph) : engageHeading(npc, foe.state, wind, ph);
    } else {
      npc.engaged = false; npc.fleeing = false;   // disengaged → clear the flee commitment
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
    const avoid = avoidanceHeading(npc, fleet);
    if (avoid !== null) desired = blendHeading(desired, avoid, 0.45);
    const prev = npc.state.heading;
    npc.state.heading = turnToward(prev, desired, moveConst.TURN_CAP_DEG * dtSec);
    npc.state.turnRate = angleDelta(prev, npc.state.heading) / dtSec;

    // Speed from wind strength × point of sail — the EXACT player envelope (full sail, perfect trim, no
    // gust). Eased toward target like the player so it accelerates/decelerates smoothly through tacks.
    const aw     = angleFromWind(npc.state.heading, wind.windBearing);
    const target = Math.max(-1.5, Math.min(ph.maxSpeed, wind.windSpeed * sailEff(aw, ph.minTackAngle) * ph.sailAreaFactor));
    npc.state.speed += (target - npc.state.speed) * Math.min(1, ph.accelerationRate * dtSec);
    npc.state.isPortTack = (((npc.state.heading - wind.windBearing) % 360 + 360) % 360) <= 180;
    const hr = npc.state.heading * DEG, step = npc.state.speed * moveConst.TRAVEL_SCALE * dtSec;
    npc.state.x += Math.sin(hr) * step;
    npc.state.z += Math.cos(hr) * step;
    // keep the authoritative pose in sync so player↔NPC collision (which reads authPose) works
    npc.authPose.x = npc.state.x; npc.authPose.z = npc.state.z;
    npc.authPose.heading = npc.state.heading; npc.authPose.speed = npc.state.speed;
    npc.lastUpdateMs = nowMs;

    // ── Return fire (A3): when engaged, a gun bears, and the reload is up, hand a leading solution to the
    // server's shared shot adjudicator. Fires at most one aimed ball per NPC_RELOAD_MS.
    if (npc.engaged && foe && fireShot && nowMs - (npc.lastShotAt || 0) >= NPC_RELOAD_MS) {
      const sol = firingSolution(npc, foe.state);
      if (sol) { fireShot(npc, sol, 'round'); npc.lastShotAt = nowMs; }
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
    markHostile, isHostile, AGGRO_MS, engageTarget, engageHeading, angleFromWind, sailEff, FIRE_RANGE,
    firingSolution, NPC_MUZZLE_V, MAX_FIRE_RANGE, FIRE_ARC, NPC_RELOAD_MS,
    escapeHeading, hullFraction, FLEE_HEALTH, GIVE_UP_RANGE,
  },
};
