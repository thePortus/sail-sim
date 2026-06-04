/**
 * Phase 0 — Terrain source fetcher.
 *
 * Pulls real-world elevation + bathymetry for each curated archipelago region (see
 * data/region-catalog.mjs) from the OpenTopography global-DEM REST API, caches the raw GeoTIFFs,
 * and writes per-region stats + colorized preview PNGs so you can eyeball each one before it feeds
 * the merge/augmentation pipeline (later phases).
 *
 *   Land detail : Copernicus GLO-30  (demtype COP30,        ~30 m)
 *   Bathymetry  : GEBCO 2024         (demtype GEBCOIceTopo, ~500 m)
 *
 * Usage (run from server/):
 *   node scripts/fetch-terrain-sources.mjs                 # all regions (skips already-downloaded)
 *   node scripts/fetch-terrain-sources.mjs cyclades_naxos  # one or more region ids
 *   node scripts/fetch-terrain-sources.mjs --force         # re-download even if cached
 *   node scripts/fetch-terrain-sources.mjs --span=40       # override window edge (km)
 *   node scripts/fetch-terrain-sources.mjs --list          # list the catalog and exit
 *
 * Requires OPENTOPO_API_KEY in the repo-root .env (see .env.example).
 * Output: server/assets/maps/sources/<regionId>/  (gitignored — re-fetchable).
 */

import { fromArrayBuffer } from 'geotiff';
import pngjs from 'pngjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config/terrain.config.js';
import { REGIONS, SOURCES, DEFAULT_SPAN_KM, deriveBBox, regionById } from '../data/region-catalog.mjs';

const { PNG } = pngjs;
const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = join(__dirname, '..', 'assets', 'maps', 'sources');
const API_URL = 'https://portal.opentopography.org/API/globaldem';
const PREVIEW_MAX = 600;          // max preview edge (px)

// ── CLI parsing ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const spanArg = args.find((a) => a.startsWith('--span='));
const spanKm = spanArg ? Number(spanArg.split('=')[1]) : DEFAULT_SPAN_KM;
const force = flags.has('--force');
const ids = args.filter((a) => !a.startsWith('--'));

if (flags.has('--list')) {
  console.log('Catalog regions:');
  for (const r of REGIONS) {
    console.log(`  ${r.id.padEnd(22)} ${r.archetype.padEnd(22)} ${r.name}`);
  }
  process.exit(0);
}

const selected = ids.length ? ids.map((id) => {
  const r = regionById(id);
  if (!r) { console.error(`Unknown region id: ${id} (use --list)`); process.exit(1); }
  return r;
}) : REGIONS;

