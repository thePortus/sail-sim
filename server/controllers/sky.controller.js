'use strict';

const fs = require('fs');
const path = require('path');

// Equirectangular sky textures (NASA, public domain) fetched by:
//   npm run download:sky-textures   (also chained into download:terrain-tiles)
// Files live in assets/sky/ and the whole assets/ tree is gitignored.
const SKY_DIR = path.join(__dirname, '..', 'assets', 'sky');

// :name → on-disk file. Whitelisted so the route can't be used to read arbitrary paths. The `.ktx2` variants are
// the GPU-compressed builds (server/scripts/encode-ktx2.mjs); the client requests them first and falls back to the
// JPG, so they're optional — a 404 here is expected until the encode step has run.
const VALID = {
  moon:         'moon.jpg',    // NASA CGI Moon Kit LROC colour 1k
  stars:        'stars.jpg',   // NASA Tycho Skymap II 8192x4096
  'stars.ktx2': 'stars.ktx2',  // GPU-compressed star map (optional; client prefers it, falls back to stars.jpg)
};

exports.getSkyTexture = (req, res) => {
  const file = VALID[req.params.name];
  if (!file) {
    return res.status(400).json({ message: `Unknown sky texture '${req.params.name}'.` });
  }
  const filePath = path.join(SKY_DIR, file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      message: `Sky texture '${req.params.name}' not found. Run: npm run download:sky-textures`,
    });
  }
  res.setHeader('Content-Type', file.endsWith('.ktx2') ? 'image/ktx2' : 'image/jpeg');
  // Stable, public-domain assets — cache aggressively in the browser.
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  return res.sendFile(filePath);
};
