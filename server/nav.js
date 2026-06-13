'use strict';

/**
 * Sea-route navigation for NPC merchant ships (NPC Traders — NP1).
 *
 * Consumes a coarse NAVIGABLE-WATER grid baked into the terrain manifest at build time (manifest.navGrid +
 * navgrid.bin — a bitpacked res×res mask; bit set = open water a ship can sail). At runtime it answers
 * `findPath(ax,az, bx,bz)` → a list of world {x,z} waypoints that stays on navigable water, via 8-connected
 * A* + string-pull smoothing. Towns sit at shallow piers (non-navigable cells), so start/goal are snapped to
 * the nearest open-water cell and a short straight APPROACH segment connects the snapped cell to the real
 * pier point. Routes are cached per ordered cell-pair.
 *
 * Grid → world uses the SAME mapping as the build + terrain-mask (Z flipped: world +Z = north = grid row 0).
 */

const fs = require('fs');
const path = require('path');
const terrainConfig = require('./config/terrain.config');

let res = 0;                 // grid resolution (res×res)
let bits = null;            // Uint8Array bitset, bit (cz*res+cx)
let wb = null;              // { minX, maxX, minZ, maxZ }
let loaded = false;
let comp = null;            // Int32Array component id per cell (-1 = non-nav), using A*'s move rule
let mainComp = -1;          // the largest component (the open sea everything routes through)
const pathCache = new Map(); // 'cx,cz>cx,cz' → waypoints[] | null

const SNAP_MAX_RINGS = 96;   // how far (in cells) to search outward for the open sea near a pier

// ── grid access ───────────────────────────────────────────────────────────────
function inGrid(cx, cz) { return cx >= 0 && cz >= 0 && cx < res && cz < res; }
function isNav(cx, cz) {
  if (!inGrid(cx, cz)) return false;
  const i = cz * res + cx;
  return (bits[i >> 3] & (1 << (i & 7))) !== 0;
}
function worldToCell(x, z) {
  const u = (x - wb.minX) / (wb.maxX - wb.minX);
  const v = (wb.maxZ - z) / (wb.maxZ - wb.minZ);   // Z flip: +Z (north) → row 0
  let cx = Math.floor(u * res), cz = Math.floor(v * res);
  cx = cx < 0 ? 0 : (cx > res - 1 ? res - 1 : cx);
  cz = cz < 0 ? 0 : (cz > res - 1 ? res - 1 : cz);
  return { cx, cz };
}
function cellToWorld(cx, cz) {
  return {
    x: wb.minX + ((cx + 0.5) / res) * (wb.maxX - wb.minX),
    z: wb.maxZ - ((cz + 0.5) / res) * (wb.maxZ - wb.minZ),
  };
}

/** Can a unit step diagonally from (cx,cz) by (dx,dz)? Target nav AND no corner-cut (both shared orthogonals nav). */
function diagOpen(cx, cz, dx, dz) { return isNav(cx + dx, cz + dz) && isNav(cx + dx, cz) && isNav(cx, cz + dz); }

/** Label connected components with the EXACT traversal rule A* uses (4 ortho + 4 diagonal w/o corner-cutting),
 *  and record the largest (the open sea). So snapToNav can route every town to a single reachable body. */
function computeComponents() {
  comp = new Int32Array(res * res).fill(-1);
  let best = -1, bestN = 0, next = 0;
  const stack = [];
  for (let z0 = 0; z0 < res; z0++) {
    for (let x0 = 0; x0 < res; x0++) {
      if (!isNav(x0, z0) || comp[z0 * res + x0] >= 0) continue;
      const id = next++; let n = 0; stack.length = 0; stack.push(x0, z0); comp[z0 * res + x0] = id;
      while (stack.length) {
        const cz = stack.pop(), cx = stack.pop(); n++;
        const tryCell = (nx, nz) => { if (isNav(nx, nz) && comp[nz * res + nx] < 0) { comp[nz * res + nx] = id; stack.push(nx, nz); } };
        tryCell(cx + 1, cz); tryCell(cx - 1, cz); tryCell(cx, cz + 1); tryCell(cx, cz - 1);
        for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (diagOpen(cx, cz, dx, dz)) tryCell(cx + dx, cz + dz);
      }
      if (n > bestN) { bestN = n; best = id; }
    }
  }
  mainComp = best;
}

