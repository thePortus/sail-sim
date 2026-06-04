/**
 * Phase 1 — Region terrain builder.
 *
 * Takes a fetched real-world region (Phase 0: COP30 land + GEBCO bathymetry GeoTIFFs) and bakes it
 * into the game's chunked heightfield, replacing the old single-PNG pipeline. Key differences:
 *
 *   • REPROJECT — the source GeoTIFFs are in geographic degrees (anisotropic in metres at non-zero
 *     latitude). We resample both onto a single SQUARE metric grid spanning the playable world.
 *   • UNIFIED SIGNED FIELD — land (Copernicus, sharp 30 m) and seabed (GEBCO, ~460 m) are merged into
 *     ONE continuous elevation field in metres: land positive, seabed negative, waterline at 0. No
 *     more separate land path + fake exponential depth.
 *   • SIGNED QUANTIZATION — heights are encoded across [minElevation, maxElevation] (both written to
 *     the manifest) instead of 0..targetPeakElevation, so negative depths survive the Uint16 chunks.
 *
 * Usage (from server/):
 *   node scripts/build-terrain-region.mjs <regionId> [--res=2048] [--vscale=1] [--sea=0.8]
 *   npm run build:terrain-region cyclades_naxos
 *
 * Output: overwrites server/assets/terrain/ (manifest.json + chunk_*.bin) — the client loads it as-is.
 */

import { fromArrayBuffer } from 'geotiff';
import pngjs from 'pngjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import terrainConfig from '../config/terrain.config.js';
import { SOURCES, regionById } from '../data/region-catalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = join(__dirname, '..', 'assets', 'maps', 'sources');

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const regionId = args.find((a) => !a.startsWith('--'));
const numArg = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};
const OUT = numArg('res', 2048);          // square output grid edge (texels)
const VSCALE = numArg('vscale', 1.0);     // vertical exaggeration (1 = real metres)
const SEA_THRESH = numArg('sea', 0.8);    // COP30 height (m) above which a cell is treated as land

if (!regionId) { console.error('Usage: build-terrain-region.mjs <regionId> [--res=] [--vscale=] [--sea=]'); process.exit(1); }
const region = regionById(regionId);
if (!region) { console.error(`Unknown region: ${regionId}`); process.exit(1); }
const regionDir = join(SOURCES_DIR, region.id);
if (!existsSync(regionDir)) { console.error(`No fetched sources for ${region.id} — run: npm run fetch:terrain-sources ${region.id}`); process.exit(1); }

