/**
 * One-off, idempotent manifest patch (Harbor Forts — wall-path spike): add a defensive `walls` ring to each
 * harbor in the baked terrain manifest WITHOUT re-baking the terrain. The wall ring is DERIVED from each town's
 * existing `pad` rectangle (deriveWalls), so no layout re-run / seed change is needed and a future `npm run
 * terrain` re-bake produces identical walls (layoutTown emits the same thing). Touches only `harbors[].walls`;
 * all geometry stays byte-identical.
 *
 * Usage (from server/):  node scripts/patch-town-walls.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import terrainConfig from '../config/terrain.config.js';
import { deriveWalls } from '../data/town-layout.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(terrainConfig.outputDir, 'manifest.json');

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const harbors = m.harbors || [];
if (!harbors.length) { console.error('No harbors in manifest — nothing to patch.'); process.exit(1); }

let patched = 0, skipped = 0, nodes = 0;
for (const h of harbors) {
  if (!h.pad) { skipped++; continue; }        // pre-pad legacy town → can't derive a ring
  h.walls = deriveWalls(h.pad, h.tier);
  patched++; nodes += h.walls.length;
}

writeFileSync(manifestPath, JSON.stringify(m, null, 2));
console.log(`Patched ${patched} harbors with a wall ring (${nodes} nodes total)${skipped ? `, skipped ${skipped} without a pad` : ''}.`);
