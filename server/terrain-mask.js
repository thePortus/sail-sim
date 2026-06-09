'use strict';

/**
 * Server-side land/water lookup for movement validation. Loads the SAME baked terrain the client
 * renders (manifest + chunk_<cz>_<cx>.bin) once, into a single Uint16 heightfield, and answers
 * `isOnLand(worldX, worldZ)`. Used by movement.js to reject a (non-admin) player whose hull centre
 * is driven onto land — honest clients already stop at the shore via their own collision, so this is
 * purely a backstop against teleport/no-clip cheats.
 *
 * Chunk layout mirrors the client's terrain.service loadChunk(): little-endian Uint16, row-major
 * within each 256×256 chunk, placed at global (z0+z)*width + (x0+x). The elevation decode mirrors
 * getElevation()'s signed-field path: elev = (q/quantLevels)*(maxE-minE) + minE.
 */

const fs = require('fs');
const path = require('path');
const terrainConfig = require('./config/terrain.config');

// Reject a position only once its elevation is clearly above the waterline. Honest boats sit with
// their broadcast CENTRE in water even while hugging a shore (the bow grounds first, well ahead of
// centre), so a small positive margin guarantees we never fight a legitimate shore-hugger; cheaters
// who drive onto an island read tens/hundreds of metres, far past this.
const LAND_ELEV_MARGIN_M = 0.5;

let loaded = false;        // load attempted (success or fail) — only try once
let field = null;          // Uint16Array(width*height) or null if unavailable
let meta = null;           // { width, height, minE, maxE, quant, wb }

function load() {
  loaded = true;
  try {
    const manifestPath = path.join(terrainConfig.outputDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return;
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const width = m.width, height = m.height, cs = m.chunkSize;
    const hf = new Uint16Array(width * height);

    for (let cz = 0; cz < m.chunkCountZ; cz++) {
      for (let cx = 0; cx < m.chunkCountX; cx++) {
        const chunkPath = path.join(terrainConfig.outputDir, `chunk_${cz}_${cx}.bin`);
        if (!fs.existsSync(chunkPath)) return;   // incomplete bake → fail-open (no land checks)
        const buf = fs.readFileSync(chunkPath);
        const x0 = cx * cs, z0 = cz * cs;
        const chunkW = Math.min(cs, width - x0);
        const chunkH = Math.min(cs, height - z0);
        let off = 0;
        for (let z = 0; z < chunkH; z++) {
          for (let x = 0; x < chunkW; x++) {
            hf[(z0 + z) * width + (x0 + x)] = buf.readUInt16LE(off);
            off += 2;
          }
        }
      }
    }

    field = hf;
    meta = {
      width, height,
      minE: m.minElevation, maxE: m.maxElevation,
      quant: m.quantizationLevels,
      wb: m.worldBounds,
    };
    console.log(`[terrain-mask] loaded ${width}x${height} heightfield for land validation`);
  } catch (err) {
    field = null; meta = null;
    console.warn('[terrain-mask] load failed — land validation disabled:', err.message);
  }
}

/** Terrain elevation (m) at a world XZ via nearest-texel sampling. NaN if terrain unavailable. */
function elevationAt(worldX, worldZ) {
  if (!loaded) load();
  if (!field || !meta) return NaN;
  const { width, height, minE, maxE, quant, wb } = meta;
  const ux = (worldX - wb.minX) / (wb.maxX - wb.minX);
  const uz = (wb.maxZ - worldZ) / (wb.maxZ - wb.minZ);   // world +Z maps to texel -Z
  let px = Math.floor(ux * width);
  let pz = Math.floor(uz * height);
  px = px < 0 ? 0 : (px > width - 1 ? width - 1 : px);
  pz = pz < 0 ? 0 : (pz > height - 1 ? height - 1 : pz);
  const q = field[pz * width + px];
  return (q / quant) * (maxE - minE) + minE;
}

/** True if the world XZ is on land (clearly above the waterline). False when terrain is unavailable
 *  (fail-open: the client still enforces its own shore collision). */
function isOnLand(worldX, worldZ) {
  const e = elevationAt(worldX, worldZ);
  return Number.isFinite(e) && e > LAND_ELEV_MARGIN_M;
}

module.exports = { isOnLand, elevationAt };
