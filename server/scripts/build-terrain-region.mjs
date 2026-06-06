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
import { deriveAugment } from '../data/augment.mjs';
import { hydraulicErode, thermalErode, addDetail } from '../data/erode.mjs';
import { addReefs } from '../data/reefs.mjs';
import { computeAuxMaps, BIOME_PALETTE } from '../data/aux-maps.mjs';

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
const SEED = args.some((a) => a.startsWith('--seed=')) ? numArg('seed', 0) : null;   // null → identity
const ERODE   = args.includes('--no-erode')   ? 0 : numArg('erode', 120000);   // hydraulic droplet count
const THERMAL = args.includes('--no-thermal') ? 0 : numArg('thermal', 3);      // talus relax iterations
const DETAIL  = args.includes('--no-detail')  ? 0 : numArg('detail', 2.5);     // fBm micro-relief amp (m)
// Bathymetry polish (Phase 3): fringing reefs + lagoon shelves + seamounts + seabed micro-relief.
// Per-archetype defaults; override with --reefs=<0..1> (fringing intensity), --lagoon=<0..1>,
// --seamounts=<N>, --reef-detail=<m>; disable any with --no-reefs / --no-lagoon / --no-seamounts;
// --no-bathy skips the whole pass. (null → archetype default, NaN from a bad value → also default.)
const REEFS     = args.includes('--no-reefs')      ? 0 : (args.some((a) => a.startsWith('--reefs='))     ? numArg('reefs', NaN)       : null);
const REEFDET   = args.some((a) => a.startsWith('--reef-detail=')) ? numArg('reef-detail', NaN) : null;
const LAGOON    = args.includes('--no-lagoon')     ? 0 : (args.some((a) => a.startsWith('--lagoon='))    ? numArg('lagoon', NaN)      : null);
const SEAMOUNTS = args.includes('--no-seamounts')  ? 0 : (args.some((a) => a.startsWith('--seamounts=')) ? numArg('seamounts', NaN)   : null);
const NOBATHY   = args.includes('--no-bathy');
// Aux maps (Phase 6): slope / shore-dist / wetness / flow / biome — the substrate for skinning.
const NOAUX     = args.includes('--no-aux');
const AUX_RES   = numArg('aux-res', 1024);

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
  const DEEP = -60;                                           // open-ocean fallback for out-of-window samples
  const aug = SEED != null ? deriveAugment(SEED, region.archetype) : null;
  if (aug) console.log(`  augment seed ${SEED}: ${aug.label}`);
  const field = new Float32Array(OUT * OUT);
  let landCells = 0;

  for (let oz = 0; oz < OUT; oz++) {
    for (let ox = 0; ox < OUT; ox++) {
      // Normalised output coords → (optionally augmented) → geographic lon/lat.
      let u = ox / (OUT - 1), v = oz / (OUT - 1);
      if (aug) { [u, v] = aug.transform(u, v); }
      const lon = W + u * (E - W);
      const lat = N - v * (N - S);                            // v=0 → north
      const l = sampleGeo(land, lon, lat, 0);                 // metres, ocean ≈ 0 / OOB → 0 (sea)
      let y;
      if (l > SEA_THRESH) {                                   // sharp real land from Copernicus
        y = l;
        landCells++;
      } else {                                                // real ocean depth from GEBCO (OOB → deep)
        y = Math.min(0, sampleGeo(bathy, lon, lat, DEEP));
      }
      y *= VSCALE;
      if (aug) y += aug.seaLevel;                             // sea-level shift (land & seabed together)
      field[oz * OUT + ox] = y;
    }
  }

  // ── Erosion + detail touch-up (Phase 2b) — gentle, land-only; enhances the real terrain ─────
  const cellM = (worldBounds.maxX - worldBounds.minX) / (OUT - 1);
  if (ERODE)   { hydraulicErode(field, OUT, SEED ?? 1, { droplets: ERODE, seaLevel: 0 }); console.log(`  hydraulic erosion: ${ERODE} droplets`); }
  if (THERMAL) { thermalErode(field, OUT, { iterations: THERMAL, talus: Math.tan(38 * Math.PI / 180) * cellM, seaLevel: 0 }); console.log(`  thermal erosion: ${THERMAL} iters (talus ${(Math.tan(38 * Math.PI / 180) * cellM).toFixed(1)} m/cell)`); }
  if (DETAIL)  { addDetail(field, OUT, SEED ?? 1, { amp: DETAIL, worldM: worldBounds.maxX - worldBounds.minX, seaLevel: 0 }); console.log(`  detail touch-up: ±${DETAIL} m fBm`); }

  // ── Bathymetry polish (Phase 3) — fringing reefs + lagoon shelves + seamounts + seabed micro-relief ──
  let reefInfo = null;
  if (!NOBATHY) {
    const num = (v) => (v != null && !Number.isNaN(v) ? v : undefined);   // → undefined keeps archetype default
    const r = addReefs(field, OUT, SEED ?? 1, {
      cellM, worldM: worldBounds.maxX - worldBounds.minX, archetype: region.archetype, seaLevel: 0,
      intensity: num(REEFS), detail: num(REEFDET), lagoon: num(LAGOON), seamounts: num(SEAMOUNTS),
    });
    reefInfo = r.profile;
    console.log(`  reefs [${region.archetype}]: ${r.profile.label}  → ${r.placedSeamounts} seamount(s)`);
  }

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < field.length; i++) { const y = field[i]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxY <= minY) { console.error('Degenerate elevation range — bad source data?'); process.exit(1); }
  console.log(`\n  elevation range [${minY.toFixed(1)}, ${maxY.toFixed(1)}] m  ·  land ${(100 * landCells / (OUT * OUT)).toFixed(1)}%`);

  mkdirSync(terrainConfig.outputDir, { recursive: true });
  writeFieldPreview(field, OUT, minY, maxY, join(terrainConfig.outputDir, 'preview.png'));
  console.log(`  preview.png written`);

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

  // ── Aux maps (Phase 6): slope / shore-dist / wetness / flow / biome → packed PNGs ────────────
  let auxInfo = null;
  if (!NOAUX) {
    const maps = computeAuxMaps(field, OUT, cellM, worldBounds, Math.max(1, maxY), 0);
    auxInfo = writeAuxMaps(maps, OUT, Math.min(AUX_RES, OUT), outputDir);
    console.log(`  aux maps: slope/shoreDist/wetness/flow → aux_map.png + biome_map.png (${auxInfo.resolution}²)`);
  }

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
    seed: SEED,
    augment: aug ? { mirror: aug.mirror, rot: +aug.rot.toFixed(4), zoom: +aug.zoom.toFixed(3),
      panU: +aug.panU.toFixed(3), panV: +aug.panV.toFixed(3), seaLevel: +aug.seaLevel.toFixed(2), label: aug.label } : null,
    reefs: reefInfo ? { intensity: +reefInfo.intensity.toFixed(3), crestDepth: +reefInfo.crestDepth.toFixed(2),
      crestDistM: +reefInfo.crestDistM.toFixed(0), passDensity: +reefInfo.passDensity.toFixed(3),
      detailAmp: +reefInfo.detailAmp.toFixed(2), lagoonStrength: +reefInfo.lagoonStrength.toFixed(3),
      lagoonDepth: +reefInfo.lagoonDepth.toFixed(1), seamountCount: reefInfo.seamountCount, label: reefInfo.label } : null,
    auxMaps: auxInfo,
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

