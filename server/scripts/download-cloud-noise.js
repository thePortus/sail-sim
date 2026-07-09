#!/usr/bin/env node
'use strict';

/**
 * Downloads the 3-D grey-noise volume the volumetric clouds erode against, so it is served
 * from OUR server instead of every client fetching a third-party URL at runtime.
 *
 * Run once (or after deleting the clouds directory to refresh). It is chained into
 *   npm run download:terrain-tiles
 * so a fresh clone fetches every served asset in one step. Also runnable on its own:
 *   npm run download:cloud-noise
 *
 * Output: server/assets/clouds/   (the whole server/assets/ tree is gitignored — never committed).
 * Served by:  GET /clouds/:name   (clouds.controller.js) — the native client fetches
 *             /clouds/greyNoise3D.bin via its asset cache; the Angular client via Settings.apiUrl.
 *
 * ⚠ LICENSE NOTE: greyNoise3D.bin originates from the Babylon "volumetric-clouds" demo, whose
 *   noise traces back to Shadertoy's default textures — the license is NOT confirmed to permit
 *   redistribution the way our NASA sky textures are public domain. It is downloaded at setup
 *   into gitignored assets (not committed to the repo). Both clients fall back to a locally
 *   *generated* noise volume if this file is absent, so nothing breaks if you choose not to vendor
 *   it. Swap in your own royalty-free 32³ grey-noise .bin (same 20-byte BIN header) to be safe.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'clouds');

// out : filename written into OUTPUT_DIR (served as /clouds/<basename>)
// url : direct, script-stable download URL
const ASSETS = [
  {
    out: 'greyNoise3D.bin',
    url: 'https://celeste-twinkle.github.io/Babylon-App-Show/clouds/greyNoise3D.bin',
    note: 'Babylon volumetric-clouds 3D grey-noise volume (32³, 20-byte BIN header)',
  },
];

/** Follow up to 5 redirects, then stream body to dest path. (Mirrors download-sky-textures.js.) */
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

async function main() {
  console.log('Downloading cloud 3D noise volume…\n');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let downloaded = 0;
  let skipped    = 0;

  for (const a of ASSETS) {
    const dest = path.join(OUTPUT_DIR, a.out);
    process.stdout.write(`  ${a.out.padEnd(18)} ← ${a.note}\n`);
    const got = await download(a.url, dest);
    if (got) { downloaded++; } else { skipped++; }
  }

  console.log(`\n✓ Done.  ${downloaded} downloaded, ${skipped} skipped.`);
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log('  Both clients fall back to locally-generated noise if this is absent.\n');
}

main().catch((err) => {
  console.error('\n✗ Cloud-noise download failed:', err.message);
  process.exit(1);
});
