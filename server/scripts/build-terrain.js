#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const terrainConfig = require('../config/terrain.config');

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readPng(filePath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(new PNG())
      .on('parsed', function onParsed() {
        resolve(this);
      })
      .on('error', reject);
  });
}

function sampleHeightAt(imageHeights, width, height, x, y) {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  return imageHeights[clampedY * width + clampedX];
}

function smoothHeightfield(input, width, height, iterations, strength) {
  let field = input;
  const iterCount = Math.max(0, Math.floor(iterations || 0));
  const blend = clamp01(strength ?? 0);
  if (iterCount === 0 || blend <= 0) return field;

  for (let iter = 0; iter < iterCount; iter++) {
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const base = field[idx];
        if (base <= 0) {
          out[idx] = 0;
          continue;
        }

        const h00 = sampleHeightAt(field, width, height, x - 1, y - 1);
        const h10 = sampleHeightAt(field, width, height, x,     y - 1);
        const h20 = sampleHeightAt(field, width, height, x + 1, y - 1);
        const h01 = sampleHeightAt(field, width, height, x - 1, y);
        const h11 = sampleHeightAt(field, width, height, x,     y);
        const h21 = sampleHeightAt(field, width, height, x + 1, y);
        const h02 = sampleHeightAt(field, width, height, x - 1, y + 1);
        const h12 = sampleHeightAt(field, width, height, x,     y + 1);
        const h22 = sampleHeightAt(field, width, height, x + 1, y + 1);

        // 3x3 gaussian kernel:
        // 1 2 1
        // 2 4 2
        // 1 2 1
        const blurred = (
          h00 + 2 * h10 + h20 +
          2 * h01 + 4 * h11 + 2 * h21 +
          h02 + 2 * h12 + h22
        ) / 16;

        out[idx] = clamp01(base * (1 - blend) + blurred * blend);
      }
    }
    field = out;
  }

  return field;
}

function remapElevationLevels(input, width, height, gamma, reliefBoost, reliefBlend) {
  const g = Math.max(0.25, Math.min(3.0, gamma || 1));
  const boost = Math.max(0, reliefBoost || 0);
  const blend = clamp01(reliefBlend || 0);

  // Pass 1: gamma remap for better separation of subtle levels.
  const remapped = new Float32Array(width * height);
  for (let i = 0; i < input.length; i++) {
    const base = input[i];
    remapped[i] = base <= 0 ? 0 : clamp01(Math.pow(base, g));
  }

  if (boost <= 0 || blend <= 0) {
    return remapped;
  }

  // Pass 2: local relief enhancement (high-pass detail), blended conservatively.
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const base = remapped[idx];
      if (base <= 0) {
        out[idx] = 0;
        continue;
      }

      const h00 = sampleHeightAt(remapped, width, height, x - 1, y - 1);
      const h10 = sampleHeightAt(remapped, width, height, x,     y - 1);
      const h20 = sampleHeightAt(remapped, width, height, x + 1, y - 1);
      const h01 = sampleHeightAt(remapped, width, height, x - 1, y);
      const h11 = sampleHeightAt(remapped, width, height, x,     y);
      const h21 = sampleHeightAt(remapped, width, height, x + 1, y);
      const h02 = sampleHeightAt(remapped, width, height, x - 1, y + 1);
      const h12 = sampleHeightAt(remapped, width, height, x,     y + 1);
      const h22 = sampleHeightAt(remapped, width, height, x + 1, y + 1);

      const blurred = (
        h00 + 2 * h10 + h20 +
        2 * h01 + 4 * h11 + 2 * h21 +
        h02 + 2 * h12 + h22
      ) / 16;

      const detail = base - blurred;
      const boosted = clamp01(base + detail * boost);
      out[idx] = clamp01(base * (1 - blend) + boosted * blend);
    }
  }

  return out;
}

