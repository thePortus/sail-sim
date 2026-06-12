/**
 * Harness for NP4 combat-as-target + sink linger. Verifies an NPC hull sinks via combat.applyDamage (so the
 * shot adjudicator treats merchants as valid victims) and that a sunk merchant lingers (capsize plays) then
 * despawns with a leave.  Run: node scripts/test-npc-combat.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const combat = require('../combat.js');
const npc = require('../npc.js');
const economy = require('../economy.js');
const nav = require('../nav.js');
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };

console.log('combat treats an NPC as a target:');
const c = combat.newCombatState('sloop');
let justSunk = false;
for (const z of Object.keys(c.zones)) { if (z !== 'masts') { justSunk = combat.applyDamage(c, z, c.zones[z]).justSunk; break; } }
ok(justSunk && c.sunk, 'zeroing a hull zone sinks the NPC (same combat as players)');

console.log('sunk merchant linger → despawn:');
nav._test.setGrid(64, nav._test.packGrid(64, () => true), { minX: -25000, maxX: 25000, minZ: -25000, maxZ: 25000 });
economy._test.setTowns([{ id: 'A', name: 'A', x: 0, z: 0, tier: 'medium', specialty: 'port' },
                        { id: 'B', name: 'B', x: 1000, z: 0, tier: 'medium', specialty: 'forge' }]);
const players = new Map();
const m = npc._test.spawnNpc(players, economy.townList());
m.combat.sunk = true;   // simulate the resolveHit sink
const leaves = [];
const T = 1_000_000;
npc.tickNpcs(players, 0.2, (lid) => leaves.push(lid), T);          // first tick: set sinkAt, linger
ok(players.has(m.id) && leaves.length === 0, 'lingers right after sinking (capsize plays)');
npc.tickNpcs(players, 0.2, (lid) => leaves.push(lid), T + 4001);   // past SINK_LINGER_MS → despawn
ok(!players.has(m.id), 'despawned after the linger');
ok(leaves.includes(m.id), 'broadcastLeave fired for the wreck');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
