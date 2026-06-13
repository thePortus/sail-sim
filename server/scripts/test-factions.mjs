/**
 * Harness for the Factions module (F1 — territory + faction-matched names).
 * Pure functions on SYNTHETIC town arrays (no terrain/DB): assignFactions (spheres of interest + contested
 * borders) and assignFactionNames (per-nation name pools). Verifies coverage, determinism, clustering,
 * contested invariants, and that every name comes from its owning nation's pool.
 * Run: node scripts/test-factions.mjs   (from server/)
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assignFactions, assignFactionNames } from '../data/town-layout.mjs';

const require = createRequire(import.meta.url);
const { factionIds, isFaction } = require('../factions.js');
const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };

const IDS = factionIds();
const SEED = 1234;

// Name pools (to verify each town's identity came from its faction's bank).
const pools = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'town-names.json'), 'utf8')).factions;
const poolNames = {};
for (const fid of IDS) poolNames[fid] = new Set((pools[fid] || []).map((e) => e.name));

// ── scenario A: four far-apart corner clusters → one nation per corner ──
console.log('(a) four corner clusters — anchors land one-per-corner:');
const corners = [[2000, 2000], [2000, 48000], [48000, 2000], [48000, 48000]];
let id = 0;
const clustered = [];
for (let c = 0; c < 4; c++) {
  for (let k = 0; k < 8; k++) {
    clustered.push({ id: `town_${id++}`, x: corners[c][0] + (k % 3) * 200, z: corners[c][1] + Math.floor(k / 3) * 200 });
  }
}
assignFactions(clustered, SEED);
ok(clustered.every((t) => isFaction(t.faction)), 'every town has a valid faction');
ok(new Set(clustered.map((t) => t.faction)).size === 4, 'all four nations are present');
// each corner cluster should be mono-faction (corners are far apart → no border ambiguity)
let monoCorners = 0;
for (let c = 0; c < 4; c++) {
  const grp = clustered.slice(c * 8, c * 8 + 8);
  if (new Set(grp.map((t) => t.faction)).size === 1) monoCorners++;
}
ok(monoCorners === 4, 'each far-apart corner cluster is a single nation');

console.log('(b) determinism — same seed reproduces, geometry untouched:');
const again = clustered.map((t) => ({ id: t.id, x: t.x, z: t.z }));
assignFactions(again, SEED);
ok(again.every((t, i) => t.faction === clustered[i].faction), 'same seed → identical faction assignment');
const diff = clustered.map((t) => ({ id: t.id, x: t.x, z: t.z }));
assignFactions(diff, SEED + 1);
ok(diff.some((t, i) => t.faction !== clustered[i].faction), 'a different seed can shift territories');

// ── scenario C: dense uniform grid → border towns get contested ──
console.log('(c) dense grid — contested borders fire with valid rivals:');
const grid = [];
let gid = 0;
for (let gx = 0; gx < 7; gx++) for (let gz = 0; gz < 7; gz++) {
  grid.push({ id: `town_${gid++}`, x: 5000 + gx * 6500, z: 5000 + gz * 6500 });
}
assignFactions(grid, SEED);
const contested = grid.filter((t) => t.contested);
ok(contested.length > 0, `some border towns are contested (${contested.length}/${grid.length})`);
ok(contested.every((t) => isFaction(t.rivalFaction) && t.rivalFaction !== t.faction), 'every contested town has a valid rival ≠ its own nation');
ok(new Set(grid.map((t) => t.faction)).size === 4, 'all four nations present on the grid too');

console.log('(d) faction-matched names — drawn from the owning nation pool:');
assignFactionNames(grid, SEED);
ok(grid.every((t) => t.name && t.description), 'every town got a name + description');
// a name is valid if it's in the pool, or (when a nation has > pool-size towns) a cycled "<base> <roman>" form.
const baseName = (n) => n.replace(/ (?:I|II|III|IV|V|VI|VII|VIII)$/, '');
ok(grid.every((t) => poolNames[t.faction].has(baseName(t.name))), 'every name belongs to its faction pool (incl. cycled)');
// determinism of names
const grid2 = grid.map((t) => ({ id: t.id, x: t.x, z: t.z, faction: t.faction }));
assignFactionNames(grid2, SEED);
ok(grid2.every((t, i) => t.name === grid[i].name), 'same seed → identical names');
// no duplicate names within a single nation (pool ≥ per-nation town count here, so no cycling)
let dupFree = true;
for (const fid of IDS) {
  const ns = grid.filter((t) => t.faction === fid).map((t) => t.name);
  if (new Set(ns).size !== ns.length) dupFree = false;
}
ok(dupFree, 'no duplicate town names within a nation');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