/** Snap (cx,cz) to the nearest cell of the OPEN SEA (the main component) by expanding-ring search. Towns sit
 *  at shallow piers (and sometimes in tiny enclosed lagoon pockets), so we deliberately pull them out to the
 *  one navigable body all routes share — the approach leg then crosses the local shallow water. */
function snapToNav(cx, cz) {
  if (comp && isNav(cx, cz) && comp[cz * res + cx] === mainComp) return { cx, cz };
  for (let r = 1; r <= SNAP_MAX_RINGS; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // ring perimeter only
        const nx = cx + dx, nz = cz + dz;
        if (inGrid(nx, nz) && isNav(nx, nz) && (!comp || comp[nz * res + nx] === mainComp)) return { cx: nx, cz: nz };
      }
    }
  }
  return null;
}

// ── A* (8-connected, octile heuristic) ──────────────────────────────────────────
const SQRT2 = Math.SQRT2;
function octile(ax, az, bx, bz) {
  const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
  return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
}
function astar(s, g) {
  if (s.cx === g.cx && s.cz === g.cz) return [s];
  const open = new Map();           // key → {cx,cz,g,f}
  const came = new Map();           // key → prevKey
  const gScore = new Map();
  const key = (cx, cz) => cz * res + cx;
  const sk = key(s.cx, s.cz), gk = key(g.cx, g.cz);
  open.set(sk, { cx: s.cx, cz: s.cz, f: octile(s.cx, s.cz, g.cx, g.cz) });
  gScore.set(sk, 0);
  const N = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];
  let guard = res * res * 4;
  while (open.size && guard-- > 0) {
    // pop lowest f (linear scan — grids are small; fine for 256²-class with short routes)
    let bestK = null, bestF = Infinity;
    for (const [k, n] of open) { if (n.f < bestF) { bestF = n.f; bestK = k; } }
    const cur = open.get(bestK); open.delete(bestK);
    if (bestK === gk) {
      const out = [];
      let k = gk;
      while (k !== undefined) { const cx = k % res, cz = (k - cx) / res; out.push({ cx, cz }); k = came.get(k); }
      return out.reverse();
    }
    const cg = gScore.get(bestK);
    for (const [dx, dz, w] of N) {
      const nx = cur.cx + dx, nz = cur.cz + dz;
      if (!isNav(nx, nz)) continue;
      if (w > 1 && (!isNav(cur.cx + dx, cur.cz) || !isNav(cur.cx, cur.cz + dz))) continue;   // no diagonal corner-cut
      const nk = key(nx, nz), ng = cg + w;
      if (ng < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, ng);
        came.set(nk, bestK);
        open.set(nk, { cx: nx, cz: nz, f: ng + octile(nx, nz, g.cx, g.cz) });
      }
    }
  }
  return null;
}

/** Supercover line test between two cells — true if every cell the segment passes through is navigable. */
function lineClear(ax, az, bx, bz) {
  let x0 = ax, z0 = az;
  const dx = Math.abs(bx - ax), dz = Math.abs(bz - az);
  const sx = ax < bx ? 1 : -1, sz = az < bz ? 1 : -1;
  let err = dx - dz;
  for (let guard = dx + dz + 2; guard >= 0; guard--) {
    if (!isNav(x0, z0)) return false;
    if (x0 === bx && z0 === bz) return true;
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; x0 += sx; }
    if (e2 < dx) { err += dx; z0 += sz; }
  }
  return true;
}

/** Drop intermediate cells whose removal keeps a clear line between neighbours (string-pulling). */
function stringPull(cells) {
  if (cells.length <= 2) return cells;
  const out = [cells[0]];
  let anchor = 0;
  for (let i = 2; i < cells.length; i++) {
    if (!lineClear(cells[anchor].cx, cells[anchor].cz, cells[i].cx, cells[i].cz)) {
      out.push(cells[i - 1]); anchor = i - 1;
    }
  }
  out.push(cells[cells.length - 1]);
  return out;
}

/** Component id of the nearest navigable cell to (x,z) — searching outward, NOT forced to the main sea (unlike
 *  snapToNav). This is the LOCAL water body a point touches. -1 if no navigable cell within SNAP_MAX_RINGS. */