/** Colorized, hill-shaded preview of the final signed field (land ramp + bathy ramp), ~600 px. */
function writeFieldPreview(field, OUT, minY, maxY, path) {
  const { PNG } = pngjs;
  const PV = 600;
  const scale = Math.max(1, Math.ceil(OUT / PV));
  const ow = Math.floor(OUT / scale), oh = Math.floor(OUT / scale);
  const png = new PNG({ width: ow, height: oh });
  const at = (x, y) => field[Math.min(OUT - 1, Math.max(0, y)) * OUT + Math.min(OUT - 1, Math.max(0, x))];
  const lerp = (a, b, t) => a + (b - a) * t;
  const cl = (x) => Math.max(0, Math.min(1, x));
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      const sx = ox * scale, sy = oy * scale, h = at(sx, sy);
      let rgb;
      if (h <= 0) {
        const d = cl(h / (minY || -1));                          // 0 surface → 1 deepest
        rgb = [lerp(170, 8, d), lerp(225, 20, d), lerp(240, 70, d)];
        // Turquoise shoal highlight so reef crests / shelves read clearly (shallowest 4 m).
        const shoal = 1 - cl(-h / 4);                            // 1 at surface → 0 by −4 m
        rgb = [lerp(rgb[0], 90, shoal * 0.7), lerp(rgb[1], 230, shoal * 0.7), lerp(rgb[2], 200, shoal * 0.7)];
      } else {
        const t = cl(h / (maxY || 1));
        const ramp = [[0, [216, 200, 150]], [0.12, [70, 120, 55]], [0.45, [110, 95, 70]], [0.78, [90, 80, 72]], [1, [235, 235, 240]]];
        let c = ramp[ramp.length - 1][1];
        for (let i = 1; i < ramp.length; i++) { if (t <= ramp[i][0]) { const f = (t - ramp[i - 1][0]) / (ramp[i][0] - ramp[i - 1][0] || 1); c = [0, 1, 2].map((k) => lerp(ramp[i - 1][1][k], ramp[i][1][k], f)); break; } }
        // hillshade
        const ex = 6;
        let nx = -((at(sx + scale, sy) - at(sx - scale, sy)) / (scale * 2)) * ex;
        let ny = -((at(sx, sy + scale) - at(sx, sy - scale)) / (scale * 2)) * ex;
        const inv = 1 / Math.hypot(nx, ny, 1); nx *= inv; ny *= inv;
        const lit = cl(0.5 + 0.8 * (nx * -0.5 + ny * -0.7 + inv * 0.5));
        rgb = c.map((v) => v * lit);
      }
      const idx = (oy * ow + ox) * 4;
      png.data[idx] = rgb[0]; png.data[idx + 1] = rgb[1]; png.data[idx + 2] = rgb[2]; png.data[idx + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

/** Pack the aux maps into aux_map.png (RGBA = slope, shoreDist, wetness, flow) + biome_map.png
 *  (palette), downsampled to `res`, and a human-readable aux_preview.png montage. Returns the manifest
 *  descriptor. */
function writeAuxMaps(maps, OUT, res, outputDir) {
  const { PNG } = pngjs;
  const { slope, shoreDist, moisture, flow, biome } = maps;
  const SLOPE_MAX = 2.0, SHORE_MAX = 3000;
  let maxFlow = 1; for (let i = 0; i < flow.length; i++) if (flow[i] > maxFlow) maxFlow = flow[i];
  const logMax = Math.log(1 + maxFlow) || 1;
  const scale = OUT / res;
  const samp = (arr, ox, oy) => arr[Math.min(OUT - 1, (oy * scale) | 0) * OUT + Math.min(OUT - 1, (ox * scale) | 0)];

  const packed = new PNG({ width: res, height: res });
  const biomePng = new PNG({ width: res, height: res });
  for (let oy = 0; oy < res; oy++) {
    for (let ox = 0; ox < res; ox++) {
      const idx = (oy * res + ox) * 4;
      packed.data[idx]     = Math.min(255, (samp(slope, ox, oy) / SLOPE_MAX) * 255);
      packed.data[idx + 1] = Math.min(255, (samp(shoreDist, ox, oy) / SHORE_MAX) * 255);
      packed.data[idx + 2] = Math.min(255, samp(moisture, ox, oy) * 255);
      packed.data[idx + 3] = Math.max(8, Math.min(255, (Math.log(1 + samp(flow, ox, oy)) / logMax) * 255));
      const c = BIOME_PALETTE[samp(biome, ox, oy) | 0] || [0, 0, 0];
      biomePng.data[idx] = c[0]; biomePng.data[idx + 1] = c[1]; biomePng.data[idx + 2] = c[2]; biomePng.data[idx + 3] = 255;
    }
  }
  writeFileSync(join(outputDir, 'aux_map.png'), PNG.sync.write(packed));
  writeFileSync(join(outputDir, 'biome_map.png'), PNG.sync.write(biomePng));
  writeAuxPreview(maps, OUT, maxFlow, join(outputDir, 'aux_preview.png'));
  return {
    resolution: res, packed: 'aux_map.png', channels: { r: 'slope', g: 'shoreDist', b: 'wetness', a: 'flow' },
    slopeMaxMPerM: SLOPE_MAX, shoreDistMaxM: SHORE_MAX, flowLogNorm: true,
    biome: 'biome_map.png', biomeIds: ['seabed', 'sand', 'grass', 'gravel', 'rock', 'snow'],
  };
}

/** A 3×2 montage of the aux maps (slope, shoreDist, wetness, flow, biome) for eyeball verification. */
function writeAuxPreview(maps, OUT, maxFlow, path) {
  const { PNG } = pngjs;
  const { slope, shoreDist, moisture, flow, biome } = maps;
  const logMax = Math.log(1 + maxFlow) || 1;
  const T = 256, cols = 3, rows = 2, pad = 4;
  const W = cols * T + (cols + 1) * pad, H = rows * T + (rows + 1) * pad;
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = png.data[i + 1] = png.data[i + 2] = 18; png.data[i + 3] = 255; }
  const g = (v) => [v, v, v];
  const tiles = [
    (v) => g(Math.min(1, v / 2.0) * 255),                              // slope
    (v) => g(Math.min(1, v / 3000) * 255),                            // shoreDist
    (v) => { const s = v * 255; return [40 + s * 0.2, 80 + s * 0.6, 60 + s * 0.3]; },  // wetness (green)
    (v) => { const s = (Math.log(1 + v) / logMax) * 255; return [s * 0.4, s * 0.7, s]; },  // flow (blue)
    (v) => BIOME_PALETTE[v | 0] || [0, 0, 0],                          // biome
  ];
  const arrs = [slope, shoreDist, moisture, flow, biome];
  const scale = OUT / T;
  for (let ti = 0; ti < tiles.length; ti++) {
    const cx = ti % cols, cy = (ti / cols) | 0, ox0 = pad + cx * (T + pad), oy0 = pad + cy * (T + pad);
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const v = arrs[ti][Math.min(OUT - 1, (y * scale) | 0) * OUT + Math.min(OUT - 1, (x * scale) | 0)];
        const c = tiles[ti](v), idx = ((oy0 + y) * W + (ox0 + x)) * 4;
        png.data[idx] = c[0]; png.data[idx + 1] = c[1]; png.data[idx + 2] = c[2]; png.data[idx + 3] = 255;
      }
    }
  }
  writeFileSync(path, PNG.sync.write(png));
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
