'use strict';

/**
 * Server-authoritative town economy (Town Economy — Phase 2: LIVE).
 *
 * Loads harbor towns from the terrain manifest, holds per-town LIVE market state (per-good stock + a gold
 * treasury), and prices every good purely from STOCK relative to its price-neutral anchor (priceRef): surplus
 * → cheap, scarcity → dear (see trade-goods.quote). Two timescales: a slow once-per-in-game-day tick nudges
 * stock (production/consumption) and regenerates treasuries; the player's trades are the sharp signal — each
 * unit walks the price (marginal), buying is limited by town STOCK, selling by town TREASURY.
 *
 * State persists to a singleton DB row per MAP_VERSION (reset on map regen) with downtime catch-up. Player
 * purse/cargo are persisted separately + inline by multiplayer.js (money safety); town drift is benign to lose
 * on a crash, so it flushes periodically + on tick + on shutdown.
 *
 * The per-good PROFILE (role/priceRef/rate/cap) is derived from config every load, NOT persisted — only live
 * `stock` + `treasury` are stored, so retuning the config re-derives prices from the saved stock.
 */

const fs = require('fs');
const path = require('path');
const terrainConfig = require('./config/terrain.config');
const moveConst = require('./movement-constants');
const goods = require('./trade-goods');
const { getVesselDef } = require('./controllers/vessels.controller');

const DOCK_RADIUS_M = 70;         // generous: anti-cheat backstop, never tighter than the client dock test
const LEDGER_MAX = 50;            // keep the per-player ledger bounded
const SECS_PER_DAY = 1440;        // 1 in-game day = 1440 real seconds (matches the client day/night cycle)
const MAX_CATCHUP_DAYS = 30;      // cap downtime simulation so a long outage doesn't run away
const MIN_STOCK = 1;              // a town never sells its last unit (also avoids div-by-zero in pricing)

let loaded = false;
let towns = new Map();            // townId → { id, name, tier, specialty, x, z }
let markets = new Map();          // townId → { stock: { goodId: qty }, treasury }
let profiles = new Map();         // townId → { goodId: {role,ratePerDay,priceRef,stockCap,seedStock} }  (derived)
let lastTickDay = 0;
let dirty = false;

// ── manifest towns ────────────────────────────────────────────────────────────
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
function ensureSeeded() { ensureLoaded(); if (markets.size === 0 && towns.size > 0) seedMarkets(); }

// ── per-town derived profile + seeding ─────────────────────────────────────────
function profileFor(town) {
  let p = profiles.get(town.id);
  if (!p) {
    p = {};
    for (const g of goods.GOODS) p[g.id] = goods.townGoodProfile(town.specialty, town.tier, g.id);
    profiles.set(town.id, p);
  }
  return p;
}

/** Fresh economy at equilibrium: every town seeded at its per-good seedStock + its tier's starting treasury. */
function seedMarkets() {
  markets = new Map();
  for (const t of towns.values()) {
    const prof = profileFor(t);
    const stock = {};
    for (const g of goods.GOODS) stock[g.id] = Math.round(prof[g.id].seedStock);
    markets.set(t.id, { stock, treasury: goods.TREASURY0[t.tier] ?? goods.TREASURY0.medium });
  }
}

// ── time ────────────────────────────────────────────────────────────────────
function economyDayAt(ms) { return Math.floor(ms / 1000 / SECS_PER_DAY); }
function economyDay() { return economyDayAt(Date.now()); }

