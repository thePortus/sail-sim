'use strict';

/**
 * Inter-faction diplomacy (Diplomacy module — the events layer the factions scaffold was built for).
 *
 * The four nations hold a pairwise relation — WAR, PEACE, or ALLIANCE — over the 6 unordered pairs. Relations
 * shift RARELY (≈1–2 in-game months between any change; an always-on world evolves over real days), each shift
 * announced to everyone. War onset is BIASED by territorial rivalry: nations that share contested borders are
 * likelier to come to blows. Admins can force any relation via a chat command.
 *
 * Used by: the reputation layer (attacking nation V's shipping rewards rep with V's WAR enemies, and slightly
 * offends V's ALLIES — see multiplayer resolveHit) and the client Diplomacy panel. State is a singleton DB row
 * (NOT map-gated — politics outlive map geometry). All randomness is server-side (no client-determinism need).
 */

const factions = require('./factions');

const IDS = factions.factionIds();                 // ['english','french','spanish','dutch']
const WAR = 'war', PEACE = 'peace', ALLIANCE = 'alliance';
const STATES = [WAR, PEACE, ALLIANCE];

// ── Tuning ──────────────────────────────────────────────────────────────────
// One in-game day = 1440 real seconds (matches economy SECS_PER_DAY); a "game month" ≈ 30 game days. A shift
// is rolled at most once per in-game day with probability 1/SHIFT_EXPECTED_DAYS, so the EXPECTED gap between
// any two changes is ~SHIFT_EXPECTED_DAYS days ≈ 1.5 game months (~18 real hours). Tune freely.
const SHIFT_EXPECTED_DAYS = 45;
// When a PEACE pair shifts, the odds it escalates to WAR vs forms an ALLIANCE. Rival (contested-border) pairs
// lean hard toward war; non-rivals split toward alliances.
const WAR_BIAS_RIVAL = 0.85;
const WAR_BIAS_PLAIN = 0.35;

// ── Live state ────────────────────────────────────────────────────────────────
let rel = new Map();          // pairKey "a|b" (a<b) → 'war'|'peace'|'alliance'  (absent = peace)
let lastShiftDay = 0;
let loaded = false;
let dirty = false;

function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
function allPairs() {
  const out = [];
  for (let i = 0; i < IDS.length; i++) for (let j = i + 1; j < IDS.length; j++) out.push([IDS[i], IDS[j]]);
  return out;
}

// ── Public query API ───────────────────────────────────────────────────────────
/** Relation between two factions ('peace' default; a nation is always at peace with itself). */
function relation(a, b) {
  if (a === b) return PEACE;
  return rel.get(pairKey(a, b)) || PEACE;
}
/** Factions currently AT WAR with `f`. */
function enemiesOf(f) { return IDS.filter((o) => o !== f && relation(f, o) === WAR); }
/** Factions currently ALLIED with `f`. */
function alliesOf(f) { return IDS.filter((o) => o !== f && relation(f, o) === ALLIANCE); }
/** Full relation matrix { [a]: { [b]: state } } (ordered pairs, a≠b) — for the client Diplomacy panel. */
function matrix() {
  const m = {};
  for (const a of IDS) { m[a] = {}; for (const b of IDS) if (a !== b) m[a][b] = relation(a, b); }
  return m;
}
function isState(s) { return STATES.includes(s); }

/** Set a relation directly (admin command / shift engine). Returns the change {a,b,from,to} or null (no-op /
 *  invalid). Normalised pair order so 'set english french war' and 'set french english war' are the same. */
function setRelation(a, b, state) {
  if (!factions.isFaction(a) || !factions.isFaction(b) || a === b || !isState(state)) return null;
  const from = relation(a, b);
  if (from === state) return null;
  if (state === PEACE) rel.delete(pairKey(a, b)); else rel.set(pairKey(a, b), state);
  dirty = true;
  return { a, b, from, to: state };
}

// ── Rivalry weighting (from the contested-border town data) ─────────────────────
/** Build a rivalry-weight map { pairKey: contestedTownCount } from the town list (each town carries
 *  faction + optional rivalFaction when it sits on a contested border). Heavier → likelier to go to war. */
function rivalWeightsFromTowns(towns) {
  const w = {};
  for (const t of towns || []) {
    if (t && t.contested && t.faction && t.rivalFaction && t.faction !== t.rivalFaction) {
      const k = pairKey(t.faction, t.rivalFaction);
      w[k] = (w[k] || 0) + 1;
    }
  }
  return w;
}
function rivalWeight(weights, a, b) { return (weights && weights[pairKey(a, b)]) || 0; }

// ── Shift engine ────────────────────────────────────────────────────────────────
/** Roll a single relation transition. Returns the change {a,b,from,to} or null. PEACE→WAR is weighted by
 *  rivalry; WAR→PEACE (truce) and ALLIANCE→PEACE (dissolution) are the de-escalation paths. */
function rollShift(weights) {
  const pairs = allPairs();
  const p = pairs[(Math.random() * pairs.length) | 0];
  const [a, b] = p;
  const cur = relation(a, b);
  if (cur === WAR) return setRelation(a, b, PEACE);            // truce
  if (cur === ALLIANCE) return setRelation(a, b, PEACE);       // alliance dissolves
  // PEACE → escalate to WAR (rival-biased) or warm to ALLIANCE.
  const warBias = rivalWeight(weights, a, b) > 0 ? WAR_BIAS_RIVAL : WAR_BIAS_PLAIN;
  return setRelation(a, b, Math.random() < warBias ? WAR : ALLIANCE);
}