function componentAt(x, z) {
  if (!loaded) loadNavGrid();
  if (!bits || !comp) return -1;
  const { cx, cz } = worldToCell(x, z);
  if (isNav(cx, cz)) return comp[cz * res + cx];
  for (let r = 1; r <= SNAP_MAX_RINGS; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = cx + dx, nz = cz + dz;
        if (inGrid(nx, nz) && isNav(nx, nz)) return comp[nz * res + nx];
      }
    }
  }
  return -1;
}

/** True if a sea route plausibly connects A and B — i.e. their local water bodies are the SAME connected
 *  component (no land barrier between them). Fail-open (true) when no navgrid is loaded, so trading still
 *  works on maps built before the grid existed. Used to keep demand hints / NPC sourcing to reachable ports. */
function reachable(ax, az, bx, bz) {
  if (!loaded) loadNavGrid();
  if (!bits || !comp) return true;   // no grid → don't filter
  const a = componentAt(ax, az);
  return a >= 0 && a === componentAt(bx, bz);
}

// ── public ──────────────────────────────────────────────────────────────────────
/**
 * World-space sea route from A to B. Returns [{x,z}, …] starting at A and ending at B (the real pier points),
 * with navigable-water waypoints between, or null if unreachable. Snaps A/B to open water + adds approach legs.
 */
function findPath(ax, az, bx, bz) {
  if (!loaded) loadNavGrid();
  if (!bits) return [{ x: ax, z: az }, { x: bx, z: bz }];   // no navgrid → straight line (fail-open)
  const s = snapToNav(worldToCell(ax, az).cx, worldToCell(ax, az).cz);
  const g = snapToNav(worldToCell(bx, bz).cx, worldToCell(bx, bz).cz);
  if (!s || !g) return [{ x: ax, z: az }, { x: bx, z: bz }];
  const ckey = `${s.cx},${s.cz}>${g.cx},${g.cz}`;
  let cells = pathCache.get(ckey);
  if (cells === undefined) { const raw = astar(s, g); cells = raw ? stringPull(raw) : null; pathCache.set(ckey, cells); }
  if (!cells) return null;
  const mid = cells.map((c) => cellToWorld(c.cx, c.cz));
  // [real start] → navigable waypoints → [real dest]; the first/last legs are the pier approaches.
  return [{ x: ax, z: az }, ...mid, { x: bx, z: bz }];
}

function loadNavGrid() {
  loaded = true;
  try {
    const manifestPath = path.join(terrainConfig.outputDir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const ng = m.navGrid;
    if (!ng || !ng.file) { console.warn('[nav] manifest has no navGrid — NPC routing falls back to straight lines'); return; }
    res = ng.resolution;
    wb = m.worldBounds;
    bits = new Uint8Array(fs.readFileSync(path.join(terrainConfig.outputDir, ng.file)));
    const need = Math.ceil((res * res) / 8);
    if (bits.length < need) { console.warn(`[nav] navgrid too small (${bits.length}<${need}) — disabling`); bits = null; return; }
    computeComponents();
    let nav = 0; for (let i = 0; i < res * res; i++) if (isNav(i % res, (i - i % res) / res)) nav++;
    console.log(`[nav] navgrid ${res}² loaded — ${(100 * nav / (res * res)).toFixed(1)}% navigable; open sea = component of ${(() => { let c = 0; for (let i = 0; i < res * res; i++) if (comp[i] === mainComp) c++; return c; })()} cells`);
  } catch (err) {
    bits = null;
    console.warn('[nav] navgrid load failed — NPC routing falls back to straight lines:', err.message);
  }
}

module.exports = {
  findPath, loadNavGrid, worldToCell, cellToWorld, isNav, snapToNav, componentAt, reachable,
  // test seam — inject a synthetic grid (bitset) without a baked manifest.
  _test: {
    setGrid(resolution, bitset, worldBounds) { res = resolution; bits = bitset; wb = worldBounds; loaded = true; pathCache.clear(); computeComponents(); },
    packGrid(resolution, navFn) {
      const b = new Uint8Array(Math.ceil((resolution * resolution) / 8));
      for (let cz = 0; cz < resolution; cz++) for (let cx = 0; cx < resolution; cx++) {
        if (navFn(cx, cz)) { const i = cz * resolution + cx; b[i >> 3] |= (1 << (i & 7)); }
      }
      return b;
    },
    astar, stringPull, lineClear,
  },
};
