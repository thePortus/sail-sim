/**
 * Harness for server/npc.js (NPC Traders — NP2 fleet sim). No DB/manifest: a synthetic all-water navgrid +
 * injected towns. Verifies an NPC advances along its route, arrives, and re-plans (completes trips), stays in
 * bounds, and the NPC↔NPC avoidance + turn helpers behave.
 * Run: node scripts/test-npc-move.mjs   (from server/)
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nav = require('../nav.js');
const economy = require('../economy.js');
const npc = require('../npc.js');

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };

const WB = { minX: -25000, maxX: 25000, minZ: -25000, maxZ: 25000 };
nav._test.setGrid(64, nav._test.packGrid(64, () => true), WB);   // open ocean everywhere
const towns = [
  { id: 'A', name: 'Aport', x: -1500, z: 0, tier: 'medium', specialty: 'port' },
  { id: 'B', name: 'Bport', x: 1500, z: 0, tier: 'medium', specialty: 'forge' },
];
economy._test.setTowns(towns);

console.log('NP2 — NPC sails routes, arrives, re-plans:');
const players = new Map();
const m = npc._test.spawnNpc(players, towns);
ok(m.isNpc && m.ws.readyState === 3 && m.combat && m.authPose, 'spawn: isNpc + closed ws + combat + authPose');
ok(players.has(m.id) && m.id.startsWith('npc_'), 'registered in the players Map with an npc_ id');

const startTown = m.curTownId;
let trips = 0, inBounds = true, movedWhileTraveling = false;
let lastTown = startTown, prev = { x: m.state.x, z: m.state.z };
for (let i = 0; i < 2500; i++) {
  npc.tickNpcs(players, 0.2, () => {}, () => {}, Date.now());
  if (m.curTownId !== lastTown) { trips++; lastTown = m.curTownId; }
  if (Math.abs(m.state.x) > 25000 || Math.abs(m.state.z) > 25000) inBounds = false;
  if (m.route && (m.state.x !== prev.x || m.state.z !== prev.z)) movedWhileTraveling = true;
  prev = { x: m.state.x, z: m.state.z };
}
console.log(`    completed ${trips} town arrival(s) over 2500 ticks; final town ${m.curTownId}`);
ok(trips >= 1, 'NPC reached a destination town and re-planned (≥1 trip)');
ok(movedWhileTraveling, 'NPC position advances while underway');
ok(inBounds, 'NPC never leaves the world bounds');
ok(m.authPose.x === m.state.x && m.authPose.z === m.state.z, 'authPose stays synced to state (for collision)');

console.log('avoidance + steering helpers:');
const a = { state: { x: 0, z: 0 } }, b = { state: { x: 30, z: 0 } };   // b is 30u east of a (within AVOID_R)
const away = npc._test.avoidanceHeading(a, [a, b]);
ok(away !== null && Math.abs(((away - 270 + 540) % 360) - 180) < 30, 'a steers WEST (~270°) away from b to its east');
ok(npc._test.turnToward(0, 100, 30) === 30, 'turnToward clamps to the max step (0→100 by ≤30 = 30)');
ok(Math.abs(npc._test.angleDelta(350, 10) - 20) < 1e-9, 'angleDelta wraps the circle (350→10 = +20)');
const fleet = targetTest();
ok(fleet === true, 'targetFleet clamps to [8,15]');
function targetTest() { return npc.targetFleet(2) === 8 && npc.targetFleet(40) === 10 && npc.targetFleet(100) === 15; }

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
