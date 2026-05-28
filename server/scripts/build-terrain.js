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

/**
 * Generates an OpenGL tangent-space normal map from a normalised [0,1]
 * heightfield using a 3×3 Sobel kernel.
 *
 * Convention (same as Blender, Godot, Babylon.js WebGL path):
 *   R = tangent X  (right in image  = world +X)
 *   G = tangent Y  (down  in image  = world -Z before Babylon's invertY flip)
 *   B = surface-normal magnitude
 *   Flat surface → approximately (127, 127, 255)
 *
 * If you view the map in Substance Painter or other DirectX-convention tools
 * the G channel will look inverted — that is normal.  In Babylon.js, use the
 * map as-is with bumpTexture; if it looks wrong, set material.invertNormalMapY = true.
 *
 * @param {Float32Array} heights  Normalised elevation values [0,1].
 * @param {number}       width
 * @param {number}       height
 * @param {number}       strength  Gradient scale factor.  Higher = bumpier.
 * @returns {Buffer} RGBA pixel data (4 bytes per pixel, width × height pixels).
 */
function generateNormalMap(heights, width, height, strength) {
  const s   = Math.max(0.1, strength || 5.0);
  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 3×3 Sobel kernel neighbours
      const tl = sampleHeightAt(heights, width, height, x - 1, y - 1);
      const tm = sampleHeightAt(heights, width, height, x,     y - 1);
      const tr = sampleHeightAt(heights, width, height, x + 1, y - 1);
      const ml = sampleHeightAt(heights, width, height, x - 1, y    );
      const mr = sampleHeightAt(heights, width, height, x + 1, y    );
      const bl = sampleHeightAt(heights, width, height, x - 1, y + 1);
      const bm = sampleHeightAt(heights, width, height, x,     y + 1);
      const br = sampleHeightAt(heights, width, height, x + 1, y + 1);

      // Horizontal gradient (positive = slope rises going right / world +X)
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      // Vertical gradient (positive = slope rises going down the image / world -Z)
      const gy = (bl + 2 * bm + br) - (tl + 2 * tm + tr);

      // Tangent-space normal components:
      //   nx = -gx  (surface tilts right → normal leans left)
      //   ny = -gy  (surface tilts downward in image → normal leans upward in image)
      //   nz =  1/s (Z controls "sharpness" — scaling gx/gy by s is equivalent)
      const nx  = -gx * s;
      const ny  = -gy * s;
      const nz  = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

      const idx = (y * width + x) * 4;
      out[idx]     = Math.round(((nx / len) * 0.5 + 0.5) * 255); // R = X
      out[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255); // G = Y
      out[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255); // B = Z
      out[idx + 3] = 255;                                          // A = opaque
    }
  }

  return out;
}

/**
 * Writes raw RGBA pixel data as a PNG file using pngjs.
 * @param {string} filePath
 * @param {Buffer} rgbaData  4 bytes per pixel.
 * @param {number} width
 * @param {number} height
 */
function writePng(filePath, rgbaData, width, height) {
  return new Promise((resolve, reject) => {
    const png  = new PNG({ width, height, filterType: -1 });
    png.data   = rgbaData;
    const chunks = [];
    png.pack()
      .on('data',  chunk => chunks.push(chunk))
      .on('end',   ()    => { fs.writeFileSync(filePath, Buffer.concat(chunks)); resolve(); })
      .on('error', reject);
  });
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
  // rawLuminance: pre-threshold [0,1] values used for normal-map generation.
  // These retain the gentle underwater slopes so the Sobel kernel never sees
  // the hard cliff edge that thresholding creates at every coastline.
  const rawLuminance    = new Float32Array(width * height);
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

    rawLuminance[i] = lum;

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

  // ── Optional normal map ───────────────────────────────────────────────────
  if (terrainConfig.generateNormalMap) {
    // Use rawLuminance (pre-threshold) rather than normalizedHeights so the
    // Sobel kernel sees gradual underwater slopes instead of a hard cliff edge
    // at every coastline.  The geometry is still built from normalizedHeights
    // (ocean = 0); the normal map just drives per-pixel lighting.
    const nmData = generateNormalMap(
      rawLuminance,
      width,
      height,
      terrainConfig.normalMapStrength,
    );
    const nmPath = path.join(terrainConfig.outputDir, 'normal_map.png');
    await writePng(nmPath, nmData, width, height);
    console.log(`Normal map: ${nmPath}`);
    console.log('  Convention: OpenGL tangent-space, flat = (127,127,255)');
    console.log(`  Strength:   ${terrainConfig.normalMapStrength}`);
    console.log('  To flip G (DirectX → OpenGL): set material.invertNormalMapY=true in Babylon.js');
  }

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
