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
const quest = require('./quest');   // to shield intro-tutorial players from pirate aggro
const questAnchors = require('./quest-anchors');   // intro spawn point → keep pirate lairs well clear of it
const combat = require('./combat');
const Cc = require('./combat-constants');   // shared ballistic constants (G, HALF_BEAM, TRAVEL_SCALE) for NPC gunnery
const factions = require('./factions');
const diplomacy = require('./diplomacy');   // war/peace/alliance — drives nation-vs-nation NPC warship combat
const shippingLanes = require('./shipping-lanes');   // busiest-lane hotspots → a "where's the traffic" map hint
const moveConst = require('./movement-constants');
const { getVesselDef, crewFor } = require('./controllers/vessels.controller');
const weatherState = require('./weather-state');   // server-authoritative wind (speed + bearing)

const DEG = Math.PI / 180;
// Weighted merchant vessel pool (solo traders + convoy CARGO). The big slow merchantman/hagboat is the iconic
// haul and the most common trader; sloops + pinnaces are the lighter traders seen sometimes. The BRIG is a
// WARSHIP, NOT a trade ship — it is deliberately ABSENT here so it only ever sails as a convoy ESCORT
// (spawnConvoy hard-codes 'brig'), a PIRATE (PIRATE_SLUGS), or a navy HUNTER (makeHunter). Duplicates set the odds.
const MERCHANT_SLUGS = ['merchantman', 'merchantman', 'merchantman', 'merchantman', 'sloop', 'sloop', 'pinnace'];
// Ship names by NATION — every faction-owned vessel (merchant OR navy hunter) is named in its own nation's
// language, so a Spanish ship reads as Spanish, a Dutch ship as Dutch, etc. Authentic period ship / saint /
// place / virtue names (NOT thematic stereotypes). Pirates fly no flag and keep their own captain-names below.
const SHIP_NAMES = {
  english: ['Endeavour', 'Resolution', 'Adventure', 'Industry', 'Diligence', 'Amity', 'Concord', 'Providence',
    'Prosperity', 'Sovereign', 'Defiance', 'Triumph', 'Victory', 'Albion', 'Britannia', 'Halcyon', 'Swiftsure',
    'Vanguard', 'Bellona', 'Argonaut', 'Kingfisher', 'Swallow', 'Pelican', 'Bristol', 'Plymouth', 'Falmouth',
    'Dover', 'Mary Rose', 'Golden Hind', 'Bonaventure', 'Repulse', 'Warspite'],
  french: ['Espérance', 'Belle Poule', 'Hermione', 'Fleur de Lys', 'Aigle', 'Soleil Royal', 'Redoutable',
    'Intrépide', 'Gloire', 'Renommée', 'Marianne', 'Notre-Dame', 'Saint-Michel', 'Sainte-Anne', 'Superbe',
    'Fortune', 'Aurore', 'Triomphant', 'Bourbon', 'Bretagne', 'Normandie', 'Provence', 'Duguay-Trouin',
    'Vaillant', 'Bon Espoir', 'Deux Frères', 'Flore', 'Vénus', 'Nantaise', 'Toulonnaise'],
  spanish: ['Esperanza', 'Buenaventura', 'Santa Lucía', 'Santa María', 'San Felipe', 'San Ildefonso',
    'Concepción', 'Trinidad', 'Santísima', 'Rayo', 'Glorioso', 'Neptuno', 'San Juan', 'El Fénix', 'Andalucía',
    'Sevilla', 'Cádiz', 'San José', 'Montañés', 'Argonauta', 'Santa Ana', 'Vencedor', 'La Perla', 'Golondrina',
    'Estrella', 'Nuestra Señora', 'Bahama', 'Reina', 'Princesa', 'San Nicolás'],
  dutch: ['Zeelandia', 'Vrijheid', 'Goede Hoop', 'Batavia', 'Eendracht', 'Zeven Provinciën', 'Amsterdam',
    'Rotterdam', 'Zeehond', 'Prins Willem', 'Gouden Leeuw', 'Zeearend', 'Meermin', 'Witte Leeuw', 'Middelburg',
    'Fortuyn', 'Hollandia', 'Utrecht', 'Gelderland', 'Zeewolf', 'Duyfken', 'Halve Maen', 'Nachtegaal',
    'Standvastigheid', 'Vrede', 'Wapen van Hoorn', 'Dolphijn', 'Neptunus', 'Concordia', 'Zeeridder'],
};
/** A ship name in the given nation's language (defaults to English for a null/unknown faction). */
function shipName(faction) { return pick(SHIP_NAMES[faction] || SHIP_NAMES.english); }
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

// Fleet size scales with the number of towns. DOUBLED (11–20 → 22–40, 0.5 → 1.0/town) for a busier sea —
// interest management (MAX_VISIBLE) still bounds the client draw cost, so a denser fleet is free to render.
function targetFleet(townCount) { return Math.max(22, Math.min(40, Math.round(townCount * 1.0))); }

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
// Formation-keeping (non-combat): a follower steers to its STATION when out of position, but adopts the LEADER's
// heading once close (so the convoy sails as one body, not each chasing a point). It regulates SPEED to hold
// station — matching the leader, pressing on to close a gap, easing when it overruns. The leader eases for a bad
// straggler so the group moves TOGETHER. All of this drops the moment combat starts (members fight/flee normally).
const CONVOY_FORM_BAND     = 40;   // world units of station error over which heading lerps station→leader-parallel
const CONVOY_SPEED_GAIN    = 0.05; // speed units added per metre of ALONG-track station error (catch up / ease off)
const CONVOY_SPEED_RESPONSE= 1.5;  // how briskly a follower's speed eases toward its station-keeping target (1/s)
const CONVOY_LAG_FULL      = 120;  // a follower this many metres BEHIND its station drags the leader to its floor
const CONVOY_LEADER_MIN    = 0.5;  // the slowest the leader will throttle to while waiting for a straggler
// E3 coordination: a screened TRADER tucks this far behind its escort (keeping the escort interposed); a 3-ship
// convoy occasionally fields TWO escorts (a heavily-guarded run) that flank the foe in a crossfire (pincer).
const SCREEN_DIST          = 65;   // world units a trader holds on the far side of its escort from the threat
const CONVOY_DOUBLE_ESCORT = 0.3;  // chance a 3-ship convoy carries 2 escorts (1 trader) instead of 1 escort (2 traders)
// Telegraphing (E4 polish): a short system-chat line to NEARBY players when a convoy commits to a fight or breaks
// off — so the player FEELS the strategy. Transition-only + per-convoy cooldown so it never spams. Flip off here.
const CONVOY_TELEGRAPH       = true;
const ANNOUNCE_COOLDOWN_MS   = 25000;
const convoyTele = new Map();      // convoyId → { prevStance, lastAnnounce } (telegraph transition state)
const NPC_DEBUG = process.env.NPC_DEBUG === '1';   // NPC_DEBUG=1 → log convoy tactical decisions for tuning/verification

// ── Pirates (unaligned raiders) ──────────────────────────────────────────────────────────────────────────────
// Pirates fly NO nation's flag (faction null). Each haunts a fixed patch of sea (its "lair") and only leaves to
// run down any vessel — player OR merchant — that blunders within PIRATE_AGGRO_RANGE, then returns to loiter. They
// fight hard (high skill, only break off when nearly crippled) and a touch faster than a laden merchant. Sinking
// one yields a gold bounty (richer if it had already plundered ships) + standing with the nation(s) it menaced.
// Pirates are a SEPARATE population from the merchant fleet target (they don't count toward npcCount).
const PIRATE_SLUGS = ['sloop', 'sloop', 'pinnace', 'brig'];   // fast raiders, with the odd heavy brig
const PIRATE_FIRST = ['Black', 'Red', 'Mad', 'Bloody', 'One-Eyed', 'Calico', 'Long', 'Iron', 'Cutthroat', 'Salty',
  'Crooked', 'Dead-Eye', 'Gentleman', 'Rackham', 'Bartholomew', 'Edward', 'Henry', 'William', 'Israel', 'Charles',
  'Roberto', 'Diego', 'Jean', 'Pierre', 'Klaas', 'Hendrik', 'Black-Hearted', 'Grim', 'Savage', 'Wicked'];
const PIRATE_LAST = ['Flint', 'Teach', 'Bonnet', 'Roberts', 'Hands', 'Vane', 'Rackham', 'Kidd', 'Morgan', 'Read',
  'Bonny', 'Low', 'Gibbs', 'Sparrow', 'Barbossa', 'Scarfield', 'Bellamy', 'Avery', 'Drake', 'Sawkins',
  'Magpie', 'Crow', 'Shark', 'Bones', 'Gallows', 'Reaper', 'Hook', 'Ironside', 'Blackwood', 'Skullbreaker'];
