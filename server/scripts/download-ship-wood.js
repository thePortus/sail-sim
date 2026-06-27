#!/usr/bin/env node
'use strict';

/**
 * Downloads CC0 wood PBR sets used to RE-SKIN the player/NPC ships (pinnace / sloop / brig /
 * merchantman). Replaces the flat procedural wood — the win is a real NORMAL map (plank relief,
 * grain, wear that catches the sun + FFT reflections) plus photoscan roughness.
 *
 * ROLE: every set here is `source` — an AUTHORING-time input only. The Blender bake folds these
 * maps into each ship's existing atlases (albedo + ORM + a NEW baked normal), driven along the
 * ship's sheer-referenced UV so the planking still follows the hull. The committed GLB carries the
 * baked result; these raw PolyHaven PNGs are NEVER served and NEVER committed. Mirrors the palm/
 * beech bark flow in download-scatter-textures.js.
 *
 * Output: server/assets/ship-wood-src/   ← gitignored, re-fetchable, consumed only by the bake.
 *
 * AUTHORING-ONLY — deliberately NOT chained into `download:terrain-tiles`. The server deploy serves
 * the already-baked GLBs and never bakes, so it has no use for these raw PNGs. Run it by hand when
 * (re)baking a ship's wood:  npm run download:ship-wood
 *
 * Channels: albedo(diff) + normal(nor_gl) + rough + ao. Hull/deck heroes at 4k, fittings at 2k.
 * Licence: CC0 1.0 — free for any use incl. commercial; attribution not required.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const SOURCE_DIR = path.join(__dirname, '..', 'assets', 'ship-wood-src');

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
  // Hull topsides / strakes (the hero surface) — clean even grey planks, baked at 4k.
  // Texture-pick history (all VERTICAL-plank sources, so the in-game grain stays horizontal-on-topsides):
  //   worn_planks       → too repetitive (high plank-to-plank colour variance = each plank a landmark).
  //   weathered_planks  → still showed a recurring KNOT in the tile.
  //   wood_planks_grey  → uniform, strong clean plank SEAMS, NO knots. Colour is irrelevant: the hull is
  //                       PAINTED (brig_paint_base.py desaturates + re-tints white/near-black), so we only
  //                       want the seam + grain structure, which this has and the others muddied.
  set('hull_planks', 'wood_planks_grey', '4k'),
  // Main deck planking — light weathered planks (user pick over wood_floor_deck), baked at 4k.
  set('deck_planks', 'brown_planks_08', '4k'),
  // Fittings / trim / rails — finer, cleaner wood at 2k.
  set('trim_wood',   'wood_table',      '2k'),
  // Bulwark interiors / rough secondary planking — 2k.
  set('rough_plank', 'raw_plank_wall',  '2k'),
  // Gunport lids / shutters / hatches — 2k.
  set('shutter_wood','wood_shutter',    '2k'),
];

// ── Helpers (verbatim from download-scatter-textures.js) ───────────────────

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
  console.log('Downloading CC0 ship-wood textures (authoring source for the Blender bake)…\n');
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  let downloaded = 0, skipped = 0, failed = 0;
  for (const s of SETS) {
    for (const [chan, url] of Object.entries(s.maps)) {
      const filename = `${s.name}_${chan}.png`;
      const dest     = path.join(SOURCE_DIR, filename);
      process.stdout.write(`  ${filename.padEnd(24)} ← ${path.basename(url)}  `);
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
  if (failed) { process.exitCode = 1; }
}

main().catch((err) => {
  console.error('\n✗ Ship-wood download failed:', err.message);
  process.exit(1);
});
