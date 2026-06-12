'use strict';

/**
 * Server-authoritative town economy (Town Economy — Phase 1).
 *
 * Loads the harbor towns from the terrain manifest once (id → {x,z,tier,specialty,name}), answers "is the
 * player docked at town T?" from the server-validated pose, quotes a town's market (static, from
 * trade-goods.js), and applies buy/sell/repair against an in-memory player {gold, cargo, tradeLedger}.
 *
 * IMPORTANT: every mutation here uses the SERVER's authPose (never client-sent position) and validates
 * atomically (no partial fills). The CALLER persists the mutated player to the DB (persist-on-trade). Phase 1
 * towns have infinite liquidity at the static price — stock/treasuries/dynamics arrive in Phase 2.
 */

const fs = require('fs');
const path = require('path');
const terrainConfig = require('./config/terrain.config');
const goods = require('./trade-goods');
const { getVesselDef } = require('./controllers/vessels.controller');

const DOCK_RADIUS_M = 70;         // generous: anti-cheat backstop, never tighter than the client dock test
const LEDGER_MAX = 50;            // keep the per-player ledger bounded

let loaded = false;
let towns = new Map();            // townId → { id, name, tier, specialty, x, z }

function load() {
  loaded = true;
  towns = new Map();
  try {
    const manifestPath = path.join(terrainConfig.outputDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) { console.warn('[economy] manifest not found — trading disabled'); return; }
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const h of (m.harbors || [])) {
      towns.set(h.id, { id: h.id, name: h.name, tier: h.tier || 'medium', specialty: h.specialty || 'port', x: h.x, z: h.z });
    }
    // Trade-web sanity: log the specialties present so we can confirm every consumed good has a producer.
    const present = new Set([...towns.values()].map((t) => t.specialty));
    const missing = goods.specialtyKeys().filter((s) => !present.has(s));
    console.log(`[economy] ${towns.size} town market(s) loaded; specialties: ${[...present].sort().join(', ')}`
      + (missing.length ? ` — MISSING ${missing.join(', ')}` : ' — full trade web'));
  } catch (err) {
    towns = new Map();
    console.warn('[economy] manifest load failed — trading disabled:', err.message);
  }
}

function ensureLoaded() { if (!loaded) load(); }

/** The town a (server-validated) position is docked at, or null. Nearest harbor within DOCK_RADIUS_M. */
function townAt(x, z) {
  ensureLoaded();
  let best = null, bestD = DOCK_RADIUS_M * DOCK_RADIUS_M;
  for (const t of towns.values()) {
    const dx = x - t.x, dz = z - t.z, d = dx * dx + dz * dz;
    if (d <= bestD) { bestD = d; best = t; }
  }
  return best;
}

function getTown(townId) { ensureLoaded(); return towns.get(townId) || null; }

/** The market a town quotes: { townId, name, specialty, goods:[{goodId,name,ask,bid}] } or null. */
function marketFor(townId) {
  const t = getTown(townId);
  if (!t) return null;
  return { townId: t.id, name: t.name, specialty: t.specialty, goods: goods.market(t.specialty, t.tier) };
}

// ── cargo helpers (cargo is a JSON object { goodId: qty }) ─────────────────────
function parseCargo(text) {
  if (!text) return {};
  try { const o = JSON.parse(text); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
  catch { return {}; }
}
function usedSlots(cargo) {
  let n = 0;
  for (const [g, q] of Object.entries(cargo || {})) n += goods.goodVolume(g) * (q || 0);
  return n;
}
function capacityFor(vesselSlug) { return getVesselDef(vesselSlug)?.cargo ?? 20; }

function pushLedger(player, entry) {
  if (!Array.isArray(player.tradeLedger)) player.tradeLedger = [];
  player.tradeLedger.push(entry);
  if (player.tradeLedger.length > LEDGER_MAX) player.tradeLedger.splice(0, player.tradeLedger.length - LEDGER_MAX);
}

/** Validate the player is docked at townId per the SERVER pose. Returns the town or null. */
function dockedTown(authPose, townId) {
  if (!authPose) return null;
  const here = townAt(authPose.x, authPose.z);
  return (here && here.id === townId) ? here : null;
}

function intQty(qty) {
  const n = Math.floor(Number(qty));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Player buys `qty` of `goodId` at town `townId`. Mutates player.gold/player.cargo/player.tradeLedger.
 * Returns { ok:true, unit } or { ok:false, reason }.
 */
function applyBuy(player, authPose, townId, goodId, qty) {
  const town = dockedTown(authPose, townId);
  if (!town) return { ok: false, reason: 'not_docked' };
  if (!goods.isGood(goodId)) return { ok: false, reason: 'bad_good' };
  const n = intQty(qty);
  if (!n) return { ok: false, reason: 'bad_qty' };
  const price = goods.priceFor(town.specialty, goodId, town.tier);
  if (!price) return { ok: false, reason: 'bad_good' };
  const cost = price.ask * n;
  if (player.gold < cost) return { ok: false, reason: 'no_gold' };
  const cap = capacityFor(player.state && player.state.vesselSlug);
  if (usedSlots(player.cargo) + goods.goodVolume(goodId) * n > cap) return { ok: false, reason: 'no_space' };
  // commit
  player.gold -= cost;
  player.cargo[goodId] = (player.cargo[goodId] || 0) + n;
  pushLedger(player, { t: Date.now(), side: 'buy', townId, goodId, qty: n, unit: price.ask });
  return { ok: true, unit: price.ask };
}

/**
 * Player sells `qty` of `goodId` at town `townId`. Mutates player.gold/player.cargo/player.tradeLedger.
 * Returns { ok:true, unit } or { ok:false, reason }.
 */
function applySell(player, authPose, townId, goodId, qty) {
  const town = dockedTown(authPose, townId);
  if (!town) return { ok: false, reason: 'not_docked' };
  if (!goods.isGood(goodId)) return { ok: false, reason: 'bad_good' };
  const n = intQty(qty);
  if (!n) return { ok: false, reason: 'bad_qty' };
  const held = player.cargo[goodId] || 0;
  if (held < n) return { ok: false, reason: 'no_goods' };
  const price = goods.priceFor(town.specialty, goodId, town.tier);
  if (!price) return { ok: false, reason: 'bad_good' };
  // commit
  player.gold += price.bid * n;
  const left = held - n;
  if (left > 0) player.cargo[goodId] = left; else delete player.cargo[goodId];
  pushLedger(player, { t: Date.now(), side: 'sell', townId, goodId, qty: n, unit: price.bid });
  return { ok: true, unit: price.bid };
}

/** Dock repair — deduct the flat fee. Returns { ok:false } if the player can't afford it. */
function applyRepair(player) {
  if (player.gold < goods.REPAIR_FEE) return { ok: false, fee: goods.REPAIR_FEE };
  player.gold -= goods.REPAIR_FEE;
  return { ok: true, fee: goods.REPAIR_FEE };
}

module.exports = {
  load, ensureLoaded, townAt, getTown, marketFor,
  parseCargo, usedSlots, capacityFor,
  applyBuy, applySell, applyRepair,
  REPAIR_FEE: goods.REPAIR_FEE, STARTING_GOLD: goods.STARTING_GOLD, DOCK_RADIUS_M,
};