/** Advance diplomacy to `today` (in-game day). Rolls AT MOST one shift per elapsed day at the rare per-day
 *  probability; idempotent within a day. Returns the array of change events (usually empty) for announcement. */
function tickToDay(today, weights) {
  const changes = [];
  if (!Number.isFinite(today)) return changes;
  if (lastShiftDay === 0) lastShiftDay = today;   // first ever tick → anchor, don't retro-roll
  const p = 1 / SHIFT_EXPECTED_DAYS;
  // Bounded catch-up so a long downtime can't fire dozens of wars at once.
  let days = Math.min(today - lastShiftDay, 30);
  while (days-- > 0) {
    if (Math.random() < p) { const c = rollShift(weights); if (c) changes.push(c); }
  }
  if (today > lastShiftDay) { lastShiftDay = today; dirty = true; }
  return changes;
}

// ── Seeding ─────────────────────────────────────────────────────────────────────
/** Seed an initial political map for a fresh world: the single strongest rivalry starts at WAR; one calm
 *  (non-rival) pair starts ALLIED; the rest at PEACE. Grounds the opening tension in the map's borders. */
function seed(weights) {
  rel = new Map();
  const pairs = allPairs();
  let topRival = null, topW = 0;
  for (const [a, b] of pairs) { const w = rivalWeight(weights, a, b); if (w > topW) { topW = w; topRival = [a, b]; } }
  if (topRival) setRelation(topRival[0], topRival[1], WAR);
  // Ally a pair with NO rivalry (and not the warring one), if any.
  const calm = pairs.find(([a, b]) => rivalWeight(weights, a, b) === 0 && relation(a, b) === PEACE);
  if (calm) setRelation(calm[0], calm[1], ALLIANCE);
  dirty = true;
}

// ── Persistence (singleton row id=1; NOT map-gated) ─────────────────────────────
function serialize() { const o = {}; for (const [k, v] of rel) o[k] = v; return o; }
function hydrate(blob) {
  rel = new Map();
  if (blob && typeof blob === 'object') {
    for (const [k, v] of Object.entries(blob)) {
      const [a, b] = String(k).split('|');
      if (factions.isFaction(a) && factions.isFaction(b) && isState(v) && v !== PEACE) rel.set(pairKey(a, b), v);
    }
  }
}

/** Boot: restore the singleton row, or seed a fresh political map (rivalry-biased). Tolerant of a missing
 *  table / parse error (fresh DB) — seeds in memory and defers the row to the first flush. */
async function load(weights) {
  if (loaded) return;
  loaded = true;
  let row = null;
  try {
    const { DiplomacyState } = require('./models');
    row = await DiplomacyState.findByPk(1);
  } catch (err) {
    console.warn('[diplomacy] load query failed (fresh table?):', err.message);
  }
  if (row) {
    try { hydrate(JSON.parse(row.rel || '{}')); lastShiftDay = row.lastShiftDay | 0; dirty = false; }
    catch (err) { console.warn('[diplomacy] saved state parse failed — seeding fresh:', err.message); seed(weights); }
    console.log(`[diplomacy] restored (lastShiftDay ${lastShiftDay}): ${summary()}`);
  } else {
    seed(weights);
    console.log(`[diplomacy] fresh political map seeded: ${summary()}`);
  }
}

/** Persist the singleton blob (no-op unless dirty, or force). */
async function flush(force) {
  if (!dirty && !force) return;
  try {
    const { DiplomacyState } = require('./models');
    await DiplomacyState.upsert({ id: 1, lastShiftDay, rel: JSON.stringify(serialize()) });
    dirty = false;
  } catch (err) {
    console.warn('[diplomacy] flush failed:', err.message);
  }
}

// ── Announcement text ───────────────────────────────────────────────────────────
function nm(id) { return factions.factionName(id); }
/** Human announcement for a relation change — broadcast as a system event when nations shift. */
function describeChange(c) {
  const A = nm(c.a), B = nm(c.b);
  if (c.to === WAR) return `⚔ The ${A} and the ${B} have declared WAR!`;
  if (c.to === ALLIANCE) return `⚜ The ${A} and the ${B} have formed an ALLIANCE.`;
  // to PEACE — phrasing depends on what they're leaving.
  if (c.from === WAR) return `\u{1f54a} The ${A} and the ${B} have made PEACE.`;
  if (c.from === ALLIANCE) return `✂ The alliance between the ${A} and the ${B} has dissolved.`;
  return `The ${A} and the ${B} are now at peace.`;
}
/** One-line console summary of the current political map. */
function summary() {
  const parts = [];
  for (const [a, b] of allPairs()) { const r = relation(a, b); if (r !== PEACE) parts.push(`${a}-${b}:${r}`); }
  return parts.length ? parts.join(', ') : 'all at peace';
}

module.exports = {
  WAR, PEACE, ALLIANCE, STATES,
  relation, enemiesOf, alliesOf, matrix, isState, setRelation,
  rivalWeightsFromTowns, tickToDay, seed, load, flush, describeChange, summary,
};
