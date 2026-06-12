/**
 * Harness for server/salvage.js (NP4 floating salvage). Verifies crate spawn, partial collect (gold full to
 * first taker, goods up to free hold, overflow stays floating), anti-dupe (second taker gets no gold),
 * conservation, and expiry sweep.  Run: node scripts/test-salvage.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const salvage = require('../salvage.js');
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

salvage._test.reset();
const now = 1_000_000;
const crate = salvage.spawnCrate(100, 200, { rum: 4, sugar: 6 }, 80, now);   // 10 goods + 80 gold
ok(salvage.getCrate(crate.id) === crate, 'crate registered on spawn');

console.log('partial collect (free hold = 3):');
const r1 = salvage.collect(crate, 3);
ok(r1.gold === 80, 'first taker gets all the gold');
ok(r1.took === 3 && sum(r1.goods) === 3, 'takes exactly 3 goods (free-hold cap)');
ok(!r1.empty, 'crate not empty — overflow goods remain');
ok(sum(salvage.getCrate(crate.id).contents) === 7, '7 goods stay floating for the next ship');

console.log('second collect (plenty of room) — anti-dupe + drain:');
const r2 = salvage.collect(crate, 50);
ok(r2.gold === 0, 'second taker gets NO gold (already taken — no dupe)');
ok(sum(r2.goods) === 7, 'second taker gets the remaining 7 goods');
ok(r2.empty, 'crate now empty → despawn');
ok(sum(r1.goods) + sum(r2.goods) === 10, 'goods conserved across collectors (3 + 7 = 10)');

console.log('expiry sweep:');
salvage._test.reset();
const c2 = salvage.spawnCrate(0, 0, { rum: 1 }, 0, now);
ok(salvage.sweepExpired(now + 1000).length === 0, 'not swept before its lifetime');
const gone = salvage.sweepExpired(now + salvage.CRATE_LIFETIME_MS + 1);
ok(gone.length === 1 && gone[0] === c2.id, 'expired crate is swept');
ok(salvage.getCrate(c2.id) === null, 'expired crate removed from the registry');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
