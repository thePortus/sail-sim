'use strict';

const fs = require('fs');
const path = require('path');

// 3-D noise volume the volumetric clouds erode against, fetched by:
//   npm run download:cloud-noise   (also chained into download:terrain-tiles)
// Files live in assets/clouds/ and the whole assets/ tree is gitignored. Both clients fall
// back to locally-generated noise if the file is absent (a 404 here is non-fatal).
const CLOUDS_DIR = path.join(__dirname, '..', 'assets', 'clouds');

// :name → on-disk file. Whitelisted so the route can't be used to read arbitrary paths.
const VALID = {
  'greyNoise3D.bin': 'greyNoise3D.bin',   // 32³ grey-noise volume, 20-byte BIN header
};

exports.getCloudAsset = (req, res) => {
  const file = VALID[req.params.name];
  if (!file) {
    return res.status(400).json({ message: `Unknown cloud asset '${req.params.name}'.` });
  }
  const filePath = path.join(CLOUDS_DIR, file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      message: `Cloud asset '${req.params.name}' not found. Run: npm run download:cloud-noise`,
    });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  // Stable asset — cache aggressively in the browser.
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  return res.sendFile(filePath);
};
