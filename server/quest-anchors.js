/**
 * Map-derived anchors for the intro tutorial. The new-player spawn and the tutorial's start port CANNOT be
 * hardcoded — every map regen (npm run terrain) moves the towns and bumps MAP_VERSION. So we DERIVE them from
 * the live town list + the navgrid at load time: a pure function of the current map, recomputed whenever the map
 * changes, so it can never go stale and needs no separate bake step.
 *
 *   portA      — the humble start port (small/medium coastal town that has a sea-reachable neighbour for the
 *                trade leg). The tutorial's tavern (rumour mechanic) is here too (taverns aren't town-gated).
 *   portB      — that nearest sea-reachable neighbour (a convenience waypoint; the SELL port in the trade quest
 *                is resolved live from economy's sell-hint, not baked).
 *   spawn      — a navigable open-water point just off portA's pier, facing toward portB (open sea).
 *
 * Consumed by quest.js (resolves symbolic anchors like 'tutorial.spawn'/'tutorial.portA') and by the new-player
 * join path (initial position). Cached per map; call reset() on a map reload.
 */
const economy = require('./economy');
const nav     = require('./nav');

let cache = null;

/** Nearest OTHER town reachable by sea from `t`, or null. */
function nearestReachable(t, towns) {
  let best = null, bestD2 = Infinity;
  for (const o of towns) {
    if (o.id === t.id) continue;
    const d2 = (o.x - t.x) ** 2 + (o.z - t.z) ** 2;
    if (d2 >= bestD2) continue;
    if (!nav.reachable(t.x, t.z, o.x, o.z)) continue;   // must be sailable between them
    best = o; bestD2 = d2;
  }
  return best;
}

/** A navigable open-water point just off the port, nudged toward `toward` (kept on water), with a heading. */
function offshoreSpawn(port, toward) {
  // Snap the port's pier cell to the main sea, then step a little further offshore toward the neighbour.
  const pc = nav.worldToCell(port.x, port.z);
  const sc = nav.snapToNav(pc.cx, pc.cz);
  if (!sc) { return { x: port.x, z: port.z, heading: 0 }; }   // no main-sea cell near the port (shouldn't happen)
  let { x, z } = nav.cellToWorld(sc.cx, sc.cz);
  if (toward) {
    const dx = toward.x - x, dz = toward.z - z, len = Math.hypot(dx, dz) || 1;
    for (const step of [80, 55, 30]) {                 // try progressively closer offsets; keep it on water
      const nx = x + (dx / len) * step, nz = z + (dz / len) * step;
      if (nav.reachable(x, z, nx, nz)) { x = nx; z = nz; break; }
    }
  }
  // heading: face toward the neighbour (forward = (sin h, cos h); 0=N/+Z, 90=E/+X), in degrees 0..360.
  const hx = (toward ? toward.x : port.x) - x, hz = (toward ? toward.z : port.z) - z;
  const heading = ((Math.atan2(hx, hz) * 180 / Math.PI) + 360) % 360;
  return { x, z, heading };
}

/** Derive the anchors from the current map. Returns null until towns + navgrid are loaded. */
function derive() {
  const towns = economy.townList();
  if (!towns || towns.length === 0) return null;
  // Candidates: towns with a sea-reachable neighbour. Prefer a small/medium "local trader" port (the mutiny
  // story fits a humble start), then the most central. Deterministic (stable id tiebreak) so it never flickers.
  const tierRank = { small: 0, medium: 1, large: 2, capital: 3 };
  const cx = towns.reduce((s, t) => s + t.x, 0) / towns.length;
  const cz = towns.reduce((s, t) => s + t.z, 0) / towns.length;
  let portA = null, portB = null, best = null;
  for (const t of towns) {
    const nb = nearestReachable(t, towns);
    if (!nb) continue;
    const score = (tierRank[t.tier] ?? 1) * 1e9 + ((t.x - cx) ** 2 + (t.z - cz) ** 2);   // small + central first
    if (best === null || score < best || (score === best && (!portA || t.id < portA.id))) {
      best = score; portA = t; portB = nb;
    }
  }
  if (!portA) { portA = towns[0]; portB = nearestReachable(towns[0], towns); }   // fallback: any town
  const spawn = offshoreSpawn(portA, portB);
  return { spawn, portA: portA.id, portB: portB ? portB.id : portA.id, tavernPort: portA.id };
}

/** The cached anchors for the current map (derives on first call). null if the map isn't loaded yet. */
function getAnchors() {
  if (cache) return cache;
  const a = derive();
  if (a) cache = a;          // cache only a successful derive (towns/nav ready)
  return a;
}

/** Drop the cache (call on a map reload so the next getAnchors() re-derives for the new map). */
function reset() { cache = null; }

module.exports = { getAnchors, reset, _derive: derive };