const PIRATE_AGGRO_RANGE = 300;   // a vessel within this of a pirate triggers the chase
const PIRATE_GIVE_UP     = 560;   // lose a quarry that opens past this from the pirate
const PIRATE_LEASH       = 950;   // dragged this far from its lair → break off and return home
const PIRATE_LAIR_R      = 240;   // loiter radius it orbits around its haunt
const PIRATE_FLEE_HEALTH = 0.22;  // a bold raider only runs when nearly crippled
const PIRATE_SKILL       = 0.72;  // sharp gunnery + tough nerve (still beatable)
const PIRATE_CRUISE      = 0.85;  // speed cap (vs MERCHANT_CRUISE) — fast enough to run down shipping, under a trimmed player
const PIRATE_VIS_R       = 900;   // always render a pirate within this of a player (it may be hunting them), past the nearest-N cutoff
const PIRATE_VIS_R2      = PIRATE_VIS_R * PIRATE_VIS_R;
function targetPirates(townCount) { return Math.max(3, Math.min(8, Math.round(townCount * 0.18))); }

// ── Pirate hunters (navy warships) ───────────────────────────────────────────────────────────────────────────
// A pirate that's STRANGLING a shipping lane (sunk ≥ PIRATE_HUNT_THRESHOLD merchants) draws a heavy navy warship
// from the nearest faction town — launched to hunt that specific pirate down. The threshold delay gives a PLAYER
// first crack at the bounty; the hunter is built to WIN (a brig, veteran skill, a shade faster than the pirate).
// When its quarry is dead (or gone) it sails back to its home port and vanishes — one hunter per pirate.
// Navy hunters are named by their launching town's NATION (shipName(town.faction)) — same per-nation pools as
// the merchants, so a French hunter reads French, a Spanish one Spanish, etc. (was a flat English martial list).
const PIRATE_SEED_GOLD = 200;      // a pirate spawns with this small purse; its bounty + plundered gold grow as it raids
const PIRATE_HUNT_THRESHOLD = 4;   // merchant kills before a pirate draws a navy hunter (players get first crack)
// Respawn cooldown: when a pirate is sunk it does NOT refill instantly — a replacement is scheduled 5–10 min later
// (varied), so the seas keep getting plagued but a cleared lane stays clear for a while. A fresh server still fills
// promptly (the cooldown only gates SINK replacements; the initial/deficit fill below is immediate).
const PIRATE_RESPAWN_MIN_MS = 5 * 60 * 1000;
const PIRATE_RESPAWN_MAX_MS = 10 * 60 * 1000;
const pirateRespawnQueue = [];     // due-times (ms) for sunk pirates awaiting their delayed replacement
let _lastLairWarn = 0;             // throttle the "pickLair null" warning (nav grid not ready) to once / 30s
function warnNoLair(ctx) {
  const now = Date.now();
  if (now - _lastLairWarn < 30000) return;
  _lastLairWarn = now;
  console.warn(`[pirate] ${ctx}: pickLair returned null — nav grid not loaded yet; will keep retrying (it self-heals once the terrain navgrid is available)`);
}
const HUNTER_SKILL    = 0.95;      // veteran navy gunnery + nerve (built to win the duel)
const HUNTER_CRUISE   = 0.9;       // a shade faster than the pirate (0.85) so it can run it down
const HUNTER_APPROACH = 220;       // within this it jockeys for a broadside; beyond, it bears straight for the pirate

/** Fleet-slot count of MERCHANTS: each solo merchant is one slot, each distinct convoy is ONE slot (regardless of
 *  2–3 ships). Pirates are a separate population and are excluded. */
function npcCount(players) {
  let solo = 0; const convoys = new Set();
  for (const [, p] of players) {
    if (!p.isNpc || p.isPirate || p.isHunter) continue;   // pirates + navy hunters are separate populations
    if (p.convoyId) convoys.add(p.convoyId); else solo++;
  }
  return solo + convoys.size;
}

/** Live pirate count (separate population from the merchant fleet). Excludes sunk/lingering hulls so the spawner
 *  refills correctly — counting a capsizing (or stuck) pirate as "alive" was leaving the seas permanently empty. */
