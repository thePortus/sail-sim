/**
 * Harness for server/nav.js (NPC Traders — NP1).
 *  • NP1a: a SYNTHETIC grid (a wall with one gap) — A* must detour through the gap, string-pull keeps it on
 *    navigable water, snapToNav rescues a land start/goal, a sealed gap is unreachable.
 *  • NP1b: if the REAL baked navgrid is present, route between actual town pairs and assert every sampled
 *    point is WATER (terrain-mask elevationAt ≤ 0) — no land crossing — and all pairs are reachable.
 * Run: node scripts/test-nav.mjs   (from server/)
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nav = require('../nav.js');

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };

const WB = { minX: -25000, maxX: 25000, minZ: -25000, maxZ: 25000 };
const RES = 64;

// ── NP1a: synthetic grid — all water except a vertical wall at cx=32, gap at cz 30..33 ──
console.log('NP1a — synthetic grid (wall at cx=32, gap cz 30..33):');
const navFn = (cx, cz) => !(cx === 32 && !(cz >= 30 && cz <= 33));
nav._test.setGrid(RES, nav._test.packGrid(RES, navFn), WB);

const L = nav.cellToWorld(8, 50);    // open water, left of wall (row 50 has NO gap → forces a detour)
const R = nav.cellToWorld(56, 50);   // open water, right of wall
const route = nav.findPath(L.x, L.z, R.x, R.z);
ok(!!route, 'path found across the wall');
ok(route && route.length > 2, 'path bends (more than start→end) — it detoured');
// straight line L→R would cross the wall (not clear) → the detour was necessary
const sc = nav.worldToCell(L.x, L.z), gc = nav.worldToCell(R.x, R.z);
ok(!nav._test.lineClear(sc.cx, sc.cz, gc.cx, gc.cz), 'straight line L→R is blocked by the wall');
// every sampled point along the route stays on navigable water (start+goal are open water, no approach legs)
let allNav = true, crossedGap = false;
for (let i = 0; i < route.length - 1; i++) {
  const a = route[i], b = route[i + 1];
  for (let t = 0; t <= 1; t += 0.05) {
    const c = nav.worldToCell(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (!nav.isNav(c.cx, c.cz)) allNav = false;
    if (c.cx === 32 && c.cz >= 30 && c.cz <= 33) crossedGap = true;
  }
}
ok(allNav, 'every sampled waypoint segment is navigable water');
ok(crossedGap, 'route threads through the gap');

console.log('main-component snapping (towns pulled to the open sea, not dead-end pockets):');
const wall = nav.worldToCell(nav.cellToWorld(32, 5).x, nav.cellToWorld(32, 5).z);   // a wall (land) cell
const snapped = nav.snapToNav(wall.cx, wall.cz);
ok(snapped && nav.isNav(snapped.cx, snapped.cz), 'snapToNav rescues a land cell to navigable water');
// grid: big open sea + a 2×2 navigable pocket sealed by a non-nav ring (an enclosed lagoon)
nav._test.setGrid(RES, nav._test.packGrid(RES, (cx, cz) => !((cx === 0 || cx === 3 || cz === 0 || cz === 3) && cx <= 3 && cz <= 3)), WB);
const snappedPocket = nav.snapToNav(1, 1);   // a cell inside the sealed pocket
ok(snappedPocket && !(snappedPocket.cx <= 2 && snappedPocket.cz <= 2), 'an enclosed-pocket point snaps OUT to the open sea (main component)');
const seaPt = nav.cellToWorld(40, 40);
ok(nav.findPath(seaPt.x, seaPt.z, nav.cellToWorld(1, 1).x, nav.cellToWorld(1, 1).z) !== null, 'open sea → enclosed town routes (via the snapped sea cell + approach)');

console.log('reachable() — two basins split by a solid wall (no gap):');
// left basin (cx<30) + right basin (cx>34), a full-height land wall between → two separate components.
nav._test.setGrid(RES, nav._test.packGrid(RES, (cx) => cx < 30 || cx > 34), WB);
const lA = nav.cellToWorld(10, 20), lB = nav.cellToWorld(20, 50), rC = nav.cellToWorld(50, 30);
ok(nav.reachable(lA.x, lA.z, lB.x, lB.z), 'two points in the SAME basin are reachable');
ok(!nav.reachable(lA.x, lA.z, rC.x, rC.z), 'points in DIFFERENT basins (land between) are NOT reachable');

// ── NP1b: real baked navgrid (only if present) ──
console.log('\nNP1b — real baked navgrid (skipped if not yet baked):');
let realGrid = false;
try {
  const fs = require('fs'); const pathMod = require('path');
  const tc = require('../config/terrain.config');
  const m = JSON.parse(fs.readFileSync(pathMod.join(tc.outputDir, 'manifest.json'), 'utf8'));
  if (m.navGrid && fs.existsSync(pathMod.join(tc.outputDir, m.navGrid.file))) {
    realGrid = true;
    // fresh module state: reload from disk
    delete require.cache[require.resolve('../nav.js')];
    const navReal = require('../nav.js');
    navReal.loadNavGrid();
    const terrain = require('../terrain-mask.js');
    const towns = (m.harbors || []).slice(0, 6);   // a handful of pairs
    let reachable = 0, pairs = 0, landHits = 0;
    for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) {
      pairs++;
      const r = navReal.findPath(towns[i].x, towns[i].z, towns[j].x, towns[j].z);
      if (!r) continue;
      reachable++;
      // sample interior legs (skip the first/last pier-approach legs, which cross shallow non-nav water)
      for (let k = 1; k < r.length - 2; k++) {
        const a = r[k], b = r[k + 1];
        for (let t = 0; t <= 1; t += 0.1) {
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          if (terrain.elevationAt(x, z) > 0) landHits++;
        }
      }
    }
    console.log(`    ${reachable}/${pairs} town pairs reachable; ${landHits} land-crossing samples on interior legs`);
    ok(reachable === pairs, 'all sampled town pairs reachable');
    ok(landHits === 0, 'no interior waypoint crosses land (elevation ≤ 0)');
  }
} catch (e) { console.log('    (real-grid check error:', e.message + ')'); }
if (!realGrid) console.log('    navgrid not baked yet — run NP1b, then re-run.');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