function estimateSpawnPoints(imageHeights, width, height, config) {
  const wanted = config.spawnPointsCount;
  const picks = [];
  const xStep = Math.max(10, Math.floor(width / 20));
  const yStep = Math.max(10, Math.floor(height / 20));

  const minH = 0.08;
  const maxH = 0.38;

  for (let pass = 0; pass < 2 && picks.length < wanted; pass++) {
    const startY = pass === 0 ? Math.floor(yStep / 2) : 0;
    const startX = pass === 0 ? Math.floor(xStep / 2) : 0;

    for (let y = startY; y < height && picks.length < wanted; y += yStep) {
      for (let x = startX; x < width && picks.length < wanted; x += xStep) {
        const center = sampleHeightAt(imageHeights, width, height, x, y);
        if (center < minH || center > maxH) continue;

        const n1 = sampleHeightAt(imageHeights, width, height, x + 1, y);
        const n2 = sampleHeightAt(imageHeights, width, height, x - 1, y);
        const n3 = sampleHeightAt(imageHeights, width, height, x, y + 1);
        const n4 = sampleHeightAt(imageHeights, width, height, x, y - 1);
        const slope = Math.abs(n1 - n2) + Math.abs(n3 - n4);
        if (slope > 0.08) continue;

        const wx = config.worldBounds.minX + (x / (width - 1)) * (config.worldBounds.maxX - config.worldBounds.minX);
        const wz = config.worldBounds.maxZ - (y / (height - 1)) * (config.worldBounds.maxZ - config.worldBounds.minZ);
        picks.push({ x: Math.round(wx), z: Math.round(wz), heading: 270 });
      }
    }
  }

  if (!picks.length) {
    picks.push({ x: 0, z: 0, heading: 270 });
  }

  return picks.slice(0, wanted);
}

function writeChunk(filePath, buffer) {
  fs.writeFileSync(filePath, buffer);
}

async function run() {
  const sourcePath = terrainConfig.sourceImage;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing elevation source image at ${sourcePath}`);
  }

  ensureDir(terrainConfig.outputDir);

  const png = await readPng(sourcePath);
  const width = png.width;
  const height = png.height;
  const raw = png.data;

  const threshold = clamp01(terrainConfig.waterThreshold);
  let sourceMin = 1;
  let sourceMax = 0;
  let normalizedHeights = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = raw[idx] / 255;
    const g = raw[idx + 1] / 255;
    const b = raw[idx + 2] / 255;

    // Weighted luminance for robust grayscale conversion.
    const lum = (0.299 * r) + (0.587 * g) + (0.114 * b);
    if (lum < sourceMin) sourceMin = lum;
    if (lum > sourceMax) sourceMax = lum;

    const aboveWater = (lum - threshold) / Math.max(1e-6, (1 - threshold));
    normalizedHeights[i] = clamp01(aboveWater);
  }

  normalizedHeights = smoothHeightfield(
    normalizedHeights,
    width,
    height,
    terrainConfig.smoothingIterations,
    terrainConfig.smoothingStrength,
  );

  normalizedHeights = remapElevationLevels(
    normalizedHeights,
    width,
    height,
    terrainConfig.elevationGamma,
    terrainConfig.localReliefBoost,
    terrainConfig.localReliefBlend,
  );

  const targetPeakElevation = terrainConfig.targetPeakElevation;
  const quantLevels = terrainConfig.quantizationLevels;
  const chunkSize = terrainConfig.chunkSize;
  const chunkCountX = Math.ceil(width / chunkSize);
  const chunkCountZ = Math.ceil(height / chunkSize);

  for (let cz = 0; cz < chunkCountZ; cz++) {
    for (let cx = 0; cx < chunkCountX; cx++) {
      const x0 = cx * chunkSize;
      const z0 = cz * chunkSize;
      const w = Math.min(chunkSize, width - x0);
      const h = Math.min(chunkSize, height - z0);
      const out = Buffer.alloc(w * h * 2);

      let p = 0;
      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          const srcIdx = (z0 + z) * width + (x0 + x);
          const n = normalizedHeights[srcIdx];
          const q = Math.round(n * quantLevels);
          out.writeUInt16LE(q, p);
          p += 2;
        }
      }

      const chunkName = `chunk_${cz}_${cx}.bin`;
      writeChunk(path.join(terrainConfig.outputDir, chunkName), out);
    }
  }

  const spawnPoints = estimateSpawnPoints(normalizedHeights, width, height, terrainConfig);

  const manifest = {
    version: 1,
    source: path.basename(sourcePath),
    width,
    height,
    chunkSize,
    chunkCountX,
    chunkCountZ,
    quantizationLevels: quantLevels,
    waterThreshold: threshold,
    sourceMin,
    sourceMax,
    targetPeakElevation,
    worldBounds: terrainConfig.worldBounds,
    spawns: spawnPoints,
  };

  fs.writeFileSync(
    path.join(terrainConfig.outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  console.log('Terrain build complete.');
  console.log(`Source: ${sourcePath}`);
  console.log(`Size: ${width}x${height}`);
  console.log(`Chunks: ${chunkCountX}x${chunkCountZ} (${chunkCountX * chunkCountZ} files)`);
  console.log(`Output: ${terrainConfig.outputDir}`);
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