function pirateCount(players) {
  let n = 0;
  for (const [, p] of players) if (p.isPirate && !(p.combat && p.combat.sunk)) n++;
  return n;
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
// The merchantman (three-masted square-rigger) mirrors the client MERCHANTMAN_SAIL: points even lower than
// the brig, but huge drive on a reach and holds it dead downwind.
const SAIL_POLARS = {
  sloop:       [[32, 0.46], [45, 0.64], [60, 0.80], [90, 0.93], [120, 1.00], [150, 0.82], [180, 0.66]],
  pinnace:     [[34, 0.42], [55, 0.62], [80, 0.82], [100, 0.92], [125, 0.97], [150, 0.90], [180, 0.80]],
  brig:        [[50, 0.40], [70, 0.62], [90, 0.82], [120, 1.00], [150, 0.95], [180, 0.86]],
  merchantman: [[52, 0.38], [72, 0.60], [92, 0.80], [120, 1.00], [150, 0.96], [180, 0.88]],
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
// Nation-vs-nation: a WARSHIP (convoy escort or navy hunter) of one nation engages enemy-nation NPCs when the two
// nations are AT WAR (diplomacy). Only warships INITIATE — a lone merchant never starts a fight (it only defends).
// The chase is LEASHED: a convoy drops an enemy NPC that opens past WAR_LEASH of the convoy's centre, so a fleeing
// foe can't drag it wildly off its trade route (it breaks off + reforms). Pirates are unaligned — separate path.
const WAR_DETECT = 500;      // world units: a warship picks up an enemy-nation NPC this close (initiate the fight)
const WAR_LEASH  = 650;      // world units: ...and breaks off once the foe opens past this from the convoy/warship
// Morale & commitment (E4): PRESS a crippled foe (close to finish it even if nominally outmatched); a convoy that
// just lost a consort loses heart for a while (more flee-prone, recovering its composure over MORALE_SHAKE_MS).
const PRESS_HULL          = 0.3;     // foe hull fraction at/below which a healthy NPC commits to the kill
const MORALE_SHAKE_MS     = 18000;   // a convoy stays rattled this long after a member is sunk
const MORALE_SHAKE_FACTOR = 0.55;    // its effective nerve while rattled (skill × this → flees far sooner)
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
const FORCE_K_BY_SLUG = { sloop: SAIL_FORCE_K, pinnace: SAIL_FORCE_K, brig: 1.12, merchantman: 1.18 };   // mirrors VESSEL_RIGS sail.forceK

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

/** True if two nations are actively AT WAR (both must be real, distinct factions — pirates are null/unaligned). */
function atWar(a, b) {
  return !!(a && b && a !== b && diplomacy.relation(a, b) === diplomacy.WAR);
}

/** Nearest enemy-nation NPC (warship OR merchant) to (ox,oz) whose faction is at war with `faction`, within r2.
 *  Excludes pirates (unaligned), sunk hulls, allies/neutrals, and an optional own-convoy id. Players take the
 *  separate reputation path, so non-NPCs are skipped here. Used by warships to acquire a target on sight. */
function nearestWarEnemy(faction, ox, oz, players, r2, exclConvoyId) {
  if (!faction) return null;
  let best = null, bestD2 = r2;
  for (const [, p] of players) {
    if (!p.isNpc || p.isPirate || !p.state || (p.combat && p.combat.sunk)) continue;
    if (!atWar(faction, p.faction)) continue;
    if (exclConvoyId && p.convoyId === exclConvoyId) continue;
    const dx = p.state.x - ox, dz = p.state.z - oz, d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  return best;
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
  if (hullFraction(npc.combat) < fleeHealthFor(skill)) return 'flee';   // I'm dying → run, whatever the foe
  // Commitment: a healthy ship PRESSES a crippled foe to finish it, even if the foe is nominally stronger.
  if (hullFraction(foe.combat) < PRESS_HULL) return 'fight';
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
function convoyStance(members, foe, provoked, players, nowMs) {
  let cx = 0, cz = 0, ourStr = 0, hullSum = 0, skill = 0, shaken = false;
  for (const m of members) {
    cx += m.state.x; cz += m.state.z; ourStr += shipStrength(m); hullSum += hullFraction(m.combat);
    skill = Math.max(skill, npcSkill(m));   // the escort emboldens the whole convoy → use the bravest member's nerve
    if (m.moraleShakeUntil && nowMs != null && m.moraleShakeUntil > nowMs) shaken = true;
  }
  cx /= members.length; cz /= members.length;
  // Morale: a convoy that just lost a consort fights with much less nerve (recovers as the shake decays).
  const nerve = shaken ? skill * MORALE_SHAKE_FACTOR : skill;
  if (hullSum / members.length < fleeHealthFor(nerve)) return 'flee';
  // Commitment: press a crippled foe to finish it, even when nominally outmatched (unless we're rattled / dying).
  if (!shaken && hullFraction(foe.combat) < PRESS_HULL) return 'fight';
  if (threatStrength(foe, players, cx, cz) / Math.max(1, ourStr) > avoidRatioFor(nerve)) return 'flee';
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

/** The world-space formation STATION (astern-and-abeam of the leader, rotated with its heading) for a follower's
 *  slot, plus the leader's forward unit vector. The whole formation turns as one because the station rides the
 *  leader's heading. */
function convoyStation(npc, leader) {
  const hr = leader.state.heading * DEG;
  const fx = Math.sin(hr), fz = Math.cos(hr);      // leader forward
  const rx = Math.cos(hr), rz = -Math.sin(hr);     // leader starboard
  const slot = npc.convoySlot || 1;
  const side = (slot % 2 === 1) ? 1 : -1;          // alternate sides
  const lane = Math.ceil(slot / 2);                // how far astern
  const tx = leader.state.x - fx * CONVOY_SPACING * lane + rx * side * CONVOY_SPACING * 0.7;
  const tz = leader.state.z - fz * CONVOY_SPACING * lane + rz * side * CONVOY_SPACING * 0.7;
  return { tx, tz, fx, fz, lane };
}

/** Non-combat formation heading for a follower holding its slot on the convoy leader. Out of position → steer to
 *  the station; on station → adopt the leader's heading so the convoy sails as ONE coordinated body (not each ship
 *  chasing a moving point — the old "follow-the-leader" wobble). Also stashes `_formSpeed`, the station-keeping
 *  speed the speed step applies (match the leader + close the along-track gap). Returns null (→ route normally)
 *  when there's no leader — the lowest-slot survivor PROMOTES itself so a beheaded convoy keeps trading. */
function convoyFollowHeading(npc, players) {
  const leader = convoyLeader(npc.convoyId, players);
  if (!leader) {
    const members = convoyMembers(npc, players);
    let lead = members[0]; for (const m of members) { if ((m.convoySlot | 0) < (lead.convoySlot | 0)) lead = m; }
    if (lead === npc) { npc.convoyRole = 'leader'; npc.route = null; }
    npc._formSpeed = null;
    return null;
  }
  const { tx, tz, fx, fz } = convoyStation(npc, leader);
  const ex = tx - npc.state.x, ez = tz - npc.state.z;          // station error vector
  const errDist = Math.hypot(ex, ez);
  const toStation = headingTo(npc.state.x, npc.state.z, tx, tz);
  const t = Math.min(1, errDist / CONVOY_FORM_BAND);           // 0 on-station → leader heading; 1 → steer to station
  const along = ex * fx + ez * fz;                             // +ve = station ahead of me → I'm lagging → press on
  npc._formSpeed = Math.max(0, (leader.state.speed || 0) + along * CONVOY_SPEED_GAIN);
  return blendHeading(leader.state.heading, toStation, t);
}

/** Speed multiplier [CONVOY_LEADER_MIN..1] for a convoy LEADER: it eases off when its worst non-combat follower is
 *  lagging well behind its station, so the convoy keeps station as a group instead of the leader sailing away from
 *  a slow merchantman. A follower that's fighting/fleeing doesn't count (it's not "straggling", it's in combat). */
function convoyLeaderDrag(leader, players) {
  const hr = leader.state.heading * DEG, fx = Math.sin(hr), fz = Math.cos(hr);
  let worstLag = 0;
  for (const m of convoyMembers(leader, players)) {
    if (m === leader || m.engaged || m.fleeing) continue;
    const along = (leader.state.x - m.state.x) * fx + (leader.state.z - m.state.z) * fz;   // +ve = astern of leader
    const lag = along - CONVOY_SPACING * Math.ceil((m.convoySlot || 1) / 2);               // beyond its station depth
    if (lag > worstLag) worstLag = lag;
  }
  return Math.max(CONVOY_LEADER_MIN, 1 - worstLag / CONVOY_LAG_FULL);
}

/** ONE shared FOCUS target for the whole convoy (E3) → its escort guns concentrate. Prefers ACTIVE attackers (any
 *  member's live grudge, give-up handled by engageTarget); if none, the nearest-hated players in detection range.
 *  Within the chosen pool it picks the WEAKEST (lowest current hull) so the convoy ganges up to sink one fast. */
function convoyFocusTarget(members, players, nowMs) {
  let pool = [];
  for (const m of members) { const f = engageTarget(m, players, nowMs); if (f && !pool.includes(f)) pool.push(f); }
  const provoked = pool.length > 0;
  const faction = members[0].faction;
  if (!provoked) {
    const R2 = DETECT_RANGE * DETECT_RANGE;
    for (const [, p] of players) {
      if (p.isNpc || !p.state || (p.combat && p.combat.sunk)) continue;
      if (repWith(p, faction) > HOSTILE_REP) continue;
      if (members.some((m) => { const dx = p.state.x - m.state.x, dz = p.state.z - m.state.z; return dx * dx + dz * dz <= R2; })) pool.push(p);
    }
    // Nation-vs-nation: a convoy WITH AN ESCORT (a warship that can initiate) picks up enemy-nation NPCs that come
    // within WAR_DETECT of any member. A convoy of bare traders (no escort, or escort sunk) does NOT initiate —
    // it'll only flee/defend. (Lone merchants take the solo findThreat path, which has no war scan at all.)
    if (faction && members.some((m) => m.combatRole === 'escort')) {
      const W2 = WAR_DETECT * WAR_DETECT, cid = members[0].convoyId;
      for (const [, p] of players) {
        if (!p.isNpc || p.isPirate || !p.state || (p.combat && p.combat.sunk) || p.convoyId === cid) continue;
        if (!atWar(faction, p.faction)) continue;
        if (members.some((m) => { const dx = p.state.x - m.state.x, dz = p.state.z - m.state.z; return dx * dx + dz * dz <= W2; }) && !pool.includes(p)) pool.push(p);
      }
    }
  }
  if (!pool.length) return null;
  // LEASH the chase of any enemy NPC (war target or a grudge from a stray shot) to WAR_LEASH of the convoy's
  // centre — so a fleeing enemy ship is chased only a little, then the convoy breaks off and reforms on its route
  // (players are NOT leashed — that's the unchanged piracy/reputation path).
  let cx = 0, cz = 0; for (const m of members) { cx += m.state.x; cz += m.state.z; } cx /= members.length; cz /= members.length;
  const L2 = WAR_LEASH * WAR_LEASH;
  pool = pool.filter((p) => !p.isNpc || ((p.state.x - cx) ** 2 + (p.state.z - cz) ** 2) <= L2);
  if (!pool.length) return null;
  let best = pool[0], bestHull = Infinity;
  for (const p of pool) { const h = p.combat ? hullPoints(p.combat).cur : 100; if (h < bestHull) { bestHull = h; best = p; } }
  // `war` → an enemy-nation NPC engagement (not a grudge): the convoy commits like a provoked one (see convoyStance)
  // even before the foe is point-blank, so warships actually close and fight rather than just shadowing at range.
  return { foe: best, provoked, war: !provoked && best.isNpc === true };
}

/** A screened convoy TRADER evades by keeping its nearest ESCORT between itself and the threat — steering to a point
 *  on the FAR side of the escort from the foe, so the escort's hull shields it. Falls back to a plain escape if the
 *  escort's been sunk. */
function convoyScreenHeading(npc, foe, escorts, wind, ph) {
  let esc = null, bestD2 = Infinity;
  for (const e of escorts) {
    if (e === npc || (e.combat && e.combat.sunk)) continue;
    const dx = e.state.x - npc.state.x, dz = e.state.z - npc.state.z, d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; esc = e; }
  }
  if (!esc) return escapeHeading(npc, foe, wind, ph);
  let ax = esc.state.x - foe.state.x, az = esc.state.z - foe.state.z;   // foe → escort = the sheltered direction
  const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
  return headingTo(npc.state.x, npc.state.z, esc.state.x + ax * SCREEN_DIST, esc.state.z + az * SCREEN_DIST);
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
  // A rake — or PRESSING a crippled foe — overrides toward a punchy close range to finish it before it recovers.
  const strRatio = shipStrength(npc) / Math.max(1, shipStrength(foe));
  const pressing = hullFraction(foe.combat) < PRESS_HULL;
  const desiredRange = (raking || pressing) ? FIRE_RANGE * 0.68
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
  let sPlus = score(hPlus), sMinus = score(hMinus);
  // Pincer (E3): a convoy with ≥2 escorts locks them to opposite flanks for a crossfire. Strong preference (×3),
  // not a hard lock — if the assigned tack is near-unsailable the safety valve still flips it.
  if      (npc.pincerSide === 1)  sPlus  *= 3;
  else if (npc.pincerSide === -1) sMinus *= 3;
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

// ── Pirate helm ──────────────────────────────────────────────────────────────────────────────────────────────
/** Nearest valid PREY (a player or a non-pirate merchant NPC, not sunk) within `maxR2` of the pirate, or null. */
function nearestPrey(pirate, players, maxR2) {
  let best = null, bestD2 = maxR2;
  for (const [, p] of players) {
    if (p === pirate || p.isPirate || !p.state || (p.combat && p.combat.sunk)) continue;
    if (p.questTag === 'tutorial') continue;   // the intro tutorial's pinnace is the player's prey — pirates leave it be
    if (!p.isNpc && p.questState && quest.inIntro(p.questState)) continue;   // leave brand-new captains alone until the tutorial's done
    const dx = p.state.x - pirate.state.x, dz = p.state.z - pirate.state.z, d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  return best;
}

/** A pirate's per-tick decision: HUNT a quarry it's chasing (jockey for a broadside; only run when nearly crippled)
 *  or, with no quarry, ORBIT its lair (which also carries it home after it breaks off a chase). It acquires any
 *  vessel that closes within PIRATE_AGGRO_RANGE, keeps the grudge until the foe escapes (GIVE_UP) or it's dragged
 *  too far from home (LEASH), then returns. Sets npc.engaged/fleeing for the shared gunnery + speed model below;
 *  returns { desired, foe }. */
function pirateHelm(npc, players, wind, ph, nowMs) {
  const lair = npc.lair || (npc.lair = { x: npc.state.x, z: npc.state.z });
  // Retain or drop the current quarry.
  let foe = npc.pirateTarget ? players.get(npc.pirateTarget) : null;
  if (foe) {
    const gone = !foe.state || (foe.combat && foe.combat.sunk) || foe.isPirate;
    const dxF = foe.state ? foe.state.x - npc.state.x : 0, dzF = foe.state ? foe.state.z - npc.state.z : 0;
    const dxL = npc.state.x - lair.x, dzL = npc.state.z - lair.z;
    const lost    = gone || (dxF * dxF + dzF * dzF) > PIRATE_GIVE_UP * PIRATE_GIVE_UP;   // foe broke contact
    const strayed = (dxL * dxL + dzL * dzL) > PIRATE_LEASH * PIRATE_LEASH;               // dragged too far from home
    if (lost || strayed) { foe = null; npc.pirateTarget = null; }
  }
  // Acquire a fresh quarry that's blundered into the haunt (only while not already chasing one).
  if (!foe) {
    const prey = nearestPrey(npc, players, PIRATE_AGGRO_RANGE * PIRATE_AGGRO_RANGE);
    if (prey) { foe = prey; npc.pirateTarget = prey.id; }
  }
  if (foe) {
    npc.engaged = true;
    const flee = hullFraction(npc.combat) < PIRATE_FLEE_HEALTH;   // nearly crippled → run
    npc.fleeing = flee;
    return { desired: flee ? escapeHeading(npc, foe, wind, ph) : engageHeading(npc, foe, wind, ph), foe };
  }
  // No quarry: slowly orbit the lair. The orbit point sits near home, so a pirate far from its haunt (just off a
  // chase) naturally steers back toward it; once home it circles, holding station until the next victim sails by.
  npc.engaged = false; npc.fleeing = false; npc.pirateTarget = null; npc.raking = false;
  npc.patrolPhase = (npc.patrolPhase || 0) + 0.015;
  const px = lair.x + Math.cos(npc.patrolPhase) * PIRATE_LAIR_R * 0.7;
  const pz = lair.z + Math.sin(npc.patrolPhase) * PIRATE_LAIR_R * 0.7;
  let desired = headingTo(npc.state.x, npc.state.z, px, pz);
  desired = tackedHeading(desired, wind.windBearing, ph.minTackAngle, npc);
  return { desired, foe: null };
}

// ── Pirate-hunter helm ───────────────────────────────────────────────────────────────────────────────────────
/** A navy hunter's per-tick decision: relentlessly run down its assigned pirate (bear straight for it when far,
 *  jockey for a broadside once within HUNTER_APPROACH), then — once the quarry is dead/gone — sail HOME to its
 *  origin port and vanish (sets npc._despawn on arrival, handled by the caller). Returns { desired, foe }. */
function hunterHelm(npc, players, wind, ph) {
  const target = npc.huntTarget ? players.get(npc.huntTarget) : null;
  const alive = !!(target && target.isPirate && target.state && !(target.combat && target.combat.sunk));
  const pirateDist = alive ? Math.hypot(target.state.x - npc.state.x, target.state.z - npc.state.z) : Infinity;
  // Priority: a live pirate quarry that's CLOSE — press the kill, ignore distractions.
  if (alive && !npc.returning && pirateDist <= HUNTER_APPROACH) {
    npc.engaged = true; npc.fleeing = false;
    return { desired: engageHeading(npc, target, wind, ph), foe: target };
  }
  // Opportunistic nation combat: a navy warship en route (still closing on its pirate, or sailing home) fights an
  // enemy-nation NPC it passes within WAR_DETECT. Re-acquired by proximity each tick → a foe that flees past
  // WAR_DETECT is dropped and the hunter resumes its mission, so it never chases wildly off track.
  const enemy = nearestWarEnemy(npc.faction, npc.state.x, npc.state.z, players, WAR_DETECT * WAR_DETECT, null);
  if (enemy) {
    npc.engaged = true; npc.fleeing = false;
    return { desired: engageHeading(npc, enemy, wind, ph), foe: enemy };
  }
  // No closer business: a live pirate still out there → bear for it.
  if (alive && !npc.returning) {
    npc.engaged = true; npc.fleeing = false;
    return { desired: tackedHeading(headingTo(npc.state.x, npc.state.z, target.state.x, target.state.z), wind.windBearing, ph.minTackAngle, npc), foe: target };
  }
  // Quarry dead or gone → mission accomplished: make for home port and pay off (despawn on arrival).
  npc.returning = true; npc.engaged = false; npc.fleeing = false; npc.raking = false;
  const o = npc.origin || { x: npc.state.x, z: npc.state.z };
  if (Math.hypot(o.x - npc.state.x, o.z - npc.state.z) < ARRIVE_M * 2) { npc._despawn = true; return { desired: npc.state.heading, foe: null }; }
  return { desired: tackedHeading(headingTo(npc.state.x, npc.state.z, o.x, o.z), wind.windBearing, ph.minTackAngle, npc), foe: null };
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
// NPCs are deliberately POOR gunners against the PLAYER (so duels are winnable). But that same wide scatter makes
// NPC-vs-NPC duels drag on forever (the player watched two sloops trade misses for 10+ minutes). So when the foe is
// ANOTHER NPC, tighten the scatter and quicken the cadence — a private fight resolves like real ships of the line,
// while fire at a human player is unchanged. Gated purely on foe.isNpc at the call site, so it never buffs vs-player.
const NPC_VS_NPC_ACC   = 0.45;     // multiply the scatter half-widths when the target is an NPC (≈2× tighter aim)
const NPC_VS_NPC_RELOAD = 0.7;     // and reload this much faster vs an NPC (a brisker exchange of broadsides)
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
function firingSolution(npc, foeState, muzzleV, accMul = 1) {
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
  const sm = aimSpreadMul(npcSkill(npc)) * accMul;   // veteran tight, timid sprays (role-scaled); accMul tightens vs NPCs
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

// ── Hard land BACKSTOP for translation ────────────────────────────────────────────────────────────────────────
// avoidLand() steers the HEADING away from land, but it's a soft hint: a crippled, boxed-in or hard-pressed NPC —
// above all a pirate/merchant in combat, following a FREE engage/escape heading off the A* route, whose turn rate
// can't finish the swing in time — could still translate straight INTO a land/town cell in a single tick (the
// reported bug: a pirate chasing a quarry well up onto land, then cutting through a town to dodge fire). This is the
// non-negotiable floor: clamp the forward STEP to the open-water distance so an NPC can NEVER cross a non-navigable
// cell, regardless of where the helm points. avoidLand turns it away; this stops it dead at the shore until it does.
const LAND_MARGIN = 6;     // halt this many world-units short of the shore so the hull never noses onto a land cell
const LAND_BRAKE  = 0.4;   // when the clamp bites, bleed speed hard — grinding the beach shouldn't build momentum

/** True on a legitimate final approach to a pier/home point, which by design sits on a NON-navigable cell (nav.js
 *  piers). The clamp is skipped here so a merchant still closes its delivery radius and a hunter pays off at home —
 *  every EARLIER waypoint is snapped to open water, so clamping those legs (and all combat) stays safe. */
function onLandApproach(npc) {
  if (npc.returning) return true;                                // navy hunter homing onto its origin port point
  return !!(npc.route && npc.routeIdx >= npc.route.length - 1);  // merchant on the last leg → the real pier point
}

/** Integrate the NPC's position for this tick with the hard land backstop. If the ship is somehow ALREADY embedded
 *  in land (a stale spawn, or one that slipped through before this guard), it ignores the helm and crawls toward the
 *  nearest open water so it works itself free instead of freezing in the rocks. */
function advanceNpc(npc, dtSec) {
  const step = npc.state.speed * moveConst.TRAVEL_SCALE * dtSec;

  // Recovery: on a non-navigable cell → steer for the nearest open water and crawl out, overriding the combat helm.
  const oc = nav.worldToCell(npc.state.x, npc.state.z);
  if (!nav.isNav(oc.cx, oc.cz)) {
    const snap = nav.snapToNav(oc.cx, oc.cz);
    if (snap) {
      const w = nav.cellToWorld(snap.cx, snap.cz);
      const eh = headingTo(npc.state.x, npc.state.z, w.x, w.z), ehr = eh * DEG;
      const es = Math.max(Math.abs(step), moveConst.TRAVEL_SCALE * dtSec);   // a steady crawl even if speed stalled
      npc.state.x += Math.sin(ehr) * es; npc.state.z += Math.cos(ehr) * es;
      npc.state.heading = eh; npc.yawRate = 0;
      return;
    }
  }

  const hr = npc.state.heading * DEG;
  let nx = npc.state.x + Math.sin(hr) * step, nz = npc.state.z + Math.cos(hr) * step;
  if (step > 0.001 && !onLandApproach(npc)) {
    const open = nav.openDistance(npc.state.x, npc.state.z, nx, nz);   // world dist ahead that stays on water
    if (open < step - 0.01) {
      const f = Math.max(0, open - LAND_MARGIN) / step;               // advance only the clear portion, short of shore
      nx = npc.state.x + Math.sin(hr) * step * f; nz = npc.state.z + Math.cos(hr) * step * f;
      npc.state.speed *= LAND_BRAKE;   // bleed momentum so it stops grinding the shore; avoidLand swings it away
    }
  }
  npc.state.x = nx; npc.state.z = nz;
}

/** A heading pointing away from nearby merchants (separation), or null if none are close. */
function avoidanceHeading(npc, fleet) {
  let sx = 0, sz = 0, n = 0;
  for (const o of fleet) {
    if (o === npc) continue;
    // Convoy-mates sail in a TIGHT formation (CONVOY_SPACING ≪ AVOID_R) — exempt them from the generic
    // separation force or it would blow the formation apart to the full avoidance radius (the old "loose
    // follow-the-leader" look). Their stations + station-keeping speed already keep them safely spaced.
    if (npc.convoyId && o.convoyId === npc.convoyId) continue;
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
      vesselName: 'Merchant ' + shipName(faction), vesselSlug: slug, callsign: '',
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

/** A weak intro-tutorial target (intro_combat): a feeble lone pinnace tied to `owner`, spawned on water a short
 *  sail away, slowed + low-HP so the player can run it down and sink it in a couple of broadsides, and low-skill
 *  so it only LIGHTLY fights back (a pinnace's small guns + poor aim). Tagged so the quest sink-hook + tavern
 *  rumour override recognise it; faction null → sinking it costs NO reputation. Reuses the merchant scaffolding. */
function makeTutorialTarget(players, owner) {
  const towns = economy.townList();
  if (!towns || !towns.length) return null;
  const op = owner.authPose || owner.state || { x: 0, z: 0 };
  let town = towns[0], bd = Infinity;
  for (const t of towns) { const d = (t.x - op.x) ** 2 + (t.z - op.z) ** 2; if (d < bd) { bd = d; town = t; } }
  // Give it the local faction so the normal merchant routing/tick works; the rep HIT on sinking it is suppressed
  // by the questTag guard in multiplayer.js (a tutorial kill costs nothing).
  const m = makeMerchant(players, town, town.faction || null, 'pinnace', null, 0.12, 'trader');
  // Own by the verified DB user id (player objects have no stable `.id` of their own — that's just the map key).
  m.questTag = 'tutorial'; m.questOwnerId = (owner.auth && owner.auth.userId) ?? null;
  m.state.vesselName = 'a lone pinnace';
  m.physics = { ...(m.physics || {}), maxSpeed: (((m.physics && m.physics.maxSpeed) || 6) * 0.6) };   // catchable
  // Spawn it SOMEWHAT NEAR the owner (~520 m) on navigable water they can actually sail to: try 8 bearings,
  // snap each to the sea, require sea-reachability from the owner (no land wall between), keep the CLOSEST valid
  // one — so the marked prey is reliably nearby, not flung across a bay by a bad snap.
  const DIST = 520;
  const a0 = Math.random() * Math.PI * 2;
  let sx = op.x, sz = op.z, bestD2 = Infinity, found = false;
  for (let k = 0; k < 8; k++) {
    const ang = a0 + (k / 8) * Math.PI * 2;
    const tx = op.x + Math.cos(ang) * DIST, tz = op.z + Math.sin(ang) * DIST;
    const pc = nav.worldToCell(tx, tz), sn = nav.snapToNav(pc.cx, pc.cz);
    if (!sn) continue;
    const w = nav.cellToWorld(sn.cx, sn.cz);
    if (!nav.reachable(op.x, op.z, w.x, w.z)) continue;            // must be sailable to (no land barrier)
    const d2 = (w.x - op.x) ** 2 + (w.z - op.z) ** 2;
    if (d2 < bestD2) { bestD2 = d2; sx = w.x; sz = w.z; found = true; }
  }
  if (!found) {                                                    // fallback: a single snapped offset (rare)
    const tx = op.x + Math.cos(a0) * DIST, tz = op.z + Math.sin(a0) * DIST;
    const pc = nav.worldToCell(tx, tz), sn = nav.snapToNav(pc.cx, pc.cz);
    if (sn) { const w = nav.cellToWorld(sn.cx, sn.cz); sx = w.x; sz = w.z; }
  }
  m.state.x = sx; m.state.z = sz; m.authPose.x = sx; m.authPose.z = sz;
  for (const z in m.combat.zones) { m.combat.zones[z] = Math.max(1, Math.round(m.combat.zones[z] * 0.4)); m.combat.maxHp[z] = m.combat.zones[z]; }
  return m;
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
  // Slot 0 is the trade leader; the next slot(s) are ARMED escorts (veteran brigs). A 3-ship convoy occasionally
  // fields TWO escorts (a heavily-guarded run) that pincer the foe; otherwise one escort screens the cargo.
  const escortCount = (size >= 3 && Math.random() < CONVOY_DOUBLE_ESCORT) ? 2 : 1;
  let leader = null;
  for (let i = 0; i < size; i++) {
    // Stagger the spawn positions so the ships don't stack at the pier.
    const ox = (i - (size - 1) / 2) * CONVOY_SPACING, oz = (i % 2 ? 1 : -1) * CONVOY_SPACING * 0.5;
    const isEscort = i >= 1 && i <= escortCount;   // slots 1..escortCount are escorts; slot 0 + the rest are traders
    const slug = isEscort ? 'brig' : pick(MERCHANT_SLUGS);
    const m = makeMerchant(players, town, faction, slug,
      { id: convoyId, role: i === 0 ? 'leader' : 'follower', slot: i, ox, oz },
      isEscort ? SKILL_ESCORT : SKILL_TRADER_CONVOY,
      isEscort ? 'escort' : 'trader');
    if (i === 0) leader = m;
  }
  return leader;
}

/** Pick a pirate lair: a patch of open, navigable water a fair way out from a random town (where shipping passes,
 *  but not on the pier). Tries several offsets and snaps each to the sea; returns {x,z} or null if none stuck. */
// Keep pirate lairs this far from the intro-tutorial spawn so a brand-new captain never starts within sight of a
// raider (> the pirate's leash + its lair-orbit radius, so its whole beat stays clear of the start port).
const INTRO_SAFE_R2 = 2200 * 2200;
function pickLair(towns) {
  const a = questAnchors.getAnchors && questAnchors.getAnchors();
  const spawn = a && a.spawn;                                // intro new-player spawn point (may be null pre-map)
  for (let attempt = 0; attempt < 12; attempt++) {
    const t = pick(towns);
    const ang = Math.random() * Math.PI * 2;
    const dist = 650 + Math.random() * 950;                 // ~0.65–1.6 km off a town (in the sea lanes)
    const tx = t.x + Math.cos(ang) * dist, tz = t.z + Math.sin(ang) * dist;
    const pc = nav.worldToCell(tx, tz), sn = nav.snapToNav(pc.cx, pc.cz);
    if (!sn) continue;
    const w = nav.cellToWorld(sn.cx, sn.cz);
    const dx = w.x - t.x, dz = w.z - t.z;
    if (dx * dx + dz * dz < 350 * 350) continue;            // not right on top of the town
    if (spawn) { const ex = w.x - spawn.x, ez = w.z - spawn.z; if (ex * ex + ez * ez < INTRO_SAFE_R2) continue; }   // clear of the tutorial start
    return { x: w.x, z: w.z };
  }
  return null;
}

/** Build + register one unaligned PIRATE at `lair`. Unique first+last name, no faction, no cargo; haunts the lair
 *  and runs down any vessel that strays within PIRATE_AGGRO_RANGE (see pirateHelm). `pirateLoot` tallies the gold
 *  it plunders so a well-fed pirate is worth a fatter bounty when a player finally sinks it. */
function makePirate(players, lair, slug) {
  const id = 'npc_' + (++seq);
  const sx = lair.x, sz = lair.z;
  const npc = {
    id, isNpc: true, isPirate: true, ws: { readyState: 3 }, faction: null,
    state: {
      x: sx, z: sz, heading: Math.random() * 360, speed: 0, turnRate: 0, sheetAngle: 0,
      isPortTack: false, anchored: false, sailState: 'full',
      vesselName: pick(PIRATE_FIRST) + ' ' + pick(PIRATE_LAST), vesselSlug: slug, callsign: '',
    },
    authPose: { x: sx, z: sz, heading: 0, speed: 0 },
    combat: combat.newCombatState(slug),
    lastUpdateMs: Date.now(),
    physics: getVesselDef(slug)?.physics || { maxSpeed: 8, accelerationRate: 0.28, minTackAngle: 36, sailAreaFactor: 0.34 },
    tack: 1, route: null, routeIdx: 0, curTownId: null, legTarget: null,
    gold: PIRATE_SEED_GOLD, cargo: {}, trip: null, phase: null,
    hostileToward: null, aggroUntil: 0, lastShotAt: 0, shotSeq: 0,
    maxCrew: crewFor(slug), crew: crewFor(slug), crewWound: 0,
    convoyId: null, convoyRole: null, convoySlot: 0,
    skill: PIRATE_SKILL, combatRole: 'pirate',
    // Pirate-specific: a fixed haunt, the current quarry id, an orbit phase. `gold` grows as it plunders merchants;
    // `bounty` is the price on its head (rises per merchant sunk); `piracyKills` counts merchants for the hunter
    // threshold + the tavern report. Player payout for sinking it = gold + bounty.
    lair: { x: lair.x, z: lair.z }, pirateTarget: null, patrolPhase: Math.random() * Math.PI * 2,
    bounty: 0, piracyKills: 0,
  };
  players.set(id, npc);
  return npc;
}

/** Nearest town owning a faction to (x,z), or null if no faction holds a town. */
function nearestFactionTown(towns, x, z) {
  let best = null, bd = Infinity;
  for (const t of towns) {
    if (!t.faction) continue;
    const dx = t.x - x, dz = t.z - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/** Launch a navy PIRATE HUNTER from `town` after `pirate`: a heavy brig (≥ any pirate's power), veteran skill,
 *  flying `town`'s flag. It remembers its origin so it can sail home + pay off once the pirate is dead (hunterHelm).
 *  Labelled "<Nation> Navy — Pirate Hunter" on the client. */
function makeHunter(players, town, pirate) {
  const id = 'npc_' + (++seq);
  const slug = 'brig';   // a navy warship — equal or greater power than any pirate rig
  const sx = town.x, sz = town.z;
  const npc = {
    id, isNpc: true, isHunter: true, ws: { readyState: 3 }, faction: town.faction,
    state: {
      x: sx, z: sz, heading: Math.random() * 360, speed: 0, turnRate: 0, sheetAngle: 0,
      isPortTack: false, anchored: false, sailState: 'full',
      vesselName: shipName(town.faction), vesselSlug: slug, callsign: '',
    },
    authPose: { x: sx, z: sz, heading: 0, speed: 0 },
    combat: combat.newCombatState(slug),
    lastUpdateMs: Date.now(),
    physics: getVesselDef(slug)?.physics || { maxSpeed: 8, accelerationRate: 0.28, minTackAngle: 36, sailAreaFactor: 0.34 },
    tack: 1, route: null, routeIdx: 0, curTownId: town.id, legTarget: null,
    gold: 0, cargo: {}, trip: null, phase: null,
    hostileToward: null, aggroUntil: 0, lastShotAt: 0, shotSeq: 0,
    maxCrew: crewFor(slug), crew: crewFor(slug), crewWound: 0,
    convoyId: null, convoyRole: null, convoySlot: 0,
    skill: HUNTER_SKILL, combatRole: 'hunter',
    // Hunter-specific: the pirate it's tasked to kill, its home port, and whether it's on the way back to pay off.
    huntTarget: pirate.id, origin: { x: town.x, z: town.z }, homeTownId: town.id, returning: false,
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
function tickNpcs(players, dtSec, broadcastLeave, nowMs, fireShot, announce) {
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
    members.forEach((m) => { m.pincerSide = null; });   // cleared unless re-assigned for a 2-escort crossfire below
    const threat = convoyFocusTarget(members, players, nowMs);   // ONE shared focus target (weakest reachable enemy)
    // A war target commits the convoy like a provoked one (close + fight if it can hold its own; a weaker convoy
    // still flees — so a strong convoy presses, a weak one runs: convoy-on-convoy resolves naturally).
    const stance = threat ? convoyStance(members, threat.foe, threat.provoked || threat.war, players, nowMs) : 'route';
    const escorts = members.filter((m) => m.combatRole === 'escort' && !(m.combat && m.combat.sunk));
    // Pincer: 2+ escorts fighting → lock alternating flanks so they catch the foe in a crossfire.
    if (stance === 'fight' && escorts.length >= 2) escorts.forEach((e, i) => { e.pincerSide = i % 2 === 0 ? 1 : -1; });
    convoyPlan.set(cid, { foe: threat && threat.foe, provoked: !!(threat && threat.provoked), stance, escorts });

    // Telegraph + debug-log convoy combat-state TRANSITIONS (commit to fight / break off), per-convoy rate-limited.
    const tele = convoyTele.get(cid) || { prevStance: 'route', lastAnnounce: 0 };
    let kind = null;
    if (stance === 'fight' && tele.prevStance !== 'fight') kind = escorts.length >= 2 ? 'pincer' : 'engage';
    else if (stance === 'flee' && tele.prevStance === 'fight') kind = 'breakoff';
    if (kind) {
      if (NPC_DEBUG) console.log(`[npc] convoy ${cid} ${tele.prevStance}→${stance} (${kind}); escorts=${escorts.length} foe=${threat && threat.foe.state && threat.foe.state.callsign}`);
      if (CONVOY_TELEGRAPH && announce && nowMs - tele.lastAnnounce > ANNOUNCE_COOLDOWN_MS) {
        let cx = 0, cz = 0; for (const m of members) { cx += m.state.x; cz += m.state.z; }
        announce(cx / members.length, cz / members.length, members[0].faction, kind);
        tele.lastAnnounce = nowMs;
      }
    }
    tele.prevStance = stance;
    convoyTele.set(cid, tele);
  }
  for (const cid of convoyTele.keys()) { if (!convoyGroups.has(cid)) convoyTele.delete(cid); }   // prune vanished convoys

  for (const npc of fleet) {
    // A sunk merchant (salvage already dropped by resolveHit) lingers briefly so its capsize plays, then despawns.
    if (npc.combat && npc.combat.sunk) {
      if (!npc.sinkAt) {
        npc.sinkAt = nowMs;
        // Morale shock: losing a consort rattles the rest of the convoy (E4) → far more flee-prone for a while.
        if (npc.convoyId) { for (const m of convoyMembers(npc, players)) { if (m !== npc) m.moraleShakeUntil = nowMs + MORALE_SHAKE_MS; } }
      }
      if (nowMs - npc.sinkAt >= SINK_LINGER_MS) {
        // A sunk pirate schedules its replacement for 5–10 min out (varied) so the lane it haunted stays clear a
        // while, then the plague returns. Capped so a burst of sinkings can't balloon the queue.
        if (npc.isPirate && !npc.isHunter && pirateRespawnQueue.length < 16) {
          const dueMs = nowMs + PIRATE_RESPAWN_MIN_MS + Math.random() * (PIRATE_RESPAWN_MAX_MS - PIRATE_RESPAWN_MIN_MS);
          pirateRespawnQueue.push(dueMs);
          console.log(`[pirate] ${npc.state.vesselName || 'raider'} sunk → respawn in ~${Math.round((dueMs - nowMs) / 60000)} min (queued=${pirateRespawnQueue.length})`);
        }
        players.delete(npc.id); broadcastLeave(npc.id);
      }
      continue;
    }

    const ph = npc.physics;
    let desired, foe = null;
    npc.raking = false;   // re-armed by engageHeading each tick it actually has a rake; cleared otherwise
    if (npc.isPirate) {
    // Pirates ignore trade routes + nation rep entirely: they hunt any vessel that nears their lair, else loiter
    // there (pirateHelm sets engaged/fleeing + returns the quarry for the shared gunnery + speed model below).
    const r = pirateHelm(npc, players, wind, ph, nowMs);
    desired = r.desired; foe = r.foe;
    } else if (npc.isHunter) {
    // Navy pirate-hunter: run the assigned pirate down, then sail home + pay off (despawn on arrival).
    const r = hunterHelm(npc, players, wind, ph);
    desired = r.desired; foe = r.foe;
    if (npc._despawn) { players.delete(npc.id); broadcastLeave(npc.id); continue; }   // reached home port → mission over
    } else {
    // D3: react to the right threat — a PROVOKED attacker (was fired on) or a nation-HATED player within range —
    // with the stance set by RELATIVE STRENGTH: fight if it can hold its own, flee/avoid if outmatched or badly
    // hurt, or just hold the trade lane (route) while a hated stranger lurks beyond ENGAGE_RANGE.
    // Convoy members take the SHARED plan (same foe + stance → unison); solo merchants assess for themselves.
    let threat, stance, convoyEscorts = null;
    if (npc.convoyId && convoyPlan.has(npc.convoyId)) {
      const plan = convoyPlan.get(npc.convoyId);
      threat = plan.foe ? { foe: plan.foe, provoked: plan.provoked } : null;
      stance = plan.stance;
      convoyEscorts = plan.escorts;
      // Every member commits the grudge to the shared foe so its OWN gunnery bears + it gives chase / flees as one.
      if (threat && (stance === 'fight' || stance === 'flee')) markHostile(npc, plan.foe.id, nowMs);
    } else {
      threat = findThreat(npc, players, nowMs);
      stance = threat ? combatStance(npc, threat.foe, threat.provoked) : 'route';
    }
    foe = (stance === 'fight' || stance === 'flee') ? threat.foe : null;
    if (foe) {
      // Combat helm: jockey for a broadside when fighting (A2), bear off and run when fleeing (A4). BOTH stay
      // "engaged" so the gunnery arc gate can still loose a parting broadside while running. An UNPROVOKED merchant
      // that elects to fight commits a timed grudge so it presses the engagement instead of chattering at the range
      // edge; the grudge lapses (GIVE_UP_RANGE / AGGRO_MS) and it returns to trade once the foe breaks off.
      if (stance === 'fight' && !threat.provoked) markHostile(npc, threat.foe.id, nowMs);
      npc.engaged = true;
      // Convoy roles: when the convoy FIGHTS, the armed ESCORT engages while the cargo TRADERS evade. E3 SCREENS —
      // a trader tucks behind its escort (escort interposed) rather than just running flat-out; when the convoy
      // FLEES, everyone runs together (escort covering with parting shots).
      const screening = npc.convoyId && npc.combatRole === 'trader' && stance === 'fight';
      const evade = stance === 'flee' || screening;
      npc.fleeing = evade;
      if (screening) {
        desired = convoyScreenHeading(npc, foe, convoyEscorts || [], wind, ph);
      } else if (evade) {
        // Imperfect helmsman under pressure: a skill-scaled wobble around the optimal escape line — a panicky trader
        // wanders badly (easy to run down), a veteran flees clean. CATCH-UP lever, not a stat nerf.
        desired = escapeHeading(npc, foe, wind, ph);
        npc.fleeWander = (npc.fleeWander || 0) * 0.96 + (Math.random() - 0.5) * fleeWanderAmp(npcSkill(npc));
        desired = (desired + npc.fleeWander + 360) % 360;
      } else {
        desired = engageHeading(npc, foe, wind, ph);
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
    }   // end merchant (non-pirate) branch
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
    const cruiseCap = npc.isHunter ? HUNTER_CRUISE : npc.isPirate ? PIRATE_CRUISE : MERCHANT_CRUISE;   // hunters fastest (run the pirate down), pirates next
    sp = Math.max(-1.5, Math.min(ph.maxSpeed * cruiseCap, sp));                    // NPCs never hit a trimmed player's full speed
    // ── Convoy formation speed (non-combat) ──────────────────────────────────────────────────────────────────
    // A FOLLOWER in formation regulates its sails to hold STATION (the `_formSpeed` convoyFollowHeading stashed
    // this tick) rather than sailing flat-out → the column matches pace + closes gaps instead of stringing out.
    if (npc._formSpeed != null) {
      const target = Math.max(0, Math.min(ph.maxSpeed * cruiseCap, npc._formSpeed));
      sp = vNow + (target - vNow) * Math.min(1, CONVOY_SPEED_RESPONSE * dtSec);    // ease toward station-keeping speed
      npc._formSpeed = null;                                                       // consume (cleared if combat next tick)
    } else if (npc.convoyId && npc.convoyRole === 'leader' && !npc.engaged && !npc.fleeing) {
      // The LEADER throttles back for a lagging straggler so the convoy moves together (released the instant it fights).
      sp = Math.min(sp, ph.maxSpeed * cruiseCap * convoyLeaderDrag(npc, players));
    }
    npc.state.speed = Math.abs(sp) < 0.001 ? 0 : sp;
    npc.state.isPortTack = (((npc.state.heading - wind.windBearing) % 360 + 360) % 360) <= 180;
    advanceNpc(npc, dtSec);   // integrate position with the HARD land backstop (never translate through land/town)
    // keep the authoritative pose in sync so player↔NPC collision (which reads authPose) works
    npc.authPose.x = npc.state.x; npc.authPose.z = npc.state.z;
    npc.authPose.heading = npc.state.heading; npc.authPose.speed = npc.state.speed;
    npc.lastUpdateMs = nowMs;

    // ── Return fire (A3): when engaged, a gun bears, and the reload is up, hand a leading solution to the
    // server's shared shot adjudicator. The reload SCALES WITH CREW (a thinned crew works the guns slower — the
    // same crewMul the player feels via getReloadWindow), and the merchant picks round vs bar shot tactically.
    const vsNpc = !!(foe && foe.isNpc);   // private NPC-vs-NPC fight → tighter aim + brisker reload (never vs a player)
    const reloadMs = (NPC_RELOAD_MS / crewMul) * (vsNpc ? NPC_VS_NPC_RELOAD : 1);
    if (npc.engaged && foe && fireShot && nowMs - (npc.lastShotAt || 0) >= reloadMs) {
      const dist = Math.hypot(foe.state.x - npc.state.x, foe.state.z - npc.state.z);
      const shot = chooseNpcShot(npc, foe, dist);
      const sol = firingSolution(npc, foe.state, Cc.SHOT_TYPES[shot].v, vsNpc ? NPC_VS_NPC_ACC : 1);
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
  // "Where are the ships" hint for EVERY player: feed the live fleet to the density tracker (throttled inside),
  // then re-send the cluster hotspots to a player only when they change (version bump) or on first connect.
  shippingLanes.update(npcs, nowMs);
  const laneVer = shippingLanes.getVersion();
  let laneMsg = null;
  const laneMsgFor = () => (laneMsg || (laneMsg = JSON.stringify({ type: 'shipping_lanes', hotspots: shippingLanes.hotspots() })));
  const msgCache = new Map();
  const msgFor = (n) => {
    let m = msgCache.get(n.id);
    if (!m) {
      m = JSON.stringify({ type: 'update', id: n.id, ...n.state, npc: true, faction: n.faction || null,
        role: n.isPirate ? 'pirate' : n.isHunter ? 'hunter' : 'merchant', ts: nowMs, seq: 0 });
      msgCache.set(n.id, m);
    }
    return m;
  };
  const merchants = npcs.filter((n) => !n.isPirate && !n.isHunter);   // pirates + navy hunters aren't trade ships → out of the merchant map feeds
  // Full-fleet map feed for staff: Owners/Admins get every merchant's position on the minimap (render is still
  // interest-managed below — this is map markers only, no extra ships built). Built once, reused for all staff.
  let allMsg = null;
  const allMerchantsMsg = () => {
    if (allMsg === null) {
      allMsg = JSON.stringify({
        type: 'all_merchants',
        ships: merchants.map((n) => ({ x: +n.state.x.toFixed(1), z: +n.state.z.toFixed(1) })),
      });
    }
    return allMsg;
  };
  // Staff also get every PIRATE + navy HUNTER on the minimap (distinct markers + a hover readout): pirates carry
  // their name / bounty / kills, hunters their nation. Built once, reused for all staff.
  let pirMsg = null;
  const allPiratesMsg = () => {
    if (pirMsg === null) {
      const ships = [];
      for (const n of npcs) {
        if (n.isPirate) {
          ships.push({ x: +n.state.x.toFixed(1), z: +n.state.z.toFixed(1), role: 'pirate',
            name: n.state.vesselName || 'Pirate', bounty: (n.gold | 0) + (n.bounty | 0), kills: n.piracyKills | 0,
            slug: n.state.vesselSlug });
        } else if (n.isHunter) {
          ships.push({ x: +n.state.x.toFixed(1), z: +n.state.z.toFixed(1), role: 'hunter',
            name: n.state.vesselName || 'Hunter', faction: n.faction || null });
        }
      }
      pirMsg = JSON.stringify({ type: 'all_pirates', ships });
    }
    return pirMsg;
  };
  for (const [, p] of players) {
    if (p.isNpc || !p.ws || p.ws.readyState !== 1 || !p.state) continue;
    if (p._laneVer !== laneVer) { p.ws.send(laneMsgFor()); p._laneVer = laneVer; }   // lane hint (all players, on change)
    const near = [];
    let nrX = null, nrZ = null, nrD2 = Infinity;   // the single GLOBAL nearest MERCHANT (any distance, for the map beacon)
    for (const n of npcs) {
      const dx = n.state.x - p.state.x, dz = n.state.z - p.state.z, d2 = dx * dx + dz * dz;
      if (!n.isPirate && !n.isHunter && d2 < nrD2) { nrD2 = d2; nrX = n.state.x; nrZ = n.state.z; }   // beacon → trade ships only
      if (d2 <= VIEW_R2) near.push({ n, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);
    const visible = new Set();
    for (let i = 0; i < near.length && i < MAX_VISIBLE; i++) visible.add(near[i].n.id);
    // Always render a pirate OR a navy hunter that's closed within PIRATE_VIS_R (a chase the player should see)
    // even past the nearest-N cutoff — a combatant you can't see shooting nearby would read as a bug.
    for (const c of near) if ((c.n.isPirate || c.n.isHunter) && c.d2 <= PIRATE_VIS_R2) visible.add(c.n.id);
    // Always render this player's tavern-rumour target (so its map marker + hull persist while they hunt it
    // down, even past the normal nearest-N cutoff). Auto-clear the grudge once the ship has despawned/sunk.
    if (p.rumorShipId) {
      if (players.has(p.rumorShipId)) visible.add(p.rumorShipId);
      else p.rumorShipId = null;
    }
    // Same for the pirate the player asked the tavern about — keep it streamed (+ its map marker) at any range.
    if (p.pirateMarkId) {
      if (players.has(p.pirateMarkId)) visible.add(p.pirateMarkId);
      else p.pirateMarkId = null;
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
      p.ws.send(allPiratesMsg());   // pirates + navy hunters on the staff minimap
    } else {
      p.ws.send(nrX === null ? JSON.stringify({ type: 'nearest_merchant', x: null })
        : JSON.stringify({ type: 'nearest_merchant', x: +nrX.toFixed(1), z: +nrZ.toFixed(1) }));
    }
  }
}

/** Keep the merchant fleet AND the pirate population topped up; spawn fresh merchants at town piers and fresh
 *  pirates at open-water lairs. Both ramp gradually (a few per tick) so a fresh server fills in over ~minutes.
 *  Also dispatches navy PIRATE HUNTERS against any pirate that's strangled a shipping lane. `announceHunter`
 *  (optional: (faction, townName, pirateName) → void) telegraphs a launch to players. */
function spawnerTick(players, announceHunter) {
  const towns = economy.townList();
  if (towns.length < 2) return;
  const target = targetFleet(towns.length);
  let spawned = 0;
  while (npcCount(players) < target && spawned < 3) { spawnNpc(players, towns); spawned++; }   // ramp up gradually
  // Pirates: a separate, smaller population that haunts open water (not counted in the merchant fleet target).
  const pTarget = targetPirates(towns.length);
  const nowP = Date.now();
  let pSpawned = 0;
  // (a) Delayed respawns: a pirate sunk earlier scheduled its replacement 5–10 min out. Spawn any that are now due.
  while (pSpawned < 2 && pirateCount(players) < pTarget) {
    const i = pirateRespawnQueue.findIndex((t) => t <= nowP);
    if (i === -1) break;
    const lair = pickLair(towns);
    if (!lair) { warnNoLair('respawn due'); break; }
    pirateRespawnQueue.splice(i, 1);
    makePirate(players, lair, pick(PIRATE_SLUGS));
    pSpawned++;
    console.log(`[pirate] respawn fired (live=${pirateCount(players)}/${pTarget}, queued=${pirateRespawnQueue.length})`);
  }
  // (b) Initial / safety fill: cover any deficit NOT already waiting on a cooldown (fresh server, or pirates lost
  //     without a scheduled replacement) so the seas are never permanently empty. The cooldown only gates sink-
  //     driven respawns via the queue above; this keeps a fresh server (and any unaccounted gap) populated promptly.
  while (pSpawned < 2 && pirateCount(players) + pirateRespawnQueue.length < pTarget) {
    const lair = pickLair(towns);
    if (!lair) { warnNoLair('safety-fill'); break; }
    makePirate(players, lair, pick(PIRATE_SLUGS));
    pSpawned++;
    console.log(`[pirate] safety-fill spawned (live=${pirateCount(players)}/${pTarget})`);
  }
  // Pirate hunters: any pirate that's sunk ≥ PIRATE_HUNT_THRESHOLD merchants draws ONE navy warship from the
  // nearest faction town. The previous hunter being lost (sunk) lets the nation send another — the pirate stays
  // a marked ship until it's put down. The threshold delay is deliberate: a player gets first crack at the bounty.
  for (const [, p] of players) {
    if (!p.isPirate || (p.combat && p.combat.sunk)) continue;
    if (p.hunterId && !players.has(p.hunterId)) p.hunterId = null;          // previous hunter lost → may send another
    if (p.hunterId || (p.piracyKills | 0) < PIRATE_HUNT_THRESHOLD) continue;
    const town = nearestFactionTown(towns, p.state.x, p.state.z);
    if (!town) continue;
    const h = makeHunter(players, town, p);
    p.hunterId = h.id;
    if (announceHunter) announceHunter(town.faction, town.name, p.state.vesselName);
  }
}

/** Admin diagnostic: force the pirate population up to target NOW (ignoring the respawn cooldown) and log a full
 *  trace to the server console — town count, target, each lair pick, and a deep nav probe if NOTHING spawns. This is
 *  the tool for the "no pirates on live but fine locally" case: if pickLair keeps returning null here, the live nav
 *  grid / terrain data is the culprit (not the spawn logic). Returns a summary object. Clears the respawn queue too. */
function debugSpawnPirates(players) {
  const towns = economy.townList();
  const target = targetPirates(towns.length);
  const before = pirateCount(players);
  const lines = [`towns=${towns.length} target=${target} liveBefore=${before} queued=${pirateRespawnQueue.length}`];
  if (towns.length < 2) {
    lines.push('ABORT: fewer than 2 towns — economy/nav not ready');
    lines.forEach((l) => console.log('[pirate-debug]', l));
    return { ok: false, towns: towns.length, target, before, after: before, spawned: 0, lairFails: 0, lines };
  }
  pirateRespawnQueue.length = 0;   // a manual full spawn supersedes any pending cooldowns
  let spawned = 0, lairFails = 0, guard = 0;
  while (pirateCount(players) < target && guard++ < 60) {
    const lair = pickLair(towns);
    if (!lair) { lairFails++; continue; }
    const p = makePirate(players, lair, pick(PIRATE_SLUGS));
    spawned++;
    lines.push(`spawned ${p.state.vesselName} (${p.state.vesselSlug}) @ (${lair.x.toFixed(0)}, ${lair.z.toFixed(0)})`);
  }
  if (lairFails) lines.push(`pickLair returned null ${lairFails}×`);
  if (spawned === 0) {
    // Deep nav probe: is snapToNav itself failing on this host? Try a fixed offshore point off the first town.
    const t = towns[0];
    const tx = t.x + 1200, tz = t.z + 1200;
    let cell = null, snap = null, err = null;
    try { cell = nav.worldToCell(tx, tz); snap = nav.snapToNav(cell.cx, cell.cz); }
    catch (e) { err = e.message; }
    lines.push(`NAV PROBE town0="${t.name}" @(${t.x | 0},${t.z | 0}) → cell=${cell ? `(${cell.cx},${cell.cz})` : 'NULL'} snap=${snap ? `(${snap.cx},${snap.cz})` : 'NULL'}${err ? ` ERR=${err}` : ''}`);
    lines.push('→ snap NULL means the nav grid is empty/unloaded on this host (the live data differs from local).');
  }
  lines.push(`liveAfter=${pirateCount(players)} spawned=${spawned}`);
  lines.forEach((l) => console.log('[pirate-debug]', l));
  return { ok: true, towns: towns.length, target, before, after: pirateCount(players), spawned, lairFails, lines };
}

module.exports = {
  tickNpcs, broadcastInterest, spawnerTick, debugSpawnPirates, targetFleet, npcCount, markHostile, isHostile, makeTutorialTarget,
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
    convoyStation, convoyLeaderDrag, CONVOY_SPACING, CONVOY_FORM_BAND, CONVOY_SPEED_GAIN, CONVOY_LAG_FULL, CONVOY_LEADER_MIN,
    atWar, nearestWarEnemy, WAR_DETECT, WAR_LEASH,
    CONVOY_CHANCE, CONVOY_MIN, CONVOY_MAX, CONVOY_SQUAD_RANGE,
    npcSkill, fleeHealthFor, avoidRatioFor, aimSpreadMul, fleeWanderAmp,
    SKILL_TRADER_SOLO, SKILL_TRADER_CONVOY, SKILL_ESCORT,
    chooseNpcShot, foeMastFrac, RAKE_CONE, RAKE_SKILL,
    convoyFocusTarget, convoyScreenHeading, SCREEN_DIST, CONVOY_DOUBLE_ESCORT,
    PRESS_HULL, MORALE_SHAKE_MS, MORALE_SHAKE_FACTOR,
    makePirate, pickLair, pirateHelm, nearestPrey, pirateCount, targetPirates,
    PIRATE_AGGRO_RANGE, PIRATE_GIVE_UP, PIRATE_LEASH, PIRATE_SKILL, PIRATE_CRUISE,
    makeHunter, hunterHelm, nearestFactionTown, PIRATE_HUNT_THRESHOLD, HUNTER_CRUISE, HUNTER_APPROACH,
    avoidLand, advanceNpc, onLandApproach, LAND_MARGIN,
  },
};
