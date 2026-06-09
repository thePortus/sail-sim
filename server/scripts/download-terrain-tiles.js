#!/usr/bin/env node
'use strict';

/**
 * Downloads CC0 terrain tile textures from Polyhaven for triplanar splatting.
 *
 * Run once (or after deleting the tiles directory to refresh):
 *   npm run download:terrain-tiles
 *
 * Output: server/assets/terrain/tiles/
 * The entire server/assets/terrain/ tree is gitignored — these files are
 * never committed.  Re-run the script on any fresh clone.
 *
 * Each biome gets a diffuse map (_diff) and an OpenGL normal map (_nor_gl).
 * Files are named <biome>_diff.jpg and <biome>_nor.jpg to decouple our
 * naming convention from Polyhaven's internal IDs (which may change).
 *
 * Polyhaven licence: CC0 1.0 Universal — https://polyhaven.com/license
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'terrain', 'tiles');
// Resolution knob: default 1k; pass --2k for crisper close-up tiles (≈4× the bytes — heavier VRAM once
// packed into the S1 texture arrays). Higher res is the "higher-quality sets" lever requested for S1.
const RES        = process.argv.includes('--2k') ? '2k' : '1k';
const CDN_BASE   = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${RES}`;

// ── Texture manifest ──────────────────────────────────────────────────────
// Each entry:
//   biome    : internal name used by the terrain shader (sand, grass, …)
//   polyId   : Polyhaven asset ID
//   diffRes  : tile scale note (informational only)
//
// To swap a texture, just change polyId — the biome name used in the shader
// stays stable.
const TILES = [
  { biome: 'sand',   polyId: 'coast_sand_01',    note: '~8 m tile'  },
  { biome: 'sand2',  polyId: 'coast_sand_03',    note: '~9 m tile'  },
  { biome: 'grass',  polyId: 'forrest_ground_01', note: '~10 m tile' },
  { biome: 'grass2', polyId: 'aerial_grass_rock', note: '~11 m tile' },
  { biome: 'gravel', polyId: 'rocky_terrain',     note: '~12 m tile' },
  { biome: 'rock',   polyId: 'rock_face',         note: '~6 m tile'  },
  { biome: 'rock2',  polyId: 'rock_face_03',      note: '~7 m tile'  },
  { biome: 'snow',   polyId: 'snow_02',           note: '~15 m tile' },
];

// Full PBR channel set. diff + nor are required; rough + ao are OPTIONAL (a few Polyhaven assets lack
// them — those are skipped with a warning, the build still works). rough drives the wet/dry response;
// ao deepens crevices. (S1 packs these into texture arrays; metalness is 0 for all terrain.)
const MAPS = [
  { suffix: 'diff',   outSuffix: 'diff',  optional: false },
  { suffix: 'nor_gl', outSuffix: 'nor',   optional: false },
  { suffix: 'rough',  outSuffix: 'rough', optional: true  },
  { suffix: 'ao',     outSuffix: 'ao',    optional: true  },
];

// ── Helpers ───────────────────────────────────────────────────────────────

/** Follow up to 5 redirects, then stream body to dest path. */
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      process.stdout.write(`  [skip] ${path.basename(dest)} (already exists)\n`);
      return resolve();
    }

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      // Handle redirect
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirectsLeft <= 0) {
          return reject(new Error(`Too many redirects for ${url}`));
        }
        res.resume(); // drain
        return download(res.headers.location, dest, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }

      const tmp = dest + '.tmp';
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tmp, dest);
          resolve();
        });
      });
      file.on('error', (err) => {
        fs.unlink(tmp, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('Downloading terrain tile textures from Polyhaven (CC0)…\n');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let downloaded = 0;
  let skipped    = 0;

  let missing = 0;
  for (const tile of TILES) {
    for (const map of MAPS) {
      const filename = `${tile.biome}_${map.outSuffix}.jpg`;
      const dest     = path.join(OUTPUT_DIR, filename);
      const url      = `${CDN_BASE}/${tile.polyId}/${tile.polyId}_${map.suffix}_${RES}.jpg`;

      process.stdout.write(`  ${filename.padEnd(22)} ← ${tile.polyId}  `);
      const existed = fs.existsSync(dest);
      try {
        await download(url, dest);
        if (existed) { skipped++; } else { downloaded++; }
      } catch (err) {
        if (map.optional) { process.stdout.write(`[skip — not available]\n`); missing++; }
        else { throw err; }
      }
    }
  }

  console.log(`\n✓ Done.  ${downloaded} downloaded, ${skipped} skipped, ${missing} optional missing.  (res ${RES})`);
  console.log(`  Output: ${OUTPUT_DIR}\n`);
  console.log('  Textures are CC0 — free for any use including commercial.');
  console.log('  Attribution appreciated but not required (polyhaven.com).\n');
}

main().catch((err) => {
  console.error('\n✗ Download failed:', err.message);
  process.exit(1);
});
