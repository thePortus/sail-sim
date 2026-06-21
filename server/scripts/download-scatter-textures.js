#!/usr/bin/env node
'use strict';

/**
 * Downloads CC0 PBR texture sets for the SCATTER assets (palms / beech / rocks / driftwood)
 * — the "scatter realism" overhaul (photoreal, less flat/cartoonish).
 *
 * Mirrors download-terrain-tiles.js exactly: a manifest of texture SETS, each with one URL per
 * channel, a redirect-following streamer, and skip-if-already-present. Run once on a fresh clone
 * (and on every server deploy via `npm run download:terrain-tiles`, which chains this in):
 *   npm run download:scatter-textures
 *
 * Output: server/assets/geometry/scatter/cc0/   ← gitignored, NEVER committed, re-fetchable.
 *   Served by the existing `/geometry` static route, so a runtime texture lands at
 *   geometry/scatter/cc0/<file> (client: scatterCC0Url('<file>') — see asset-loader.ts).
 *
 * TWO ROLES (set `role` per entry):
 *   role:'runtime' → an EXTERNAL texture the server serves and the client loads at runtime
 *                    (today: rocks + driftwood, which use buildScatterPBR with external PNGs).
 *                    These MUST deploy → they go in the gitignored served dir above.
 *   role:'source'  → a raw texture consumed only at AUTHORING time (Blender bake into the palm/beech
 *                    GLBs, which are then committed). These never deploy; they download to
 *                    server/assets/scatter-src/ (also gitignored) so a re-bake has them on hand.
 *
 * Only DIRECT file URLs are supported (png/jpg/exr) — one per channel. CC0 sources:
 *   • Poly Haven  : stable CDN, e.g. https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/<id>/<id>_<chan>_2k.png
 *   • ambientCG   : direct per-map PNG links exist under https://acg-download.struffelproductions.com/...
 *                    (or grab the map you want from the asset page; give the direct .png URL).
 * If a source only ships a .zip, unzip it once and host/point at the direct file, or ask me to add
 * unzip support. Channels we want: Color(albedo) + NormalGL(normal) + Roughness [+ Alpha for fronds/leaves].
 *
 * Licence: CC0 1.0 — free for any use incl. commercial, attribution not required.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const RUNTIME_DIR = path.join(__dirname, '..', 'assets', 'geometry', 'scatter', 'cc0');
const SOURCE_DIR  = path.join(__dirname, '..', 'assets', 'scatter-src');

// ── Texture manifest ──────────────────────────────────────────────────────
// Each SET:
//   name  : our stable internal name (decouples us from the source's IDs)
//   role  : 'runtime' (deploys, served) | 'source' (authoring-only, for Blender bake)
//   maps  : { <ourChannel>: '<direct file URL>' }   ourChannel ∈ albedo|normal|rough|alpha|...
//           Output file = `${name}_${ourChannel}.${ext}`, ext taken from the URL.
//
// Populate as CC0 links arrive. Examples (commented — swap in real URLs):
const SETS = [
  // ── P1 PALM ──────────────────────────────────────────────────────────────
  // Bark: Poly Haven "palm_tree_bark" (CC0, the lighter grey-tan coconut bark). Baked into the
  // committed palm GLB → role:'source'. Fronds are authored procedurally (no CC0 cutout) → no download.
  { name: 'palm_bark', role: 'source', maps: {
    albedo: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/palm_tree_bark/palm_tree_bark_diff_2k.png',
    normal: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/palm_tree_bark/palm_tree_bark_nor_gl_2k.png',
    rough:  'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/palm_tree_bark/palm_tree_bark_rough_2k.png',
  }},

  // ── P3 ROCKS (runtime — external PBR, 3 Poly Haven variations served from cc0/) ──
  { name: 'rock_05', role: 'runtime', maps: {
    albedo: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_05/rock_05_diff_2k.png',
    normal: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_05/rock_05_nor_gl_2k.png',
    rough:  'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_05/rock_05_rough_2k.png',
  }},
  { name: 'rock_04', role: 'runtime', maps: {
    albedo: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_04/rock_04_diff_2k.png',
    normal: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_04/rock_04_nor_gl_2k.png',
    rough:  'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_04/rock_04_rough_2k.png',
  }},
  { name: 'rock_cracked', role: 'runtime', maps: {
    albedo: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_boulder_cracked/rock_boulder_cracked_diff_2k.png',
    normal: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_boulder_cracked/rock_boulder_cracked_nor_gl_2k.png',
    rough:  'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/rock_boulder_cracked/rock_boulder_cracked_rough_2k.png',
  }},
  //
  // ── P4 DRIFTWOOD: reuses the palm + beech bark (already in scatter-src) — no separate download. ──
  //
  // ── P2 BEECH ──────────────────────────────────────────────────────────────
  // Bark: Poly Haven "sakura_bark" (CC0, grey). Baked into the committed beech GLB → role:'source'.
  // Leaves authored procedurally in Blender (no CC0 cutout) → no download.
  { name: 'beech_bark', role: 'source', maps: {
    albedo: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/sakura_bark/sakura_bark_diff_2k.png',
    normal: 'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/sakura_bark/sakura_bark_nor_gl_2k.png',
    rough:  'https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/sakura_bark/sakura_bark_rough_2k.png',
  }},
];

// ── Helpers ───────────────────────────────────────────────────────────────

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

/** Pull the file extension (png/jpg/exr…) off a URL, defaulting to png. */
function extOf(url) {
  const m = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'png';
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  if (SETS.length === 0) {
    console.log('No scatter texture sets configured yet — populate SETS in this script with CC0 URLs.');
    console.log('  (See the commented examples + the "TWO ROLES" note at the top of the file.)\n');
    return;
  }
  console.log('Downloading CC0 scatter textures…\n');
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(SOURCE_DIR,  { recursive: true });

  let downloaded = 0, skipped = 0, failed = 0;
  for (const set of SETS) {
    const outDir = set.role === 'source' ? SOURCE_DIR : RUNTIME_DIR;
    for (const [chan, url] of Object.entries(set.maps || {})) {
      const filename = `${set.name}_${chan}.${extOf(url)}`;
      const dest     = path.join(outDir, filename);
      process.stdout.write(`  ${filename.padEnd(26)} ← ${set.role}  `);
      try {
        const got = await download(url, dest);
        if (got) { downloaded++; } else { skipped++; }
      } catch (err) {
        process.stdout.write(`[FAIL — ${err.message}]\n`);
        failed++;
      }
    }
  }

  console.log(`\n✓ Done.  ${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);
  console.log(`  Runtime: ${RUNTIME_DIR}`);
  console.log(`  Source : ${SOURCE_DIR}`);
  console.log('  CC0 1.0 — free for any use including commercial; attribution not required.\n');
  if (failed) { process.exitCode = 1; }
}

main().catch((err) => {
  console.error('\n✗ Scatter-texture download failed:', err.message);
  process.exit(1);
});
