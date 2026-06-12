/**
 * One-off, idempotent manifest patch (Town Economy — Phase 1): add the economic `specialty` field to each
 * harbor in the baked terrain manifest WITHOUT re-baking the terrain (which would pick a new seed / regenerate
 * every chunk). Applies the SAME `assignSpecialties()` the town generator uses, so a future `npm run terrain`
 * re-bake produces identical specialties. Touches only `harbors[].specialty` — all geometry stays byte-identical.
 *
 * Usage (from server/):  node scripts/patch-town-specialties.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import terrainConfig from '../config/terrain.config.js';
import { assignSpecialties } from '../data/town-layout.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(terrainConfig.outputDir, 'manifest.json');

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const harbors = m.harbors || [];
if (!harbors.length) { console.error('No harbors in manifest — nothing to patch.'); process.exit(1); }

assignSpecialties(harbors, m.seed ?? null);   // mutates harbors[].specialty in place (same seed as the bake)

writeFileSync(manifestPath, JSON.stringify(m, null, 2));

const counts = {};
for (const h of harbors) counts[h.specialty] = (counts[h.specialty] || 0) + 1;
console.log(`Patched ${harbors.length} harbors with specialty. Distribution:`);
for (const [s, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);
