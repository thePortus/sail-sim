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

/**
 * Deterministic pseudo-random value in [0, 1) from two floats.
 * Same formula used on the client so biome textures stay consistent.
 */
function hashNoise(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
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
 * Separable box-blur on a Float32Array heightfield.
 * O(width × height) — fast enough for large maps.
 *
 * @param {Float32Array} input
 * @param {number} width
 * @param {number} height
 * @param {number} radius  Blur radius in pixels.
 * @returns {Float32Array}
 */
function separableBoxBlur(input, width, height, radius) {
  const r = Math.max(1, Math.floor(radius));
  const count = 2 * r + 1;
  const temp = new Float32Array(width * height);
  const out  = new Float32Array(width * height);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let kx = -r; kx <= r; kx++) {
      sum += input[y * width + Math.max(0, Math.min(width - 1, kx))];
    }
    for (let x = 0; x < width; x++) {
      temp[y * width + x] = sum / count;
      sum += input[y * width + Math.min(width - 1, x + r + 1)]
           - input[y * width + Math.max(0,          x - r    )];
    }
  }

  // Vertical pass
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let kz = -r; kz <= r; kz++) {
      sum += temp[Math.max(0, Math.min(height - 1, kz)) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / count;
      sum += temp[Math.min(height - 1, y + r + 1) * width + x]
           - temp[Math.max(0,           y - r    ) * width + x];
    }
  }

  return out;
}

/**
 * Generates a greyscale specular map from the normalised (post-threshold)
 * heightfield.  The R channel encodes specular intensity: rock faces and steep
 * slopes shine; sand and grass are near-matte.
 *
 * @param {Float32Array} heights  Post-threshold normalised [0,1].
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} RGBA pixel data.
 */
function generateSpecularMap(heights, width, height) {
  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const h = sampleHeightAt(heights, width, height, x, y);

      // Compute slope via Sobel (same kernel as normal map generator)
      const tl = sampleHeightAt(heights, width, height, x - 1, y - 1);
      const tm = sampleHeightAt(heights, width, height, x,     y - 1);
      const tr = sampleHeightAt(heights, width, height, x + 1, y - 1);
      const ml = sampleHeightAt(heights, width, height, x - 1, y    );
      const mr = sampleHeightAt(heights, width, height, x + 1, y    );
      const bl = sampleHeightAt(heights, width, height, x - 1, y + 1);
      const bm = sampleHeightAt(heights, width, height, x,     y + 1);
      const br = sampleHeightAt(heights, width, height, x + 1, y + 1);
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bm + br) - (tl + 2 * tm + tr);
      const slope = clamp01(Math.sqrt(gx * gx + gy * gy) * 5.0);

      let spec;
      if (h <= 0) {
        // Ocean floor — specular irrelevant (underwater), keep very low.
        spec = 0.04;
      } else if (h < 0.05) {
        // Beach / sand — slightly moist sheen, low spec.
        spec = clamp01(0.08 + slope * 0.12);
      } else if (h < 0.30) {
        // Grass & vegetation — almost matte; slopes expose rock → shinier.
        spec = clamp01(0.04 + slope * 0.35);
      } else if (h < 0.65) {
        // Mid-elevation — rock increasingly dominates slopes.
        spec = clamp01(0.08 + slope * 0.55);
      } else {
        // High alpine / snow — snow is matte, exposed peak rock is shiny.
        spec = clamp01(0.12 + slope * 0.45 - (h - 0.65) * 0.10);
      }

      const v = Math.round(clamp01(spec) * 255);
      const idx = (y * width + x) * 4;
      out[idx]     = v;
      out[idx + 1] = v;
      out[idx + 2] = v;
      out[idx + 3] = 255;
    }
  }

  return out;
}

/**
 * Generates a greyscale ambient-occlusion map using a depression-detection
 * technique: pixels that sit below their blurred surroundings are occluded.
 *
 * Uses a separable box-blur so it runs in O(width × height) regardless of
 * radius — no performance penalty for large blur windows.
 *
 * @param {Float32Array} rawHeights   Pre-threshold raw luminance [0,1].  Used
 *                                    for the blur so coast transitions are
 *                                    gradual (no hard cliff at the waterline).
 * @param {Float32Array} landHeights  Post-threshold normalised heights [0,1].
 *                                    Used only to identify ocean pixels
 *                                    (landHeights[i] === 0 → ocean).  Ocean
 *                                    pixels always output white (ao = 1) so
 *                                    any UV bleeding near the waterline never
 *                                    darkens visible coastal terrain.
 * @param {number} width
 * @param {number} height
 * @param {number} radius   Blur radius in heightfield pixels.
 * @param {number} strength Darkening multiplier.  Higher = deeper shadows.
 * @returns {Buffer} RGBA pixel data (white = fully lit, dark = occluded).
 */
