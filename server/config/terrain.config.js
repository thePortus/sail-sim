'use strict';

const path = require('path');

module.exports = {
  // Source grayscale elevation map image.
  sourceImage: path.join(__dirname, '..', 'assets', 'maps', 'elevation.png'),

  // Generated terrain artifacts.
  outputDir: path.join(__dirname, '..', 'assets', 'terrain'),

  // Fit full image into current playable world envelope.
  worldBounds: {
    minX: -25000,
    maxX: 25000,
    minZ: -25000,
    maxZ: 25000,
  },

  // Pixel values <= threshold are ocean only.
  // Range: 0..1 where 0 = black and 1 = white.
  waterThreshold: 0.33,

  // Chunking / quantization.
  // Larger chunk size reduces HTTP request fan-out on large source maps.
  chunkSize: 256,
  quantizationLevels: 65535,

  // Heightfield smoothing (applied before quantization).
  // Helps convert noisy/stair-stepped source maps into gently rolling terrain
  // while preserving the original large-scale shapes.
  smoothingIterations: 2,
  smoothingStrength: 0.55,

  // Elevation remapping controls for better level differentiation.
  // gamma < 1 boosts lower/mid elevations; gamma > 1 compresses them.
  elevationGamma: 0.86,
  // Local relief boost sharpens subtle differences without changing macro shape.
  localReliefBoost: 0.20,
  // How strongly boosted local detail is blended back into the terrain.
  localReliefBlend: 0.40,

  // Match current gameplay mountain scale (roughly current max island peak).
  targetPeakElevation: 920,

  // Spawn search tuning.
  spawnPointsCount: 8,
};
