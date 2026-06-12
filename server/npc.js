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

function spawnNpc(players, towns) {
  const town = pick(towns);
  const slug = pick(MERCHANT_SLUGS);
  const id = 'npc_' + (++seq);
  const npc = {
    id, isNpc: true, ws: { readyState: 3 },
    state: {
      x: town.x, z: town.z, heading: 0, speed: 0, turnRate: 0, sheetAngle: 0,
      isPortTack: false, anchored: false, sailState: 'full',
      vesselName: 'Merchant ' + pick(MERCHANT_NAMES), vesselSlug: slug, callsign: '',
    },
    authPose: { x: town.x, z: town.z, heading: 0, speed: 0 },
    combat: combat.newCombatState(slug),
    lastUpdateMs: Date.now(),
    cruise: (getVesselDef(slug)?.physics?.maxSpeed || 8) * CRUISE_FRAC,
    route: null, routeIdx: 0, curTownId: town.id, destTownId: null,
    gold: 0, cargo: {}, trip: null,   // populated in NP3
  };
  players.set(id, npc);
  return npc;
}

/** NP2 placeholder: route to a random different town. (NP3 replaces this with planTrip — buy→deliver.) */
function planMove(npc, towns) {
  for (let tries = 0; tries < 6; tries++) {
    const t = pick(towns);
    if (t.id === npc.curTownId) continue;
    const r = nav.findPath(npc.state.x, npc.state.z, t.x, t.z);
    if (r && r.length >= 2) { npc.route = r; npc.routeIdx = 1; npc.destTownId = t.id; return; }
  }
  npc.route = null;
}

/** Advance every NPC one step (dtSec), steering toward its route + away from other merchants. Pose is sent
 *  separately by broadcastInterest (interest-managed), NOT here. */
function tickNpcs(players, dtSec, broadcastLeave, nowMs) {
  const towns = economy.townList();
  if (towns.length < 2) return;
  const fleet = [];
  for (const [, p] of players) if (p.isNpc) fleet.push(p);

  for (const npc of fleet) {
    // A sunk merchant despawns (NP4 will instead drop salvage here first).
    if (npc.combat && npc.combat.sunk) { players.delete(npc.id); broadcastLeave(npc.id); continue; }

    if (!npc.route) { planMove(npc, towns); if (!npc.route) continue; }
    const wp = npc.route[npc.routeIdx];
    const dx = wp.x - npc.state.x, dz = wp.z - npc.state.z, dist = Math.hypot(dx, dz);
    if (dist < ARRIVE_M) {
      if (++npc.routeIdx >= npc.route.length) {   // arrived at the destination town
        npc.curTownId = npc.destTownId; npc.route = null; npc.state.speed = 0;
        continue;                                  // NP3: trade here, then plan the next trip
      }
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
    if (!m) { m = JSON.stringify({ type: 'update', id: n.id, ...n.state, npc: true, ts: nowMs, seq: 0 }); msgCache.set(n.id, m); }
    return m;
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
    // Map beacon: the nearest merchant's position regardless of render distance (no ship is built for it).
    p.ws.send(nrX === null ? JSON.stringify({ type: 'nearest_merchant', x: null })
      : JSON.stringify({ type: 'nearest_merchant', x: +nrX.toFixed(1), z: +nrZ.toFixed(1) }));
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
  _test: { spawnNpc, planMove, tickNpcs, broadcastInterest, avoidanceHeading, headingTo, turnToward, blendHeading, angleDelta, VIEW_RADIUS, MAX_VISIBLE },
};
