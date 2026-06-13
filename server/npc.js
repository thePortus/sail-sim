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
const factions = require('./factions');
const moveConst = require('./movement-constants');
const { getVesselDef } = require('./controllers/vessels.controller');

const DEG = Math.PI / 180;
const MERCHANT_SLUGS = ['sloop', 'pinnace'];
const MERCHANT_NAMES = ['Gull', 'Albatross', 'Petrel', 'Sea Marten', 'Wandering Star', 'Dutch Maid', 'Saltbox',
  'Tradewind', 'Far Cathay', 'Indiaman', 'Carrack', 'Lateen', 'Fair Profit', 'Doubloon', 'Marianne'];
const CRUISE_FRAC = 0.7;     // merchants cruise below max
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
let seq = 0;

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function targetFleet(townCount) { return Math.max(8, Math.min(15, Math.round(townCount * 0.25))); }
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
    cruise: (getVesselDef(slug)?.physics?.maxSpeed || 8) * CRUISE_FRAC,
    route: null, routeIdx: 0, curTownId: town.id, legTarget: null,
    gold: SEED_GOLD, cargo: {}, trip: null, phase: null,   // trip = {goodId,srcTownId,destTownId,qty}; phase = toSource|toDest
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
function tickNpcs(players, dtSec, broadcastLeave, nowMs) {
  const towns = economy.townList();
  if (towns.length < 2) return;
  const fleet = [];
  for (const [, p] of players) if (p.isNpc) fleet.push(p);

  for (const npc of fleet) {
    // A sunk merchant (salvage already dropped by resolveHit) lingers briefly so its capsize plays, then despawns.
    if (npc.combat && npc.combat.sunk) {
      if (!npc.sinkAt) npc.sinkAt = nowMs;
      if (nowMs - npc.sinkAt >= SINK_LINGER_MS) { players.delete(npc.id); broadcastLeave(npc.id); }
      continue;
    }

    if (!npc.route) { planTrip(npc, towns); if (!npc.route) continue; }
    const wp = npc.route[npc.routeIdx];
    const dx = wp.x - npc.state.x, dz = wp.z - npc.state.z, dist = Math.hypot(dx, dz);
    if (dist < ARRIVE_M) {
      if (++npc.routeIdx >= npc.route.length) { onArrive(npc, towns); continue; }   // leg done → trade + next leg
      continue;
    }
    let desired = headingTo(npc.state.x, npc.state.z, wp.x, wp.z);
    const avoid = avoidanceHeading(npc, fleet);
    if (avoid !== null) desired = blendHeading(desired, avoid, 0.45);
    const prev = npc.state.heading;
    npc.state.heading = turnToward(prev, desired, moveConst.TURN_CAP_DEG * dtSec);
    npc.state.turnRate = angleDelta(prev, npc.state.heading) / dtSec;
    npc.state.speed = npc.cruise;
    const hr = npc.state.heading * DEG, step = npc.cruise * moveConst.TRAVEL_SCALE * dtSec;
    npc.state.x += Math.sin(hr) * step;
    npc.state.z += Math.cos(hr) * step;
    // keep the authoritative pose in sync so player↔NPC collision (which reads authPose) works
    npc.authPose.x = npc.state.x; npc.authPose.z = npc.state.z;
    npc.authPose.heading = npc.state.heading; npc.authPose.speed = npc.state.speed;
    npc.lastUpdateMs = nowMs;
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
  tickNpcs, broadcastInterest, spawnerTick, targetFleet, npcCount,
  _test: {
    spawnNpc, planTrip, chooseTrip, scoreNeed, pickFaction, onArrive, tickNpcs, broadcastInterest,
    avoidanceHeading, headingTo, turnToward, blendHeading, angleDelta, VIEW_RADIUS, MAX_VISIBLE,
    setJitter(j) { TRIP_JITTER = j; }, OWN_DEST_BONUS, OWN_SRC_BONUS,
  },
};
