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
import { fileURLToPath, pathToFileURL } from 'node:url';
import terrainConfig from '../config/terrain.config.js';
import { SOURCES, regionById } from '../data/region-catalog.mjs';
import { deriveAugment } from '../data/augment.mjs';
import { hydraulicErode, thermalErode, addDetail } from '../data/erode.mjs';
import { addReefs, shoreDistanceField } from '../data/reefs.mjs';
import { computeAuxMaps, auxSlope, BIOME_PALETTE } from '../data/aux-maps.mjs';
import { assignTowns } from '../data/town-layout.mjs';

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
// Navigable-depth floor: minimum water depth that GROWS with distance from shore (see the pass below).
// --depth-floor=<scale> scales the whole curve (1 = default); --no-depth-floor disables it.
const DEPTHFLOOR = args.includes('--no-depth-floor') ? 0 : numArg('depth-floor', 1.0);
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

  // ── Navigable-depth floor ────────────────────────────────────────────────────────────────────
  // GEBCO's ~460 m texels smear island flanks into broad FALSE shallow shelves (measured: at 100–300 m
  // offshore ~23% of water was <4 m deep; banks persisted past 800 m), so "open" water often barely
  // cleared the hull and wave troughs exposed the seabed. Enforce a minimum depth that grows with
  // distance from shore: the beach entry + shallows-transparency band (<~80 m) is untouched, then the
  // seabed is guaranteed to drop away. Water cells are only ever DEEPENED (land never touched), and the
  // pass runs BEFORE addReefs(), which re-raises all the INTENTIONAL shallow features (fringing crests,
  // reef flats, lagoon shelves, seamounts) on top — so designed shallows survive, accidental banks don't.
  if (DEPTHFLOOR > 0) {
    const shoreD = shoreDistanceField(field, OUT, cellM, 0);
    // Gentle by design: the ocean's see-through reveal reads the seabed down to ~22 m, so this curve keeps
    // a WIDE visible shallows apron (nothing forced until 150 m out; only ~2.5 m by 350 m) and just
    // guarantees wave troughs can't expose sand in honestly-open water. (The first curve — 3 m @ 200 m,
    // 7 m @ 450 m — read as a cliff right off the beach; user feedback.)
    const CURVE = [[150, 0], [350, 2.5], [750, 5.5], [1500, 9], [2800, 14]];   // [shoreDist m, min depth m]
    const minDepthAt = (d) => {
      if (d <= CURVE[0][0]) return 0;
      for (let k = 1; k < CURVE.length; k++) {
        const [d1, m1] = CURVE[k - 1], [d2, m2] = CURVE[k];
        if (d <= d2) return (m1 + (m2 - m1) * (d - d1) / (d2 - d1)) * DEPTHFLOOR;
      }
      return CURVE[CURVE.length - 1][1] * DEPTHFLOOR;
    };
    let deepened = 0;
    for (let i = 0; i < OUT * OUT; i++) {
      if (field[i] > 0) continue;
      const floorY = -minDepthAt(shoreD[i]);
      if (field[i] > floorY) { field[i] = floorY; deepened++; }
    }
    console.log(`  navigable-depth floor (×${DEPTHFLOOR}): ${deepened} water cells deepened`);
  }

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

  // ── Harbor towns: flat-beach pier sites + tiered town layouts (deterministic per seed) ─────────
  // Computed BEFORE quantization/chunking so the town pads can be flattened into the field below (and so
  // the aux maps + chunks reflect the flattened ground). slope + shore-distance drive the site detection.
  const harborSlope = auxSlope(field, OUT, cellM);
  const harborShore = shoreDistanceField(field, OUT, cellM, 0);
  const harborSites = findHarbors(field, OUT, worldBounds, harborSlope, harborShore, 50);
  // Nearest-cell elevation sampler (world → texel) for choosing each town's flat-pad elevation.
  const elevAt = (wx, wz) => {
    const ox = Math.max(0, Math.min(OUT - 1, Math.round((wx - worldBounds.minX) / (worldBounds.maxX - worldBounds.minX) * (OUT - 1))));
    const oz = Math.max(0, Math.min(OUT - 1, Math.round((worldBounds.maxZ - wz) / (worldBounds.maxZ - worldBounds.minZ) * (OUT - 1))));
    return field[oz * OUT + ox];
  };
  // Building footprints (width,depth in m) from the shipped asset catalogue → drive lot spacing + pads.
  const assetCat = JSON.parse(readFileSync(join(__dirname, '..', 'assets', 'geometry', 'harbors', 'assets_manifest.json'), 'utf8'));
  const footprints = {};
  for (const a of assetCat.assets) footprints[a.id] = { w: a.footprint_m[0], d: a.footprint_m[1] };
  const harbors = assignTowns(harborSites, SEED, elevAt, footprints);
  // Bake each town's flat pad into the field (level the ground under the buildings/streets/square).
  const flattened = flattenTownPads(field, OUT, worldBounds, harbors);
  // Quay + basin under each pier so it crosses the waterline (landward end on land, body over water).
  const shaped = shapeHarborBasins(field, OUT, worldBounds, harbors);
  console.log(`  flattened ${harbors.length} town pads (${flattened} cells levelled); shaped pier quays/basins (${shaped} cells)`);

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
    harbors,
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
  const tierCount = harbors.reduce((m, t) => (m[t.tier] = (m[t.tier] || 0) + 1, m), {});
  const totalBuildings = harbors.reduce((n, t) => n + (t.buildings?.length || 0), 0);
  console.log(`  ${spawns.length} spawn point(s); ${harbors.length} harbor town(s) ` +
    `[capital ${tierCount.capital || 0}, medium ${tierCount.medium || 0}, small ${tierCount.small || 0}]; ` +
    `${totalBuildings} buildings.\nDone.`);
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

  // S2 control/splat map — full-res RGBA soft biome weights (sand/grass/gravel/rock; snow = remainder).
  const splatPng = new PNG({ width: OUT, height: OUT });
  splatPng.data.set(maps.splat);
  writeFileSync(join(outputDir, 'splat_map.png'), PNG.sync.write(splatPng));

  return {
    resolution: res, packed: 'aux_map.png', channels: { r: 'slope', g: 'shoreDist', b: 'wetness', a: 'flow' },
    slopeMaxMPerM: SLOPE_MAX, shoreDistMaxM: SHORE_MAX, flowLogNorm: true,
    biome: 'biome_map.png', biomeIds: ['seabed', 'sand', 'grass', 'gravel', 'rock', 'snow'],
    splat: 'splat_map.png', splatResolution: OUT, splatChannels: { r: 'sand', g: 'grass', b: 'gravel', a: 'rock', snow: '1-sum' },
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

/**
 * Measure the flat, buildable land behind a shore point (texel space). Marches INLAND along the landward
 * unit dir for `depthM`, then sideways at the midpoint for `widthM`, stopping where the ground is no longer
 * low + gentle (a town needs a flat-ish apron, not a cliff). Used to tier towns and size their flat pads.
 */
function marchInlandFlat(field, slope, OUT, cellM, ox, oz, landTx, landTz) {
  const FLAT = 0.30;                                  // m/m — buildable ground (looser than the beach test)
  const idx = (x, z) => (x < 0 || z < 0 || x >= OUT || z >= OUT) ? -1 : z * OUT + x;
  const ok = (i) => i >= 0 && field[i] > 0 && field[i] <= 18 && slope[i] <= FLAT;
  let depthCells = 0;
  for (let s = 1; s <= Math.round(110 / cellM); s++) {
    const i = idx(Math.round(ox + landTx * s), Math.round(oz + landTz * s));
    if (!ok(i)) break;
    depthCells = s;
  }
  const mx = Math.round(ox + landTx * Math.max(1, depthCells / 2));
  const mz = Math.round(oz + landTz * Math.max(1, depthCells / 2));
  const px = -landTz, pz = landTx;                    // perpendicular to the landward dir
  let wp = 0, wm = 0;
  const reach = Math.round(70 / cellM);
  for (let s = 1; s <= reach; s++) { if (!ok(idx(Math.round(mx + px * s), Math.round(mz + pz * s)))) break; wp = s; }
  for (let s = 1; s <= reach; s++) { if (!ok(idx(Math.round(mx - px * s), Math.round(mz - pz * s)))) break; wm = s; }
  return { depthM: depthCells * cellM, widthM: (wp + wm) * cellM };
}

/**
 * Level the ground under each town's pad rectangle so buildings/streets sit flat (Harbor Towns v2 P2).
 * Each pad is an oriented rect (cx,cz, halfX across, halfZ along the heading, rotY, target elev). Cells
 * inside the rect are set to the pad elevation; a one-cell ramp blends out to the surrounding terrain so
 * there's no cliff edge. Only GENUINELY DEEP water (elev < -3 m) is left untouched, so the pier's mooring
 * water survives while the shallow shoreline under the apron is raised to a solid, level waterfront (stilt-
 * shacks are excluded from the pad and stay at the waterline). Returns the number of cells modified.
 */
function flattenTownPads(field, OUT, worldBounds, harbors) {
  const { minX, maxX, minZ, maxZ } = worldBounds;
  const cellM = (maxX - minX) / (OUT - 1);
  const ramp = cellM;                                  // one-cell blend skirt
  let touched = 0;
  for (const t of harbors) {
    const pad = t.pad;
    const hr = pad.rotY * Math.PI / 180;
    const fwd = [-Math.sin(hr), -Math.cos(hr)];        // along the pad's halfZ axis (inland)
    const rgt = [ Math.cos(hr), -Math.sin(hr)];        // along the pad's halfX axis (across)
    const seaX = Math.sin(hr), seaZ = Math.cos(hr);    // SEAWARD unit (away from the shore point t.x,t.z)
    const reach = Math.hypot(pad.halfX, pad.halfZ) + ramp + cellM;
    const cox = (pad.cx - minX) / (maxX - minX) * (OUT - 1);
    const coz = (maxZ - pad.cz) / (maxZ - minZ) * (OUT - 1);
    const rCells = Math.ceil(reach / cellM) + 1;
    for (let oz = Math.max(0, Math.floor(coz - rCells)); oz <= Math.min(OUT - 1, Math.ceil(coz + rCells)); oz++) {
      for (let ox = Math.max(0, Math.floor(cox - rCells)); ox <= Math.min(OUT - 1, Math.ceil(cox + rCells)); ox++) {
        const wx = minX + ox / (OUT - 1) * (maxX - minX);
        const wz = maxZ - oz / (OUT - 1) * (maxZ - minZ);
        const dx = wx - pad.cx, dz = wz - pad.cz;
        const f = Math.abs(dx * fwd[0] + dz * fwd[1]);
        const s = Math.abs(dx * rgt[0] + dz * rgt[1]);
        // Full-flatten extends one cell beyond the manifest rect (so a building whose centre sits near the
        // edge — its nearest texel can be up to half a cell out at this 24 m resolution — still levels), then
        // a one-cell ramp blends to the surrounding terrain.
        const outside = Math.hypot(Math.max(0, f - pad.halfZ - cellM), Math.max(0, s - pad.halfX - cellM));
        if (outside > ramp) continue;
        const i = oz * OUT + ox;
        // Water rule: PRESERVE water near/seaward of the shore point (the pier + harbor live there — filling
        // it would bury the pier) and PRESERVE deep water (a big fill wall looks wrong); but DO fill shallow
        // water that sits well INLAND under the building apron (reclaimed waterfront on irregular/bay coasts,
        // so those buildings still level). sw = signed seaward distance from the shore point (negative = inland).
        const sw = (wx - t.x) * seaX + (wz - t.z) * seaZ;
        if (field[i] < 0 && (sw > -12 || field[i] < -6)) continue;
        const w = outside <= 0 ? 1 : 1 - outside / ramp;
        field[i] = field[i] * (1 - w) + pad.elev * w;
        touched++;
      }
    }
  }
  return touched;
}

/**
 * Shape a quay + basin around each pier so it crosses the waterline: ONE END ON LAND, the rest over water.
 * The pier origin is the shore (waterline) cell, and the pier (~14 m) is shorter than one 24 m terrain cell,
 * so we can't carve the transition within that cell — instead we set the SHORE cell to a low quay (+QUAY,
 * ~deck height → land) and the seaward cells to a deep basin (-DEPTH → water). The renderer's bilinear
 * interpolation between them ramps the ground under the pier from land down through the waterline to water,
 * so the landward end sits firmly on the quay and the body stands over the basin. Quay only raises; basin
 * only deepens water/shallows (never gouges land).
 */
function shapeHarborBasins(field, OUT, worldBounds, harbors) {
  const { minX, maxX, minZ, maxZ } = worldBounds;
  const cellM = (maxX - minX) / (OUT - 1);
  const QUAY = 1.2, DEPTH = -3.5, REACH = 36, HW_QUAY = 9, HW_BASIN = 14, ramp = cellM;
  const cut = cellM * 0.55;                            // boundary: quay = the shore cell, basin = seaward cells
  let touched = 0;
  for (const t of harbors) {
    const hr = t.heading * Math.PI / 180;
    const seaX = Math.sin(hr), seaZ = Math.cos(hr);    // seaward (pier extends this way)
    const rgtX = Math.cos(hr), rgtZ = -Math.sin(hr);   // across the pier
    const ccx = t.x + seaX * REACH / 2, ccz = t.z + seaZ * REACH / 2;
    const cox = (ccx - minX) / (maxX - minX) * (OUT - 1);
    const coz = (maxZ - ccz) / (maxZ - minZ) * (OUT - 1);
    const rCells = Math.ceil((Math.hypot(REACH / 2, HW_BASIN) + ramp + cellM) / cellM) + 1;
    for (let oz = Math.max(0, Math.floor(coz - rCells)); oz <= Math.min(OUT - 1, Math.ceil(coz + rCells)); oz++) {
      for (let ox = Math.max(0, Math.floor(cox - rCells)); ox <= Math.min(OUT - 1, Math.ceil(cox + rCells)); ox++) {
        const wx = minX + ox / (OUT - 1) * (maxX - minX);
        const wz = maxZ - oz / (OUT - 1) * (maxZ - minZ);
        const a = (wx - t.x) * seaX + (wz - t.z) * seaZ;   // along-seaward from the shore point
        const s = (wx - t.x) * rgtX + (wz - t.z) * rgtZ;   // across
        const i = oz * OUT + ox;
        if (a >= -cut && a < cut) {                    // QUAY: raise the shore cell → landward pier end on land
          if (Math.max(0, Math.abs(s) - HW_QUAY) > ramp) continue;
          const w = 1 - Math.max(0, Math.abs(s) - HW_QUAY) / ramp;
          const nv = field[i] * (1 - w) + QUAY * w;
          if (nv > field[i]) { field[i] = nv; touched++; }
        } else if (a >= cut && a <= REACH) {           // BASIN: deepen seaward water → pier body over water
          if (field[i] > 0.5) continue;                // never gouge land
          const outside = Math.hypot(a > REACH ? a - REACH : 0, Math.max(0, Math.abs(s) - HW_BASIN));
          if (outside > ramp) continue;
          const w = 1 - outside / ramp;
          const nv = field[i] * (1 - w) + DEPTH * w;
          if (nv < field[i]) { field[i] = nv; touched++; }
        }
      }
    }
  }
  return touched;
}

/**
 * Detect harbor-town pier sites: flat-beach shore points with open navigable water ahead, where a pier
 * can run from the sand out over the sea. Returns up to `maxSites` spread-out sites as
 * { x, z, heading } — x,z is the shore point at the waterline (pier origin), heading points SEAWARD
 * (the pier's body extends that way, and the docking water lies ahead). Deterministic given the field.
 *
 * Criteria (per candidate coastal water cell):
 *   • shallow coastal water (depth band) within ~1.5 cells of land → it's right at a shore;
 *   • the landward side is a FLAT, LOW beach (low slope a few cells inland, gentle elevation) — not a
 *     cliff or a mountain plunging into the sea;
 *   • the seaward side stays navigable water for ~PIER_REACH and ends deep enough to float a ship.
 * Scored by flatness + seaward depth, then non-max-suppressed by a minimum separation so the sites
 * spread around all the coastlines instead of clustering on the best beach.
 */
function findHarbors(field, OUT, worldBounds, slope, shoreDist, maxSites) {
  const cellM = (worldBounds.maxX - worldBounds.minX) / (OUT - 1);
  const toWorld = (ox, oz) => ({
    x: worldBounds.minX + (ox / (OUT - 1)) * (worldBounds.maxX - worldBounds.minX),
    z: worldBounds.maxZ - (oz / (OUT - 1)) * (worldBounds.maxZ - worldBounds.minZ),
  });
  const at = (ox, oz) => (ox < 0 || oz < 0 || ox >= OUT || oz >= OUT) ? NaN : field[oz * OUT + ox];

  const MIN_SEP_M       = 1700;                       // spread sites apart (≈ unique towns per coast)
  const minSepCells     = MIN_SEP_M / cellM;
  const FLAT_SLOPE      = 0.22;                        // m/m — landward beach must be at/under this
  const REACH_CELLS     = Math.max(3, Math.round(90 / cellM));  // ~90 m seaward must stay navigable
  const SEAWARD_MIN_DEP = -1.5;                        // m — water at the pier end must float a ship
  const COAST_NEAR_M    = 1.6 * cellM;                 // candidate water must hug the shore

  const cands = [];
  const scan = 3;   // texel step (fine enough to hit most coastline, NMS thins it out)
  for (let oz = 2; oz < OUT - 2; oz += scan) {
    for (let ox = 2; ox < OUT - 2; ox += scan) {
      const i = oz * OUT + ox;
      const y = field[i];
      if (y < -8 || y >= -0.3) continue;                // shallow coastal water just below the surface
      if (shoreDist[i] > COAST_NEAR_M) continue;        // must be right at a shore

      // Shore normal from the elevation gradient: uphill (toward land) vs downhill (seaward), texel space.
      const gx = (at(ox + 1, oz) - at(ox - 1, oz)) / (2 * cellM);
      const gy = (at(ox, oz + 1) - at(ox, oz - 1)) / (2 * cellM);
      const glen = Math.hypot(gx, gy);
      if (!(glen > 1e-4)) continue;                     // flat/ambiguous → no defined shore facing
      const landTx = gx / glen, landTz = gy / glen;     // unit, toward land (uphill), texel space
      const seaTx = -landTx, seaTz = -landTz;

      // Landward beach must be flat + low (a beach, not a cliff/headland).
      const lcx = Math.round(ox + landTx * 3), lcz = Math.round(oz + landTz * 3);
      if (lcx < 0 || lcz < 0 || lcx >= OUT || lcz >= OUT) continue;
      const li = lcz * OUT + lcx;
      const landElev = field[li];
      if (landElev <= 0 || landElev > 10) continue;     // gentle low beach above the waterline
      if (slope[li] > FLAT_SLOPE) continue;             // flat, walkable sand — not a steep shore

      // Seaward water must stay open + navigable for the pier + ship approach.
      let ok = true, endDepth = y;
      for (let s = 1; s <= REACH_CELLS; s++) {
        const d = at(Math.round(ox + seaTx * s), Math.round(oz + seaTz * s));
        if (!(d < 0)) { ok = false; break; }            // land/reef breaks the surface ahead
        endDepth = d;
      }
      if (!ok || endDepth > SEAWARD_MIN_DEP) continue;

      // Shore point (pier origin) = step landward to the waterline crossing.
      let sx = ox, sz = oz;
      for (let s = 1; s <= 4; s++) {
        const nx = Math.round(ox + landTx * s), nz = Math.round(oz + landTz * s);
        if (!(at(nx, nz) < 0)) break;                   // next step is land → stop at last water cell
        sx = nx; sz = nz;
      }
      const wp = toWorld(sx, sz);
      const heading = (Math.atan2(-gx, gy) * 180 / Math.PI + 360) % 360;   // world seaward dir → heading
      // How much flat, buildable land lies inland behind this shore point → drives town tier + pad size.
      const flat = marchInlandFlat(field, slope, OUT, cellM, sx, sz, landTx, landTz);
      const score = (1 - slope[li] / FLAT_SLOPE) + Math.min(1, -endDepth / 4) + Math.min(1.5, flat.depthM / 60);
      cands.push({ ox: sx, oz: sz, x: +wp.x.toFixed(1), z: +wp.z.toFixed(1), heading: Math.round(heading),
        inlandFlatM: Math.round(flat.depthM), flatWidthM: Math.round(flat.widthM), score });
    }
  }

  // Best-first, spread apart by min separation.
  cands.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of cands) {
    if (kept.some((k) => Math.hypot(k.ox - c.ox, k.oz - c.oz) < minSepCells)) continue;
    kept.push(c);
    if (kept.length >= maxSites) break;
  }
  return kept;
}

// Auto-run when invoked directly. argv[1] may be relative, so normalise it to a file URL before
// comparing (so the module can also be imported without triggering a build).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error('\nFatal:', err); process.exit(1); });
}

