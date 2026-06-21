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
const weatherState = require('../weather-state.js');
const npc = require('../npc.js');

// Pin the wind so routing is DETERMINISTIC (module-load wind bearing is randomised 200–320° → the A↔B leg was
// flaky: an unfavourable beat sometimes left the merchant short of the town inside the tick budget). A steady
// northerly is a clean cross-wind reach for the east-west A↔B run, so the leg always completes.
weatherState.setOverride({ windSpeed: 10, fromBearingDeg: 0, cloudiness: 0.2 });

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
  npc.tickNpcs(players, 0.2, () => {}, Date.now());
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
ok(fleet === true, 'targetFleet clamps to [22,40]');
function targetTest() { return npc.targetFleet(2) === 22 && npc.targetFleet(30) === 30 && npc.targetFleet(100) === 40; }

console.log('interest management (only the nearest few merchants are sent to a client):');
{
  const sent = [];
  const recipient = { id: 'p1', isNpc: false, state: { x: 0, z: 0 }, ws: { readyState: 1, send: (j) => sent.push(JSON.parse(j)) } };
  const pm = new Map([['p1', recipient]]);
  const mk = (i, x) => pm.set('npc_' + i, { id: 'npc_' + i, isNpc: true, ws: { readyState: 3 }, state: { x, z: 0, vesselSlug: 'sloop' } });
  for (let i = 0; i < 6; i++) mk(i, 100 + i * 100);   // 6 merchants within VIEW_RADIUS (x=100..600)
  mk(99, 12000);                                       // 1 merchant BEYOND VIEW_RADIUS (10000)
  npc.broadcastInterest(pm, Date.now());
  const updates = sent.filter((m) => m.type === 'update');
  const ids = new Set(updates.map((m) => m.id));
  ok(updates.length === npc._test.MAX_VISIBLE, `client receives exactly MAX_VISIBLE (${npc._test.MAX_VISIBLE}) nearest merchants, got ${updates.length}`);
  ok(!ids.has('npc_99'), 'a merchant beyond VIEW_RADIUS is NOT sent');
  ok(!ids.has('npc_5'), 'the 6th-nearest merchant is capped out (only the 5 nearest)');
  ok([...ids].every((id) => id.startsWith('npc_')) && updates.every((m) => m.npc === true), 'sent updates are tagged npc:true');
  const beacon = sent.find((m) => m.type === 'nearest_merchant');
  ok(beacon && beacon.x != null, 'a nearest_merchant beacon is sent (the closest trader, for the map)');
  // sail the player far away → all previously-visible merchants drop out → 'leave' each, but the beacon persists
  sent.length = 0; recipient.state.x = 50000;
  npc.broadcastInterest(pm, Date.now());
  const leaves = sent.filter((m) => m.type === 'leave');
  ok(leaves.length === npc._test.MAX_VISIBLE, 'sailing out of range sends a leave for each dropped merchant');
  const beacon2 = sent.find((m) => m.type === 'nearest_merchant');
  ok(beacon2 && beacon2.x === 12000, 'beacon still reports the nearest merchant (x=12000) even though it is BEYOND render range');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
