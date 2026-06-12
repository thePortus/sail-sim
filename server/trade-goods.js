'use strict';

/**
 * Trade-goods catalogue + static specialty-based pricing (Town Economy — Phase 1).
 *
 * Single source of truth for: the goods that exist, each town specialty's produce/consume profile, and the
 * STATIC price a town quotes for a good. Phase 1 has no stock/treasury/daily dynamics — a town's ask/bid is
 * a pure function of (good base price × specialty modifier × tier spread). The trade *gradient* (buy where a
 * good is produced/cheap → sell where it's consumed/dear) is what the player arbitrages; the only limits are
 * the player's gold and cargo capacity. Phase 2 layers stock depletion, marginal pricing, treasuries, and a
 * gradual game-day tick on top of this. The server is the sole price authority — clients render what's sent.
 */

// ~10 colonial-era goods. `base` = mid reference price (gold/unit); `volume` = cargo slots/unit (uniform 1 in
// Phase 1; differential volume is a later knob). Order is the display order in the trader panel.
const GOODS = [
  { id: 'provisions', name: 'Provisions', base: 4,  volume: 1 },
  { id: 'salt_fish',  name: 'Salt Fish',  base: 5,  volume: 1 },
  { id: 'timber',     name: 'Timber',     base: 6,  volume: 1 },
  { id: 'sugar',      name: 'Sugar',      base: 8,  volume: 1 },
  { id: 'cotton',     name: 'Cotton',     base: 10, volume: 1 },
  { id: 'tobacco',    name: 'Tobacco',    base: 16, volume: 1 },
  { id: 'tools',      name: 'Ironware',   base: 22, volume: 1 },
  { id: 'cloth',      name: 'Cloth',      base: 26, volume: 1 },
  { id: 'rum',        name: 'Rum',        base: 30, volume: 1 },
  { id: 'spices',     name: 'Spices',     base: 55, volume: 1 },
];

const GOOD_BY_ID = new Map(GOODS.map((g) => [g.id, g]));

// 7 town specialties. `produces` → abundant here → cheap (player buys low). `consumes` → in demand here →
// dear (player sells high). The web is designed so everyone needs rum + provisions, tools are broadly needed,
// and the distillery depends on plantations (sugar) — so "all need each other". A capital Trade Port produces
// imported luxuries (cloth/spices) and buys raw goods broadly (the trade hub).
const SPECIALTIES = {
  plantation: { label: 'Plantation',  produces: ['sugar', 'cotton', 'tobacco'], consumes: ['provisions', 'tools', 'cloth', 'rum'] },
  distillery: { label: 'Distillery',  produces: ['rum'],                        consumes: ['sugar', 'provisions', 'tools'] },
  forge:      { label: 'Forge Town',  produces: ['tools'],                      consumes: ['provisions', 'timber', 'rum', 'salt_fish'] },
  logging:    { label: 'Logging Camp',produces: ['timber'],                     consumes: ['provisions', 'tools', 'rum'] },
  fishing:    { label: 'Fishing Village', produces: ['salt_fish'],              consumes: ['provisions', 'timber', 'tools', 'rum'] },
  farmstead:  { label: 'Farmstead',   produces: ['provisions'],                 consumes: ['tools', 'cloth', 'rum', 'timber'] },
  port:       { label: 'Trade Port',  produces: ['cloth', 'spices'],            consumes: ['sugar', 'cotton', 'tobacco', 'timber', 'salt_fish'] },
};

// Specialty modifier on the mid price: produced here → cheap; consumed here → dear; otherwise par.
const PRODUCE_MULT = 0.6;
const CONSUME_MULT = 1.6;
const NEUTRAL_MULT = 1.0;

// Merchant's cut (ask>bid). Wider at smaller/rougher ports. The produce/consume gradient dominates the spread
// so a producer→consumer run is always profitable even worst-case (both small): buy 0.6·1.15 vs sell 1.6·0.85.
const SPREAD_BY_TIER = { capital: 0.15, medium: 0.22, small: 0.30 };

const REPAIR_FEE = 40;          // gold per dock repair (the first gold sink)
const STARTING_GOLD = 500;

/** All valid specialty keys. */
function specialtyKeys() { return Object.keys(SPECIALTIES); }

/** The mid/ask/bid a town of the given specialty+tier quotes for one good. Deterministic, no state. */
function priceFor(specialty, goodId, tier) {
  const g = GOOD_BY_ID.get(goodId);
  const spec = SPECIALTIES[specialty];
  if (!g || !spec) return null;
  const mult = spec.produces.includes(goodId) ? PRODUCE_MULT
            : spec.consumes.includes(goodId) ? CONSUME_MULT
            : NEUTRAL_MULT;
  const mid = g.base * mult;
  const s = SPREAD_BY_TIER[tier] ?? SPREAD_BY_TIER.medium;
  const ask = Math.max(1, Math.round(mid * (1 + s / 2)));   // player BUYS at ask
  const bid = Math.max(1, Math.round(mid * (1 - s / 2)));   // player SELLS at bid
  return { ask, bid };
}

/** The full market a town quotes: one row per good. Returned to the client verbatim. */
function market(specialty, tier) {
  return GOODS.map((g) => {
    const p = priceFor(specialty, g.id, tier);
    return { goodId: g.id, name: g.name, ask: p.ask, bid: p.bid };
  });
}

/** Cargo slots one unit of a good occupies (uniform 1 in Phase 1). */
function goodVolume(goodId) { return GOOD_BY_ID.get(goodId)?.volume ?? 1; }

/** Whether a good id is real (validation guard). */
function isGood(goodId) { return GOOD_BY_ID.has(goodId); }

module.exports = {
  GOODS, SPECIALTIES, SPREAD_BY_TIER, REPAIR_FEE, STARTING_GOLD,
  specialtyKeys, priceFor, market, goodVolume, isGood,
};