/** Advance the economy by exactly `days` in-game days (production/consumption + treasury regen). Pure on state. */
function tick(days) {
  if (!(days > 0)) return;
  ensureSeeded();
  for (const t of towns.values()) {
    const prof = profileFor(t);
    const mk = markets.get(t.id);
    if (!mk) continue;
    for (const g of goods.GOODS) {
      const pr = prof[g.id];
      const s = mk.stock[g.id] ?? 0;
      if (pr.role === 'produced') mk.stock[g.id] = Math.min(pr.stockCap, s + pr.ratePerDay * days);
      else if (pr.role === 'consumed') mk.stock[g.id] = Math.max(0, s - pr.ratePerDay * days);
    }
    const T0 = goods.TREASURY0[t.tier] ?? goods.TREASURY0.medium;
    mk.treasury = Math.min(T0, mk.treasury + goods.TREASURY_REGEN * (T0 - mk.treasury) * days);
  }
  dirty = true;
}

/** Fire the daily tick if the wall-clock day rolled over (idempotent — a no-op 1439/1440 of the second-ticks).
 *  Catch-up after downtime is the same path, clamped to MAX_CATCHUP_DAYS. */
function tickToToday() {
  ensureSeeded();
  const today = economyDay();
  if (today <= lastTickDay) return;
  tick(Math.min(MAX_CATCHUP_DAYS, today - lastTickDay));
  lastTickDay = today;   // advance fully even when the simulated span was clamped
  dirty = true;
}

// ── lookups / quotes ────────────────────────────────────────────────────────
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

/** All towns as a plain array (for NPC spawning/routing). */
function townList() { ensureLoaded(); return [...towns.values()]; }

/** Live market quote for a town: per good { goodId, name, ask, bid, level, role }. level = stock/priceRef
 *  (1 ≈ neutral, <1 scarce/dear, >1 abundant/cheap) — a scarcity hint for the UI. */
function marketFor(townId) {
  const t = getTown(townId);
  if (!t) return null;
  ensureSeeded();
  const prof = profileFor(t);
  const mk = markets.get(t.id);
  const list = goods.GOODS.map((g) => {
    const pr = prof[g.id];
    const stock = mk ? (mk.stock[g.id] ?? 0) : pr.seedStock;
    const q = goods.quote(g.base, pr.priceRef, stock, t.tier);
    const level = +Math.max(0, Math.min(3, stock / pr.priceRef)).toFixed(2);
    return { goodId: g.id, name: g.name, ask: q.ask, bid: q.bid, level, role: pr.role };
  });
  return { townId: t.id, name: t.name, specialty: t.specialty, goods: list };
}

// ── demand hints (Phase 3) ────────────────────────────────────────────────────
/** The town currently paying the highest BID for `goodId` (a scarce consumer) — the best place to SELL it.
 *  Excludes `excludeTownId` (the town giving the hint). Returns { townId, townName, bid } or null. */
function bestBuyerFor(goodId, excludeTownId) {
  ensureSeeded();
  let best = null;
  for (const t of towns.values()) {
    if (t.id === excludeTownId) continue;
    const mk = marketFor(t.id);
    const row = mk && mk.goods.find((g) => g.goodId === goodId);
    if (row && (!best || row.bid > best.bid)) best = { townId: t.id, townName: t.name, bid: row.bid };
  }
  return best;
}

/** A trade rumour for a town: among the goods it PRODUCES (its exports), the one with the best buyer elsewhere
 *  right now → { goodId, goodName, townId, townName, bid }. null if the town produces nothing / no buyer. */
