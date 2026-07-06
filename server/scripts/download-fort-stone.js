#!/usr/bin/env node
'use strict';

/**
 * Downloads CC0 masonry PBR sets used to skin the HARBOR FORTS (small battery / blockhouse fort /
 * bastioned fort). The look is Caribbean COQUINA / weathered limestone — the real Spanish-Main
 * fortress material (cf. Castillo San Marcos): warm pale coral-stone, salt-weathered. The win over
 * procedural stone is a real NORMAL map (block relief, mortar courses, sea-wear that catches the sun
 * + FFT reflections) plus photoscan roughness — forts are big surfaces seen point-blank from the water.
 *
 * ROLE: every set here is `source` — an AUTHORING-time input only. The Blender bake folds these maps
 * into each fort's atlas (albedo + ORM + a baked normal), driven along the fort's UVs. The committed
 * GLB carries the baked result; these raw PolyHaven PNGs are NEVER served and NEVER committed. Mirrors
 * the ship-wood flow in download-ship-wood.js.
 *
 * Output: server/assets/fort-stone-src/   ← gitignored, re-fetchable, consumed only by the bake.
 *
 * AUTHORING-ONLY — deliberately NOT chained into `download:terrain-tiles`. The server deploy serves the
 * already-baked GLBs and never bakes. Run it by hand when (re)baking a fort:  npm run download:fort-stone
 *
 * Channels: albedo(diff) + normal(nor_gl) + rough + ao. Hero curtain/bastion masonry at 4k, accents at 2k.
 * Licence: CC0 1.0 — free for any use incl. commercial; attribution not required.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const SOURCE_DIR = path.join(__dirname, '..', 'assets', 'fort-stone-src');

// PolyHaven direct-CDN URL for a given asset id / our-channel / resolution.
const CHAN = { albedo: 'diff', normal: 'nor_gl', rough: 'rough', ao: 'ao' };
const phUrl = (id, chan, res) =>
  `https://dl.polyhaven.org/file/ph-assets/Textures/png/${res}/${id}/${id}_${CHAN[chan]}_${res}.png`;

function set(name, id, res) {
  return { name, maps: Object.fromEntries(
    Object.keys(CHAN).map((c) => [c, phUrl(id, c, res)])) };
}

// ── Texture manifest ──────────────────────────────────────────────────────
// name = our stable internal name (the bake references these, not PolyHaven ids).
// Output file = `${name}_${channel}.png`.
const SETS = [
  // HERO curtain / bastion / rampart masonry — sea-worn sandstone brick = weathered coquina, salt-eaten
  // faces, irregular coursing. The dominant fort surface; baked at 4k. Warm-tinted per faction in-engine.
  set('coquina_wall',  'seaworn_sandstone_brick',   '4k'),
  // Big ashlar blocks — bastion corners, quoins, gate surrounds, and the massive T3 curtain. 4k.
  set('coquina_block', 'large_sandstone_blocks_01', '4k'),
  // Pale limestone accent — lighter dressed stone (string courses, copings, the lighter-faction wash). 2k.
  set('coquina_light', 'white_sandstone_blocks_02', '2k'),
  // Courtyard / gun-deck flagstone — sea-worn stone tiles. 2k.
  set('fort_floor',    'seaworn_stone_tiles',       '2k'),
];

// ── Helpers (verbatim from download-ship-wood.js) ──────────────────────────

/** Follow up to 5 redirects, then stream body to dest path. Skip if it already exists. */
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      process.stdout.write(`  [skip] ${path.basename(dest)} (already exists)\n`);
      return resolve(false);
    }
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (redirectsLeft <= 0) { return reject(new Error(`Too many redirects for ${url}`)); }
        res.resume();
        return download(res.headers.location, dest, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const tmp = dest + '.tmp';
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve(true); }));
      file.on('error', (err) => { fs.unlink(tmp, () => {}); reject(err); });
    });
    req.on('error', reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('Downloading CC0 fort-stone (coquina) textures (authoring source for the Blender bake)…\n');
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  let downloaded = 0, skipped = 0, failed = 0;
  for (const s of SETS) {
    for (const [chan, url] of Object.entries(s.maps)) {
      const filename = `${s.name}_${chan}.png`;
      const dest     = path.join(SOURCE_DIR, filename);
      process.stdout.write(`  ${filename.padEnd(26)} ← ${path.basename(url)}  `);
      try {
        const got = await download(url, dest);
        if (got) { process.stdout.write('[ok]\n'); downloaded++; } else { skipped++; }
      } catch (err) {
        process.stdout.write(`[FAIL — ${err.message}]\n`);
        failed++;
      }
    }
  }

  console.log(`\n✓ Done.  ${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);
  console.log(`  Source: ${SOURCE_DIR}  (authoring-only — never served, never committed)`);
  console.log('  CC0 1.0 — free for any use including commercial; attribution not required.\n');
  // ao is optional (not every PolyHaven set ships it); don't fail the run over missing ao maps.
  const nonAoFail = failed > 0 && SETS.length * 3 > downloaded + skipped;
  if (nonAoFail) { process.exitCode = 1; }
}

main().catch((err) => {
  console.error('\n✗ Fort-stone download failed:', err.message);
  process.exit(1);
});
