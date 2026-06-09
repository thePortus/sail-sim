'use strict';

const path = require('path');

// Load the repo-root .env so host-run build scripts (e.g. the terrain source fetcher) pick up
// OPENTOPO_API_KEY regardless of the directory they're launched from. Vars already present in the
// environment (e.g. set by docker-compose) take precedence — dotenv never overrides them.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

module.exports = {
  // ── External data sources ──────────────────────────────────────────────────
  // OpenTopography API key for fetching Copernicus GLO-30 elevation tiles.
  // Set it in the repo-root .env (copy from .env.example) — NOT here. Blank if unset.
  openTopoApiKey: process.env.OPENTOPO_API_KEY || '',

  // ── Terrain output ───────────────────────────────────────────────────────────
  // Where the baked terrain (manifest.json + chunk_*.bin) is written and served from.
  outputDir: path.join(__dirname, '..', 'assets', 'terrain'),

  // Playable world envelope. The fetched region is mapped onto this square.
  worldBounds: {
    minX: -25000,
    maxX: 25000,
    minZ: -25000,
    maxZ: 25000,
  },

  // Chunking / quantization. Heights are stored as Uint16 chunks of chunkSize²; the world build maps
  // the signed elevation range [minElevation, maxElevation] (in the manifest) across quantizationLevels.
  chunkSize: 256,
  quantizationLevels: 65535,
};