if (!config.openTopoApiKey) {
  console.error('✗ OPENTOPO_API_KEY is not set. Copy .env.example → .env and paste your key.');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const TIFF_LE = 0x49492a00, TIFF_BE = 0x4d4d002a;   // 'II*\0' / 'MM\0*' magic

/** True if the buffer starts with a TIFF magic number (else it's an API error payload). */
function isTiff(buf) {
  if (buf.length < 4) return false;
  const m = buf.readUInt32BE(0);
  return m === TIFF_LE || m === TIFF_BE;
}

/** Fetch one demtype as a GeoTIFF Buffer, validating it's really a TIFF (not an error message). */
async function fetchGeoTiff(demtype, bbox) {
  const url = `${API_URL}?demtype=${demtype}`
    + `&south=${bbox.south}&north=${bbox.north}&west=${bbox.west}&east=${bbox.east}`
    + `&outputFormat=GTiff&API_Key=${encodeURIComponent(config.openTopoApiKey)}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !isTiff(buf)) {
    const msg = buf.toString('utf8').slice(0, 300).trim();
    throw new Error(`OpenTopography ${demtype} request failed (HTTP ${res.status}): ${msg || '(no body)'}`);
  }
  return buf;
}

/** Decode a GeoTIFF buffer → { data: Float32Array, width, height, bbox, nodata }. */
async function decodeGeoTiff(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const [data] = await image.readRasters();
  return {
    data,
    width: image.getWidth(),
    height: image.getHeight(),
    bbox: image.getBoundingBox(),       // [minX, minY, maxX, maxY] in degrees
    nodata: image.getGDALNoData(),
  };
}

/** Min/max over valid (non-nodata) samples. */
function stats(data, nodata) {
  let min = Infinity, max = -Infinity, valid = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (nodata !== null && v === nodata) continue;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    valid++;
  }
  return { min: valid ? min : 0, max: valid ? max : 0, valid };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;

/** Land colour ramp (sea→beach→grass→rock→snow) for a normalised height 0..1. */
function landColor(t) {
  const stops = [
    [0.00, [40, 90, 130]],   // shallow sea (COP30 ocean ≈ 0)
    [0.02, [216, 200, 150]], // beach
    [0.15, [70, 120, 55]],   // grass
    [0.45, [110, 95, 70]],   // rock
    [0.75, [90, 80, 72]],    // high rock
    [1.00, [235, 235, 240]], // snow
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [0, 1, 2].map((k) => Math.round(lerp(c0[k], c1[k], f)));
    }
  }
  return stops[stops.length - 1][1];
}

/** Bathymetry colour ramp (land tan above 0; shallow→deep blue below). `minDepth` is the region's
 *  most-negative value, so the ramp stretches across the ACTUAL depth range (a shallow shelf and an
 *  abyssal basin both show full contrast) rather than being scaled to a fixed 4 km. */
function bathyColor(v, minDepth) {
  if (v >= 0) return [200, 190, 165];
  const d = clamp01(v / (minDepth || -1));   // 0 at surface → 1 at the deepest point in this region
  return [
    Math.round(lerp(170, 8, d)),
    Math.round(lerp(225, 20, d)),
    Math.round(lerp(240, 70, d)),
  ];
}

/** Write a downsampled, colorized, hill-shaded preview PNG. */
function writePreview(path, grid, mode) {
  const { data, width, height, nodata } = grid;
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / PREVIEW_MAX));
  const ow = Math.floor(width / scale), oh = Math.floor(height / scale);
  const png = new PNG({ width: ow, height: oh });
  const { min, max } = stats(data, nodata);
  const span = max - min || 1;
  const sample = (x, y) => {
    const v = data[Math.min(height - 1, y) * width + Math.min(width - 1, x)];
    return (nodata !== null && v === nodata) ? 0 : v;
  };
  const lightX = -0.5, lightY = -0.7, lightZ = 0.5;   // top-left light
  // Underwater relief is far subtler than land (a shelf drops metres over ~460 m posts), so the
  // seafloor needs much stronger vertical exaggeration than the land to read in the hillshade.
  const ex = mode === 'land' ? 6 : 45;
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      const sx = ox * scale, sy = oy * scale;
      const h = sample(sx, sy);
      // Cheap hillshade from a downsampled gradient (exaggerated for legibility).
      const dzdx = (sample(sx + scale, sy) - sample(sx - scale, sy)) / (scale * 2);
      const dzdy = (sample(sx, sy + scale) - sample(sx, sy - scale)) / (scale * 2);
      let nx = -dzdx * ex, ny = -dzdy * ex, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz); nx *= inv; ny *= inv; nz *= inv;
      // Hillshade the surface that matters in this mode (land>0 for land, seafloor<0 for bathy);
      // the "other" surface is left flat-coloured.
      const lit = clamp01(0.5 + 0.8 * (nx * lightX + ny * lightY + nz * lightZ));
      const isRelief = mode === 'land' ? h > 0 : h < 0;
      const shade = isRelief ? lit : 1;
      const rgb = mode === 'land' ? landColor(clamp01((h - Math.max(0, min)) / span)) : bathyColor(h, min);
      const idx = (oy * ow + ox) * 4;
      png.data[idx]     = Math.round(rgb[0] * shade);
      png.data[idx + 1] = Math.round(rgb[1] * shade);
      png.data[idx + 2] = Math.round(rgb[2] * shade);
      png.data[idx + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

const ATTRIBUTION = `Terrain source data — attribution required, do not remove.

Land elevation: Copernicus GLO-30 Digital Elevation Model
  © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS
  by the European Union and ESA; all rights reserved. Accessed via OpenTopography.

Bathymetry: GEBCO 2024 Grid
  GEBCO Compilation Group (2024) GEBCO 2024 Grid (doi:10.5285/...). Public domain. Accessed via OpenTopography.

Access: OpenTopography Facility (https://opentopography.org), NSF-supported.
`;

// ── Main ───────────────────────────────────────────────────────────────────
async function run() {
  mkdirSync(SOURCES_DIR, { recursive: true });
  writeFileSync(join(SOURCES_DIR, 'ATTRIBUTION.txt'), ATTRIBUTION);
  console.log(`Fetching ${selected.length} region(s) @ ${spanKm} km window → ${SOURCES_DIR}\n`);

  for (const region of selected) {
    const bbox = deriveBBox(region, spanKm);
    const dir = join(SOURCES_DIR, region.id);
    mkdirSync(dir, { recursive: true });
    console.log(`● ${region.id} — ${region.name} [${region.archetype}]`);
    console.log(`  bbox  S${bbox.south.toFixed(3)} N${bbox.north.toFixed(3)} W${bbox.west.toFixed(3)} E${bbox.east.toFixed(3)}`);

    const meta = { id: region.id, name: region.name, archetype: region.archetype, center: region.center,
      spanKm, bbox: { south: bbox.south, north: bbox.north, west: bbox.west, east: bbox.east },
      fetchedAt: new Date().toISOString(), sources: {} };

    for (const [key, src] of Object.entries(SOURCES)) {
      const tifPath = join(dir, src.file);
      try {
        if (!existsSync(tifPath) || force) {
          process.stdout.write(`  ↓ ${src.demtype.padEnd(13)} `);
          const buf = await fetchGeoTiff(src.demtype, bbox);
          writeFileSync(tifPath, buf);
          console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
        } else {
          console.log(`  ✓ ${src.demtype.padEnd(13)} cached`);
        }
        const grid = await decodeGeoTiff(readFileSync(tifPath));
        const st = stats(grid.data, grid.nodata);
        writePreview(join(dir, `preview_${key}.png`), grid, key === 'land' ? 'land' : 'bathy');
        meta.sources[key] = { demtype: src.demtype, label: src.label, file: src.file,
          width: grid.width, height: grid.height, min: +st.min.toFixed(1), max: +st.max.toFixed(1), nodata: grid.nodata };
        console.log(`    ${grid.width}×${grid.height}  range [${st.min.toFixed(0)}, ${st.max.toFixed(0)}] m  → preview_${key}.png`);
      } catch (err) {
        console.error(`  ✗ ${src.demtype}: ${err.message}`);
        meta.sources[key] = { demtype: src.demtype, error: err.message };
      }
    }

    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log('');
  }
  console.log('Done.');
}

run().catch((err) => { console.error('\nFatal:', err); process.exit(1); });
