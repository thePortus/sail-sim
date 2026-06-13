/**
 * Harness for F2 (town + NPC factions): the soft-weighted trip scorer and merchant faction assignment.
 * Pure (economy._test towns + npc._test), no DB/nav. Jitter is zeroed so scoring is deterministic.
 * Verifies: own-nation destination/source bonuses; a severe rival shortage still outscores a home one;
 * a factionless caller gets no bonus; spawn picks a valid nation (weighted) and starts at a home town.
 * Run: node scripts/test-faction-trade.mjs   (from server/)
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const economy = require('../economy.js');
const npc = require('../npc.js');

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };

npc._test.setJitter(0);   // deterministic scoring for the assertions below

// Towns: an English + a Spanish consumer, each with a same-nation producer to source from.
const ENG = { id: 'ENG', name: 'Port Royal',  tier: 'medium', specialty: 'forge',      faction: 'english', x: 0,    z: 0 };
const SPA = { id: 'SPA', name: 'Cartagena',   tier: 'medium', specialty: 'forge',      faction: 'spanish', x: 1000, z: 0 };
const EPR = { id: 'EPR', name: 'Bridgetown',  tier: 'medium', specialty: 'distillery', faction: 'english', x: 100,  z: 0 };
economy._test.setTowns([ENG, SPA, EPR]);
economy._test.seedMarkets();

const need = (townId, distressDays) => ({ townId, goodId: 'rum', level: 0.5, distressDays });

console.log('(a) own-nation bonuses (dest + source):');
const engNeed = need('ENG', 1), spaNeed = need('SPA', 1);
const sEngByEng = npc._test.scoreNeed({ faction: 'english' }, engNeed, 'english');   // home dest + home src
const sSpaByEng = npc._test.scoreNeed({ faction: 'english' }, spaNeed, 'english');   // rival dest, home src
ok(sEngByEng > sSpaByEng, 'an English merchant scores the English need above the Spanish one');
ok(Math.abs((sEngByEng - sSpaByEng) - npc._test.OWN_DEST_BONUS) < 1e-6, 'the gap equals exactly the own-destination bonus');

console.log('(b) symmetry + factionless:');
const sSpaBySpa = npc._test.scoreNeed({ faction: 'spanish' }, spaNeed, 'english');
const sEngBySpa = npc._test.scoreNeed({ faction: 'spanish' }, engNeed, 'english');
ok(sSpaBySpa > sEngBySpa, 'a Spanish merchant prefers the Spanish need (mirror)');
const sEngByNone = npc._test.scoreNeed({}, engNeed, 'english');
const sSpaByNone = npc._test.scoreNeed({}, spaNeed, 'english');
ok(Math.abs(sEngByNone - sSpaByNone) < 1e-6, 'a factionless caller applies no nation bonus (equal urgency → equal score)');

console.log('(c) a severe rival shortage still wins — "willing to go beyond":');
const homeMild = need('ENG', 1), rivalSevere = need('SPA', 40);
const sHome = npc._test.scoreNeed({ faction: 'english' }, homeMild, 'english');
const sRival = npc._test.scoreNeed({ faction: 'english' }, rivalSevere, 'english');
ok(sRival > sHome, 'a 40-day Spanish famine outscores a fresh English need for an English merchant');

console.log('(d) spawn assigns a nation (weighted) + starts at a home town:');
const ids = require('../factions.js').factionIds();
const players = new Map();
const sp = npc._test.spawnNpc(players, [ENG, SPA, EPR]);
ok(ids.includes(sp.faction), `spawned merchant flies a valid nation (${sp.faction})`);
ok([ENG, SPA, EPR].some((t) => t.faction === sp.faction && t.x === sp.state.x && t.z === sp.state.z), 'it spawns at one of its own nation\'s towns');
// weighting: English holds 2 of 3 towns → English should dominate a large sample
let eng = 0, n = 600;
for (let i = 0; i < n; i++) if (npc._test.pickFaction([ENG, SPA, EPR]) === 'english') eng++;
console.log(`    pickFaction English share: ${(100 * eng / n).toFixed(0)}% (expect ~67%)`);
ok(eng > n * 0.5, 'pickFaction is weighted by town count (English ≈ 2/3 here)');

console.log('(e) reputation scaffold — default + normalize:');
const factions = require('../factions.js');
const def = factions.defaultRep();
ok(ids.every((id) => def[id] === 0) && Object.keys(def).length === ids.length, 'defaultRep is every nation at neutral 0');
const norm = factions.normalizeRep({ english: 5, spanish: -3, bogus: 99 });
ok(norm.english === 5 && norm.spanish === -3, 'normalizeRep keeps known numeric standings');
ok(norm.french === 0 && norm.dutch === 0 && norm.bogus === undefined, 'normalizeRep fills missing nations with 0 and drops unknown keys');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
