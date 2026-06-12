'use strict';

/**
 * Floating salvage crates (NPC Traders — NP4). When a player sinks an NPC merchant, a fraction of its cargo +
 * gold drops here as a crate at the wreck. Any player can sail over it and collect (server-validated, atomic —
 * Node's single-threaded handler means the second collector sees the depleted/removed crate; no race). Goods
 * over the collector's free hold stay floating for the next grabber; gold (no hold cost) goes to the first.
 * Crates despawn after a lifetime if uncollected. Registry only — the collection MATH lives here, the awarding
 * + messaging lives in multiplayer.js (which has the economy capacity helpers).
 */

const CRATE_LIFETIME_MS = 120000;   // 2 minutes to grab it
const COLLECT_RADIUS_M = 60;        // how close a hull must be to scoop a crate

let seq = 0;
const crates = new Map();           // id → { id, x, z, contents:{goodId:qty}, gold, expiresAt }

function spawnCrate(x, z, contents, gold, nowMs) {
  const id = 'crate_' + (++seq);
  const c = { id, x, z, contents: { ...contents }, gold: gold | 0, expiresAt: nowMs + CRATE_LIFETIME_MS };
  crates.set(id, c);
  return c;
}
function getCrate(id) { return crates.get(id) || null; }
function remove(id) { crates.delete(id); }
function list() { return [...crates.values()]; }

/** Drop any crates whose lifetime elapsed; returns the removed ids (to broadcast a despawn for each). */
function sweepExpired(nowMs) {
  const gone = [];
  for (const [id, c] of crates) if (c.expiresAt <= nowMs) { crates.delete(id); gone.push(id); }
  return gone;
}

/**
 * Award the crate's GOLD (in full) + goods up to `freeSlots` (1 slot/unit) into the result. MUTATES the crate
 * (removes what was taken); leftover goods stay floating. Returns { goods:{goodId:qty}, gold, took, empty }.
 */
function collect(crate, freeSlots) {
  const goods = {};
  let took = 0;
  for (const g of Object.keys(crate.contents)) {
    while (crate.contents[g] > 0 && took < freeSlots) { goods[g] = (goods[g] || 0) + 1; crate.contents[g]--; took++; }
    if (crate.contents[g] <= 0) delete crate.contents[g];
    if (took >= freeSlots) break;
  }
  const gold = crate.gold | 0;
  crate.gold = 0;
  const empty = crate.gold === 0 && Object.keys(crate.contents).length === 0;
  return { goods, gold, took, empty };
}

module.exports = {
  spawnCrate, getCrate, remove, list, sweepExpired, collect,
  COLLECT_RADIUS_M, CRATE_LIFETIME_MS,
  _test: { reset() { crates.clear(); seq = 0; } },
};