// ── Decode a source GeoTIFF → { data, width, height, bbox:[W,S,E,N], nodata } ──
async function decode(file) {
  const buf = readFileSync(join(regionDir, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const image = await (await fromArrayBuffer(ab)).getImage();
  const [data] = await image.readRasters();
  return { data, width: image.getWidth(), height: image.getHeight(), bbox: image.getBoundingBox(), nodata: image.getGDALNoData() };
}

/** Bilinear sample a source raster at geographic (lon, lat); returns `fallback` outside / on nodata. */
function sampleGeo(src, lon, lat, fallback) {
  const [W, S, E, N] = src.bbox;
  const fx = ((lon - W) / (E - W)) * (src.width - 1);
  const fy = ((N - lat) / (N - S)) * (src.height - 1);          // row 0 = north
  if (fx < 0 || fy < 0 || fx > src.width - 1 || fy > src.height - 1) return fallback;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const at = (x, y) => {
    const v = src.data[y * src.width + x];
    if ((src.nodata !== null && v === src.nodata) || v < -1e4 || !Number.isFinite(v)) return fallback;
    return v;
  };
  const a = at(x0, y0), b = at(x1, y0), c = at(x0, y1), d = at(x1, y1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

async function run() {
  const { worldBounds, chunkSize, quantizationLevels: QUANT, outputDir } = terrainConfig;
  console.log(`Building '${region.id}' [${region.archetype}] → ${OUT}×${OUT} grid, vscale ${VSCALE}\n`);

  const land = await decode(SOURCES.land.file);
  const bathy = await decode(SOURCES.bathy.file);
  console.log(`  land  ${SOURCES.land.demtype}: ${land.width}×${land.height}  bbox ${land.bbox.map((v) => v.toFixed(3))}`);
  console.log(`  bathy ${SOURCES.bathy.demtype}: ${bathy.width}×${bathy.height}  bbox ${bathy.bbox.map((v) => v.toFixed(3))}`);

  // World ↔ geographic mapping. The land tif's actual extent defines the region window; the world
  // (square, ±worldBounds) maps 1:1 onto it. Row 0 = north = worldBounds.maxZ (matches getElevation).
  const [W, S, E, N] = land.bbox;
  const field = new Float32Array(OUT * OUT);
  let minY = Infinity, maxY = -Infinity, landCells = 0;

  for (let oz = 0; oz < OUT; oz++) {
    const tz = oz / (OUT - 1);
    const lat = N - tz * (N - S);
    for (let ox = 0; ox < OUT; ox++) {
      const tx = ox / (OUT - 1);
      const lon = W + tx * (E - W);
      const l = sampleGeo(land, lon, lat, 0);                 // metres, ocean ≈ 0, nodata → 0 (sea)
      let y;
      if (l > SEA_THRESH) {                                   // sharp real land from Copernicus
        y = l;
        landCells++;
      } else {                                                // real ocean depth from GEBCO (clamp ≤ 0)
        y = Math.min(0, sampleGeo(bathy, lon, lat, 0));
      }
      y *= VSCALE;
      field[oz * OUT + ox] = y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxY <= minY) { console.error('Degenerate elevation range — bad source data?'); process.exit(1); }
  console.log(`\n  elevation range [${minY.toFixed(1)}, ${maxY.toFixed(1)}] m  ·  land ${(100 * landCells / (OUT * OUT)).toFixed(1)}%`);

  // ── Quantize + chunk (Uint16LE, signed range encoded via minY..maxY) ─────────
  mkdirSync(outputDir, { recursive: true });
  for (const f of readdirSync(outputDir)) {
    if (f.startsWith('chunk_') && f.endsWith('.bin')) rmSync(join(outputDir, f));   // clear stale chunks
  }
  const span = maxY - minY;
  const chunkCountX = Math.ceil(OUT / chunkSize), chunkCountZ = Math.ceil(OUT / chunkSize);
  for (let cz = 0; cz < chunkCountZ; cz++) {
    for (let cx = 0; cx < chunkCountX; cx++) {
      const x0 = cx * chunkSize, z0 = cz * chunkSize;
      const w = Math.min(chunkSize, OUT - x0), h = Math.min(chunkSize, OUT - z0);
      const out = Buffer.alloc(w * h * 2);
      let p = 0;
      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          const y = field[(z0 + z) * OUT + (x0 + x)];
          const q = Math.max(0, Math.min(QUANT, Math.round(((y - minY) / span) * QUANT)));
          out.writeUInt16LE(q, p); p += 2;
        }
      }
      writeFileSync(join(outputDir, `chunk_${cz}_${cx}.bin`), out);
    }
  }

  // ── Spawns: navigable open water near a coast ────────────────────────────────
  const spawns = findSpawns(field, OUT, worldBounds);

  const manifest = {
    version: 2,
    source: region.id,
    sourceName: region.name,
    archetype: region.archetype,
    width: OUT,
    height: OUT,
    chunkSize,
    chunkCountX,
    chunkCountZ,
    quantizationLevels: QUANT,
    // Signed elevation encoding: y = (q / QUANT) * (maxElevation - minElevation) + minElevation.
    minElevation: +minY.toFixed(3),
    maxElevation: +maxY.toFixed(3),
    targetPeakElevation: +Math.max(1, maxY).toFixed(3),   // kept for legacy biome-colour banding
    seaLevel: 0,
    verticalScale: VSCALE,
    worldBounds,
    spawns,
  };
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Neutralise the stale AO lightmap from the old PNG pipeline (the terrain material multiplies it,
  // so a mismatched bake would randomly darken this island). A flat-white map = no darkening. Real
  // AO/normal/flow aux maps are generated properly in a later phase.
  const { PNG } = pngjs;
  const ao = new PNG({ width: 8, height: 8 });
  ao.data.fill(255);
  writeFileSync(join(outputDir, 'ao_map.png'), PNG.sync.write(ao));

  console.log(`  ${chunkCountX}×${chunkCountZ} chunks + manifest + neutral ao_map written → ${outputDir}`);
  console.log(`  ${spawns.length} spawn point(s).\nDone.`);
}

/** Pick spread-out spawn points in navigable water (−40…−4 m) within ~1.5 km of land. */
function findSpawns(field, OUT, worldBounds) {
  const cellM = (worldBounds.maxX - worldBounds.minX) / (OUT - 1);
  const nearLandCells = Math.round(1500 / cellM);
  const minSepM = 4000;
  const toWorld = (ox, oz) => ({
    x: worldBounds.minX + (ox / (OUT - 1)) * (worldBounds.maxX - worldBounds.minX),
    z: worldBounds.maxZ - (oz / (OUT - 1)) * (worldBounds.maxZ - worldBounds.minZ),
  });
  const isLand = (ox, oz) => field[oz * OUT + ox] > 0.5;
  const hasLandNear = (ox, oz) => {
    const step = Math.max(1, Math.round(nearLandCells / 6));
    for (let dz = -nearLandCells; dz <= nearLandCells; dz += step) {
      for (let dx = -nearLandCells; dx <= nearLandCells; dx += step) {
        const x = ox + dx, z = oz + dz;
        if (x >= 0 && z >= 0 && x < OUT && z < OUT && isLand(x, z)) return true;
      }
    }
    return false;
  };
  const spawns = [];
  const scan = Math.max(8, Math.round(OUT / 64));
  for (let oz = 0; oz < OUT && spawns.length < 8; oz += scan) {
    for (let ox = 0; ox < OUT && spawns.length < 8; ox += scan) {
      const y = field[oz * OUT + ox];
      if (y < -40 || y > -4) continue;                 // navigable depth band
      if (!hasLandNear(ox, oz)) continue;              // must be near an island
      const wp = toWorld(ox, oz);
      if (spawns.some((s) => Math.hypot(s.x - wp.x, s.z - wp.z) < minSepM)) continue;
      spawns.push({ x: +wp.x.toFixed(1), z: +wp.z.toFixed(1), heading: Math.round((ox * 47 + oz * 13) % 360) });
    }
  }
  return spawns;
}

run().catch((err) => { console.error('\nFatal:', err); process.exit(1); });
