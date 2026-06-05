/**
 * One-shot world generator: fetch a region's real-world source data (if not cached) AND bake it into
 * the game's terrain, in a single command.
 *
 * Usage (from server/):
 *   npm run terrain                          # random region + random seed
 *   npm run terrain -- cyclades_naxos        # that region, random seed
 *   npm run terrain -- 42                     # random region, seed 42
 *   npm run terrain -- cyclades_naxos 42      # that region + seed
 *   npm run terrain -- maldives_male 7 --detail=4 --no-erode   # extra build flags pass through
 *
 * Region ids: see server/data/region-catalog.mjs (or run: npm run fetch:terrain-sources -- --list).
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONS, regionById } from '../data/region-catalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith('--'));
const buildFlags = args.filter((a) => a.startsWith('--') && !a.startsWith('--seed='));   // forwarded to the build

// Resolve region + seed from the positionals (a bare number = seed; a known id = region).
let regionId = null, seed = null;
for (const p of positionals) {
  if (/^\d+$/.test(p)) { seed = parseInt(p, 10); }
  else if (regionById(p)) { regionId = p; }
  else { console.error(`Unknown region '${p}'.\nKnown regions: ${REGIONS.map((r) => r.id).join(', ')}`); process.exit(1); }
}
const seedFlag = args.find((a) => a.startsWith('--seed='));
if (seedFlag) seed = parseInt(seedFlag.split('=')[1], 10);

if (!regionId) regionId = REGIONS[Math.floor(Math.random() * REGIONS.length)].id;
if (seed === null) seed = Math.floor(Math.random() * 1e9);

console.log(`\n🌍  Generating world — region '${regionId}', seed ${seed}\n`);

const run = (script, scriptArgs) => {
  const r = spawnSync(process.execPath, [join(__dirname, script), ...scriptArgs], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`\n✗ ${script} failed (exit ${r.status}).`); process.exit(r.status || 1); }
};

run('fetch-terrain-sources.mjs', [regionId]);                       // no-op if already cached
run('build-terrain-region.mjs', [regionId, `--seed=${seed}`, ...buildFlags]);

console.log(`\n✅  World ready — region '${regionId}', seed ${seed}. Reload the client to sail it.`);