function hintFor(townId) {
  const t = getTown(townId);
  if (!t) return null;
  const prof = profileFor(t);
  let best = null;
  for (const g of goods.GOODS) {
    if (prof[g.id].role !== 'produced') continue;
    const buyer = bestBuyerFor(g.id, townId);
    if (buyer && (!best || buyer.bid > best.bid)) {
      best = { goodId: g.id, goodName: g.name, townId: buyer.townId, townName: buyer.townName, bid: buyer.bid };
    }
  }
  return best;
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

/** The goods catalogue [{id,name}] — sent to the client so it can label cargo anywhere (e.g. the inventory
 *  panel) without a market loaded. */
function goodsCatalog() { return goods.GOODS.map((g) => ({ id: g.id, name: g.name })); }

function pushLedger(player, entry) {
  if (!Array.isArray(player.tradeLedger)) player.tradeLedger = [];
  player.tradeLedger.push(entry);
  if (player.tradeLedger.length > LEDGER_MAX) player.tradeLedger.splice(0, player.tradeLedger.length - LEDGER_MAX);
}
function dockedTown(authPose, townId) {
  if (!authPose) return null;
  const here = townAt(authPose.x, authPose.z);
  return (here && here.id === townId) ? here : null;
}
function intQty(qty) { const n = Math.floor(Number(qty)); return Number.isFinite(n) && n > 0 ? n : 0; }

// ── trades (marginal; mutate player + town market) ─────────────────────────────
/** Player buys `qty` of `goodId`. Marginal: each unit walks the ask up as town stock drops. Limited by town
 *  STOCK (town_out), player gold (no_gold) + capacity (no_space). Atomic. */
function applyBuy(player, authPose, townId, goodId, qty) {
  const town = dockedTown(authPose, townId);
  if (!town) return { ok: false, reason: 'not_docked' };
  if (!goods.isGood(goodId)) return { ok: false, reason: 'bad_good' };
  const n = intQty(qty);
  if (!n) return { ok: false, reason: 'bad_qty' };
  const cap = capacityFor(player.state && player.state.vesselSlug);
  if (usedSlots(player.cargo) + goods.goodVolume(goodId) * n > cap) return { ok: false, reason: 'no_space' };
  ensureSeeded();
  const mk = markets.get(town.id);
  const pr = profileFor(town)[goodId];
  if (!mk || !pr) return { ok: false, reason: 'no_town' };
  const stock0 = mk.stock[goodId] ?? 0;
  if (stock0 - n < MIN_STOCK) return { ok: false, reason: 'town_out' };   // never drain below the floor
  let s = stock0, cost = 0;
  for (let i = 0; i < n; i++) { cost += goods.quote(goods.basePrice(goodId), pr.priceRef, s, town.tier).ask; s -= 1; }
  if (player.gold < cost) return { ok: false, reason: 'no_gold' };
  // commit
  player.gold -= cost;
  mk.stock[goodId] = s;
  mk.treasury += cost;
  player.cargo[goodId] = (player.cargo[goodId] || 0) + n;
  pushLedger(player, { t: Date.now(), side: 'buy', townId, goodId, qty: n, unit: Math.round(cost / n) });
  dirty = true;
  return { ok: true, cost, unit: Math.round(cost / n) };
}

/** Player sells `qty` of `goodId`. Marginal: each unit walks the bid down as town stock rises. Limited by town
 *  TREASURY (town_broke — the town must afford the payout) + player holdings (no_goods). Atomic. */
function applySell(player, authPose, townId, goodId, qty) {
  const town = dockedTown(authPose, townId);
  if (!town) return { ok: false, reason: 'not_docked' };
  if (!goods.isGood(goodId)) return { ok: false, reason: 'bad_good' };
  const n = intQty(qty);
  if (!n) return { ok: false, reason: 'bad_qty' };
  const held = player.cargo[goodId] || 0;
  if (held < n) return { ok: false, reason: 'no_goods' };
  ensureSeeded();
  const mk = markets.get(town.id);
  const pr = profileFor(town)[goodId];
  if (!mk || !pr) return { ok: false, reason: 'no_town' };
  let s = mk.stock[goodId] ?? 0, proceeds = 0;
  for (let i = 0; i < n; i++) { proceeds += goods.quote(goods.basePrice(goodId), pr.priceRef, s, town.tier).bid; s += 1; }
  if (mk.treasury < proceeds) return { ok: false, reason: 'town_broke' };   // the town can't afford it
  // commit
  player.gold += proceeds;
  mk.stock[goodId] = s;
  mk.treasury -= proceeds;
  const left = held - n;
  if (left > 0) player.cargo[goodId] = left; else delete player.cargo[goodId];
  pushLedger(player, { t: Date.now(), side: 'sell', townId, goodId, qty: n, unit: Math.round(proceeds / n) });
  dirty = true;
  return { ok: true, proceeds, unit: Math.round(proceeds / n) };
}

/** Dock repair — charge the flat fee if affordable, otherwise a MERCY free repair. Always succeeds. */
function applyRepair(player) {
  const fee = goods.REPAIR_FEE;
  if (player.gold >= fee) { player.gold -= fee; return { ok: true, charged: fee, mercy: false }; }
  return { ok: true, charged: 0, mercy: true };
}

// ── persistence (singleton row per MAP_VERSION) ────────────────────────────────
function serializeTowns() {
  const o = {};
  for (const [id, mk] of markets) o[id] = { stock: mk.stock, treasury: Math.round(mk.treasury) };
  return o;
}
function hydrateTowns(blob) {
  for (const t of towns.values()) {
    const mk = markets.get(t.id);
    const saved = blob && blob[t.id];
    if (!mk || !saved) continue;
    if (saved.stock && typeof saved.stock === 'object') mk.stock = { ...mk.stock, ...saved.stock };
    if (typeof saved.treasury === 'number') mk.treasury = saved.treasury;
  }
}

/** Boot: seed fresh, then restore the saved blob for the CURRENT map version (if any) + catch up downtime.
 *  Tolerant of a missing table / parse errors (fresh DB) — seeds in memory and defers the row to first flush. */
async function loadState() {
  ensureLoaded();
  seedMarkets();
  lastTickDay = economyDay();
  let row = null;
  try {
    const { EconomyState } = require('./models');
    row = await EconomyState.findByPk(moveConst.MAP_VERSION);
  } catch (err) {
    console.warn('[economy] loadState query failed (fresh table?):', err.message);
  }
  if (row) {
    try {
      hydrateTowns(JSON.parse(row.towns || '{}'));
      lastTickDay = row.lastTickDay | 0;
    } catch (err) {
      console.warn('[economy] saved economy parse failed — seeding fresh:', err.message);
    }
    tickToToday();   // downtime catch-up
    console.log(`[economy] state restored (map v${moveConst.MAP_VERSION}, day ${lastTickDay})`);
  } else {
    dirty = true;    // new map / fresh DB → flush the seeded economy on the next cycle
    console.log(`[economy] fresh economy seeded (map v${moveConst.MAP_VERSION})`);
  }
}

/** Persist the singleton blob (no-op unless dirty, or force). Called periodically + on tick + on shutdown. */
async function flushState(force) {
  if (!dirty && !force) return;
  try {
    const { EconomyState } = require('./models');
    await EconomyState.upsert({
      mapVersion: moveConst.MAP_VERSION,
      lastTickDay,
      towns: JSON.stringify(serializeTowns()),
    });
    dirty = false;
  } catch (err) {
    console.warn('[economy] flushState failed:', err.message);
  }
}

module.exports = {
  load, ensureLoaded, townAt, getTown, townList, marketFor,
  parseCargo, usedSlots, capacityFor, goodsCatalog,
  applyBuy, applySell, applyRepair,
  bestBuyerFor, hintFor, currentDay: economyDay,
  tick, tickToToday, loadState, flushState, seedMarkets,
  REPAIR_FEE: goods.REPAIR_FEE, STARTING_GOLD: goods.STARTING_GOLD, DOCK_RADIUS_M,
  // test seam (headless harness — no manifest/DB): inject towns + drive state directly.
  _test: {
    setTowns(arr) { towns = new Map(arr.map((t) => [t.id, t])); profiles = new Map(); markets = new Map(); loaded = true; },
    seedMarkets, tick, marketFor, bestBuyerFor, hintFor, serializeTowns, hydrateTowns, economyDayAt,
    setLastTickDay(d) { lastTickDay = d; }, getLastTickDay() { return lastTickDay; },
    getMarket(id) { return markets.get(id); }, profileFor: (t) => profileFor(t),
  },
};