function generateAOMap(rawHeights, landHeights, width, height, radius, strength) {
  const blurred = separableBoxBlur(rawHeights, width, height, radius);
  const out = Buffer.alloc(width * height * 4);

  // Minimum AO value for land pixels — prevents completely-black terrain even
  // in deep valleys.  0.45 means the darkest possible surface still receives
  // 45 % of its unoccluded brightness, which renders as clearly visible shadow
  // rather than black.  (The old 0.30 floor was too aggressive given the
  // multiplicative shadow-map application.)
  const AO_MIN = 0.45;

  for (let i = 0; i < width * height; i++) {
    let ao;
    if (landHeights[i] <= 0) {
      // Ocean pixel — the terrain mesh is pushed below the water plane here,
      // so this texel is never visible.  Force white so UV interpolation near
      // the coastline never leaks dark AO values onto visible shore land.
      ao = 1.0;
    } else {
      // Depression depth: how far below its blurred neighbourhood the pixel sits.
      const depression = Math.max(0, blurred[i] - rawHeights[i]);
      ao = Math.max(AO_MIN, clamp01(1.0 - depression * strength));
    }
    const v  = Math.round(ao * 255);
    const idx = i * 4;
    out[idx]     = v;
    out[idx + 1] = v;
    out[idx + 2] = v;
    out[idx + 3] = 255;
  }

  return out;
}

/**
 * Generates an OpenGL tangent-space normal map from a normalised [0,1]
 * heightfield using a 3×3 Sobel kernel, then blends in biome-appropriate
 * micro-detail normals so that close-up terrain looks textured:
 *   • sand / beach: barely any bump
 *   • grass / soil: gentle undulation
 *   • gravel / rock / steep slopes: strong angular crevice detail
 *   • snow cap: subtle
 *
 * Convention (same as Blender, Godot, Babylon.js WebGL path):
 *   R = tangent X  (right in image  = world +X)
 *   G = tangent Y  (down  in image  = world -Z before Babylon's invertY flip)
 *   B = surface-normal magnitude
 *   Flat surface → approximately (127, 127, 255)
 *
 * @param {Float32Array} heights        Normalised elevation values [0,1]
 *                                      (raw pre-threshold luminance for the
 *                                      normal map so the Sobel sees smooth
 *                                      coast gradients, not a hard cliff edge).
 * @param {number}       width
 * @param {number}       height
 * @param {number}       strength        Gradient scale for large-scale terrain shape.
 * @param {number}       waterThreshold  Raw-luminance value below which pixels
 *                                       are ocean.  Used to gate detail normals.
 * @returns {Buffer} RGBA pixel data (4 bytes per pixel, width × height pixels).
 */
