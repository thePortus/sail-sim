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

// Merchant's cut (ask>bid). Wider at smaller/rougher ports.
const SPREAD_BY_TIER = { capital: 0.15, medium: 0.22, small: 0.30 };

const REPAIR_FEE = 40;          // gold per dock repair (the first gold sink)
const STARTING_GOLD = 500;

// ── Phase 2: dynamic economy config (all tunable) ────────────────────────────
// Price is driven purely by STOCK relative to a per-good price-neutral anchor (priceRef): surplus → cheap,
// scarcity → dear. mid = base × clamp((priceRef/S)^ELASTICITY, lo, hi). The producer-cheap / consumer-dear
// gradient comes from SEEDING stock at different ratios of priceRef (not a static multiplier), so it
// strengthens as surplus/scarcity actually accrue and a producer→consumer run stays profitable.
const ELASTICITY = 0.6;
const STOCK_CLAMP = { lo: 0.4, hi: 2.5 };                 // mid is base×[0.4 … 2.5]
// Seed-stock ÷ priceRef for each role, chosen so opening prices ≈ Phase-1 (0.6× producer / 1.6× consumer / 1×):
//   (priceRef/S)^0.6 = 0.6  → S/priceRef = 2.343   |   = 1.6 → 0.457   |   = 1.0 → 1.0
const SEED_RATIO   = { produced: 2.343, consumed: 0.457, neutral: 1.0 };
const TIER_SCALE   = { capital: 3, medium: 1.5, small: 1 };   // bigger towns trade bigger absolute volumes
const ROLE_RATE    = 6;        // base units/day a town produces (or consumes) of a role good, ×TIER_SCALE
const REF_DAYS      = 60;      // priceRef = ratePerDay × REF_DAYS → ~weeks of buffer ⇒ gradual daily drift
const NEUTRAL_REF   = 20;      // priceRef for goods a town neither makes nor needs (thin, ×TIER_SCALE)
const STOCK_CAP_MULT = 3;      // a glutted producer's stock caps at STOCK_CAP_MULT × priceRef
const TREASURY0     = { capital: 6000, medium: 2500, small: 1000 };   // a town's starting (and max) gold purse
const TREASURY_REGEN = 0.05;   // per day, fraction of (cap − treasury) regained (self-heals when drained)

/** All valid specialty keys. */
function specialtyKeys() { return Object.keys(SPECIALTIES); }

/** Cargo slots one unit of a good occupies (uniform 1 in Phase 1). */
function goodVolume(goodId) { return GOOD_BY_ID.get(goodId)?.volume ?? 1; }

/** Whether a good id is real (validation guard). */
function isGood(goodId) { return GOOD_BY_ID.has(goodId); }

/** Base reference price of a good. */
function basePrice(goodId) { return GOOD_BY_ID.get(goodId)?.base ?? 1; }

/**
 * The economic profile of one good at a town (specialty+tier). Deterministic from config — NOT persisted, so
 * retuning the constants re-derives it from the saved live stock. role ∈ produced|consumed|neutral.
 */
function townGoodProfile(specialty, tier, goodId) {
  const spec = SPECIALTIES[specialty] || SPECIALTIES.port;
  const scale = TIER_SCALE[tier] ?? TIER_SCALE.medium;
  const role = spec.produces.includes(goodId) ? 'produced'
             : spec.consumes.includes(goodId) ? 'consumed'
             : 'neutral';
  const ratePerDay = role === 'neutral' ? 0 : ROLE_RATE * scale;
  const priceRef = role === 'neutral' ? NEUTRAL_REF * scale : ratePerDay * REF_DAYS;
  const stockCap = STOCK_CAP_MULT * priceRef;
  const seedStock = SEED_RATIO[role] * priceRef;
  return { role, ratePerDay, priceRef, stockCap, seedStock };
}

/** Ask/bid for ONE unit of a good given the town's live stock + its priceRef + tier. Player BUYS at ask,
 *  SELLS at bid. Stock floored at 1 to avoid div-by-zero (the caller walks multi-unit orders unit-by-unit). */
function quote(base, priceRef, stock, tier) {
  const S = Math.max(1, stock);
  const factor = Math.min(STOCK_CLAMP.hi, Math.max(STOCK_CLAMP.lo, Math.pow(priceRef / S, ELASTICITY)));
  const mid = base * factor;
  const s = SPREAD_BY_TIER[tier] ?? SPREAD_BY_TIER.medium;
  const ask = Math.max(1, Math.round(mid * (1 + s / 2)));
  const bid = Math.max(1, Math.round(mid * (1 - s / 2)));
  return { ask, bid };
}

module.exports = {
  GOODS, SPECIALTIES, SPREAD_BY_TIER, REPAIR_FEE, STARTING_GOLD,
  ELASTICITY, STOCK_CLAMP, SEED_RATIO, TIER_SCALE, ROLE_RATE, REF_DAYS,
  NEUTRAL_REF, STOCK_CAP_MULT, TREASURY0, TREASURY_REGEN,
  specialtyKeys, goodVolume, isGood, basePrice, townGoodProfile, quote,
};
