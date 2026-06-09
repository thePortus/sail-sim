#!/usr/bin/env node
'use strict';

/**
 * Downloads PUBLIC-DOMAIN (NASA) equirectangular sky textures: a lunar colour map for the moon
 * sphere and an all-sky star map for the night-sky dome.
 *
 * Run once (or after deleting the sky directory to refresh). It is chained into
 *   npm run download:terrain-tiles
 * so a fresh clone fetches every served texture in one step. Also runnable on its own:
 *   npm run download:sky-textures
 *
 * Output: server/assets/sky/   (the whole server/assets/ tree is gitignored — never committed).
 *
 * Sources (both NASA, PUBLIC DOMAIN — no attribution required):
 *   moon  : CGI Moon Kit "LROC color" map (NASA SVS 4720) — real lunar colour, true crater/maria
 *           positions. 1k JPG is ample for the small on-screen disc (the 2k is only TIFF).
 *   stars : Tycho Skymap II (NASA SVS 3572) — Tycho-2 catalogue stars + Milky Way, 4096x2048.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'sky');

// ── Texture manifest ──────────────────────────────────────────────────────
// out    : filename written into OUTPUT_DIR (served as /sky/<basename>)
// url    : direct, script-stable download URL
const TEXTURES = [
  {
    out: 'moon.jpg',
    url: 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg',
    note: 'NASA CGI Moon Kit LROC colour 1k (public domain)',
  },
  {
    out: 'stars.jpg',
    // 8k (8192x4096). 16k exists but risks exceeding the WebGPU maxTextureDimension2D baseline (8192).
    url: 'https://svs.gsfc.nasa.gov/vis/a000000/a003500/a003572/TychoSkymapII.t5_08192x04096.jpg',
    note: 'NASA Tycho Skymap II 8192x4096 (public domain)',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────

/** Follow up to 5 redirects, then stream body to dest path. (Mirrors download-terrain-tiles.js.) */
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      process.stdout.write(`  [skip] ${path.basename(dest)} (already exists)\n`);
      return resolve(false);
    }

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) {
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
  console.log('Downloading sky textures from NASA (public domain)…\n');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let downloaded = 0;
  let skipped    = 0;

  for (const t of TEXTURES) {
    const dest = path.join(OUTPUT_DIR, t.out);
    process.stdout.write(`  ${t.out.padEnd(12)} ← ${t.note}\n`);
    const got = await download(t.url, dest);
    if (got) { downloaded++; } else { skipped++; }
  }

  console.log(`\n✓ Done.  ${downloaded} downloaded, ${skipped} skipped.`);
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log('  Textures are NASA imagery — public domain, no attribution required.\n');
}

main().catch((err) => {
  console.error('\n✗ Sky-texture download failed:', err.message);
  process.exit(1);
});