function generateNormalMap(heights, width, height, strength, waterThreshold) {
  const s  = Math.max(0.1, strength || 5.0);
  const wt = typeof waterThreshold === 'number' ? waterThreshold : 0.33;
  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // ── Large-scale terrain shape via 3×3 Sobel ────────────────────────────
      const tl = sampleHeightAt(heights, width, height, x - 1, y - 1);
      const tm = sampleHeightAt(heights, width, height, x,     y - 1);
      const tr = sampleHeightAt(heights, width, height, x + 1, y - 1);
      const ml = sampleHeightAt(heights, width, height, x - 1, y    );
      const mr = sampleHeightAt(heights, width, height, x + 1, y    );
      const bl = sampleHeightAt(heights, width, height, x - 1, y + 1);
      const bm = sampleHeightAt(heights, width, height, x,     y + 1);
      const br = sampleHeightAt(heights, width, height, x + 1, y + 1);

      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);  // horizontal gradient
      const gy = (bl + 2 * bm + br) - (tl + 2 * tm + tr);  // vertical gradient

      let nx = -gx * s;
      let ny = -gy * s;
      const nz = 1.0;

      // ── Biome micro-detail normals ─────────────────────────────────────────
      // rawH is pre-threshold luminance; convert to normalised land height.
      const rawH = sampleHeightAt(heights, width, height, x, y);
      const nh   = Math.max(0, (rawH - wt) / Math.max(1e-6, 1 - wt));

      if (nh > 0) {
        // Slope magnitude from Sobel (not scaled by s — just for biome gating).
        const slope = Math.sqrt(gx * gx + gy * gy);

        // Detail strength varies by biome: rock/steep = strong angular bumps,
        // grass = gentle, sand/snow = near-flat.
        let detailStr;
        if      (nh < 0.05) detailStr = 0.05;                        // beach / sand
        else if (nh < 0.30) detailStr = 0.08 + slope * 0.06;         // grass / soil
        else if (nh < 0.65) detailStr = 0.30 + slope * 0.45;         // gravel / rock (raised from 0.22+0.32)
        else                detailStr = 0.06;                          // snow cap

        // Five fBm octaves — biome-aware blend emphasises fine detail for rock,
        // coarser octaves for grass, minimal for sand/snow.  UV coords keep
        // frequencies world-relative regardless of source image resolution.
        const u = x / (width  - 1);
        const v = y / (height - 1);

        // Octave 1 ~220 m world period (coarse rock facet planes)
        const d1x = hashNoise(u * 220  + 11.3, v * 220  +  7.7) * 2 - 1;
        const d1y = hashNoise(u * 220  + 99.7, v * 220  + 43.1) * 2 - 1;
        // Octave 2 ~95 m period (finer crevices / grass blades)
        const d2x = hashNoise(u * 510  + 33.3, v * 510  + 71.9) * 2 - 1;
        const d2y = hashNoise(u * 510  + 17.1, v * 510  + 88.3) * 2 - 1;
        // Octave 3 ~40 m period (rock crumble)
        const d3x = hashNoise(u * 1200 + 57.7, v * 1200 + 23.4) * 2 - 1;
        const d3y = hashNoise(u * 1200 +  4.9, v * 1200 + 61.8) * 2 - 1;
        // Octave 4 ~18 m period (fine rock grain)
        const d4x = hashNoise(u * 2700 + 81.3, v * 2700 + 44.2) * 2 - 1;
        const d4y = hashNoise(u * 2700 + 22.9, v * 2700 + 93.6) * 2 - 1;
        // Octave 5 ~8 m period (pebble-scale grit — rock only)
        const d5x = hashNoise(u * 6100 + 13.7, v * 6100 + 67.1) * 2 - 1;
        const d5y = hashNoise(u * 6100 + 55.4, v * 6100 +  8.9) * 2 - 1;

        // Biome-dependent blend weights.
        let blendX, blendY;
        if (nh < 0.05) {
          // Beach / sand — barely any bump, coarse-only
          blendX = d1x * 0.70 + d2x * 0.30;
          blendY = d1y * 0.70 + d2y * 0.30;
        } else if (nh < 0.30) {
          // Grass / soil — gentle undulation, no grit
          blendX = d1x * 0.55 + d2x * 0.30 + d3x * 0.15;
          blendY = d1y * 0.55 + d2y * 0.30 + d3y * 0.15;
        } else if (nh < 0.65) {
          // Gravel / rock — fine octaves 4+5 heavily weighted
          blendX = d1x * 0.15 + d2x * 0.20 + d3x * 0.25 + d4x * 0.25 + d5x * 0.15;
          blendY = d1y * 0.15 + d2y * 0.20 + d3y * 0.25 + d4y * 0.25 + d5y * 0.15;
        } else {
          // Snow cap — coarse and medium only
          blendX = d1x * 0.60 + d2x * 0.40;
          blendY = d1y * 0.60 + d2y * 0.40;
        }

        const detX = blendX * detailStr;
        const detY = blendY * detailStr;

        // Partial-derivative blending: add detail XY on top of terrain XY,
        // keeping Z = 1 before final normalisation.  Preserves the terrain's
        // overall slope direction while perturbing the per-pixel normal.
        nx += detX;
        ny += detY;
      }

      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const idx = (y * width + x) * 4;
      out[idx]     = Math.round(((nx / len) * 0.5 + 0.5) * 255); // R = X
      out[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255); // G = Y
      out[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255); // B = Z
      out[idx + 3] = 255;
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
      terrainConfig.waterThreshold,   // needed to distinguish land biome for detail normals
    );
    const nmPath = path.join(terrainConfig.outputDir, 'normal_map.png');
    await writePng(nmPath, nmData, width, height);
    console.log(`Normal map: ${nmPath}`);
    console.log('  Convention: OpenGL tangent-space, flat = (127,127,255)');
    console.log(`  Strength:   ${terrainConfig.normalMapStrength}`);
    console.log('  To flip G (DirectX → OpenGL): set material.invertNormalMapY=true in Babylon.js');
  }

  // ── Optional specular map ─────────────────────────────────────────────────
  if (terrainConfig.generateSpecularMap) {
    const specData = generateSpecularMap(normalizedHeights, width, height);
    const specPath = path.join(terrainConfig.outputDir, 'specular_map.png');
    await writePng(specPath, specData, width, height);
    console.log(`Specular map: ${specPath}`);
    console.log('  R=specular intensity: rock/steep slopes bright, grass/sand dark');
  }

  // ── Optional ambient-occlusion map ────────────────────────────────────────
  if (terrainConfig.generateAOMap) {
    // rawLuminance drives the blur (gradual coast transitions, no hard cliff).
    // normalizedHeights identifies ocean pixels → those get ao = 1 (white) so
    // UV interpolation near the waterline never leaks AO darkening onto shore.
    const aoData = generateAOMap(
      rawLuminance,
      normalizedHeights,
      width,
      height,
      terrainConfig.aoRadius,
      terrainConfig.aoStrength,
    );
    const aoPath = path.join(terrainConfig.outputDir, 'ao_map.png');
    await writePng(aoPath, aoData, width, height);
    console.log(`AO map: ${aoPath}`);
    console.log(`  Radius: ${terrainConfig.aoRadius} px  Strength: ${terrainConfig.aoStrength}`);
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
