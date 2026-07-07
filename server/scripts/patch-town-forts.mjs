/**
 * One-off, idempotent manifest patch (Harbor Forts): add each harbor's `forts` array to the baked terrain
 * manifest WITHOUT re-baking the terrain. Forts are DERIVED from each town's existing `pad` (deriveForts), so no
 * layout re-run / seed change is needed and a future `npm run terrain` re-bake produces identical forts
 * (layoutTown emits the same thing). Touches only `harbors[].forts`; all geometry stays byte-identical.
 *
 * A fort that fires is a combatant, so its exact placement + gun spec is server-authoritative — the clients
 * render from this, they don't compute it. Only tiers with an authored fort get an entry (small → T1 today);
 * medium/capital get an empty array until the T2/T3 forts land.
 *
 * Usage (from server/):  node scripts/patch-town-forts.mjs [path/to/manifest.json]
 * With no arg it patches the configured bake output; pass a path to target a manifest elsewhere.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import terrainConfig from '../config/terrain.config.js';
import { deriveForts } from '../data/town-layout.mjs';

const manifestPath = process.argv[2] || join(terrainConfig.outputDir, 'manifest.json');

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const harbors = m.harbors || [];
if (!harbors.length) { console.error('No harbors in manifest — nothing to patch.'); process.exit(1); }

let withFort = 0, guns = 0;
for (const h of harbors) {
  h.forts = h.pad ? deriveForts(h.pad, h.tier) : [];
  if (h.forts.length) { withFort++; guns += h.forts.reduce((n, f) => n + f.guns.length, 0); }
}

writeFileSync(manifestPath, JSON.stringify(m, null, 2));
console.log(`Patched ${harbors.length} harbors; ${withFort} got a fort (${guns} guns total).`);
