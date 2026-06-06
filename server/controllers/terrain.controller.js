'use strict';

const fs = require('fs');
const path = require('path');
const terrainConfig = require('../config/terrain.config');

const manifestPath = path.join(terrainConfig.outputDir, 'manifest.json');

function loadManifest() {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const content = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(content);
}

exports.getManifest = (req, res) => {
  const manifest = loadManifest();
  if (!manifest) {
    return res.status(404).json({
      message: 'Terrain manifest not found. Run: npm run build:terrain',
    });
  }

  res.json(manifest);
};

function serveTerrainPng(filename, label) {
  return (req, res) => {
    const filePath = path.join(terrainConfig.outputDir, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        message: `${label} not found. Run: npm run build:terrain`,
      });
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
  };
}

exports.getNormalMap   = serveTerrainPng('normal_map.png',   'Normal map');
exports.getSpecularMap = serveTerrainPng('specular_map.png', 'Specular map');
exports.getAOMap       = serveTerrainPng('ao_map.png',       'AO map');
exports.getSplatMap    = serveTerrainPng('splat_map.png',    'Splat/control map');   // S2 terrain skinning

/**
 * Serve a tiling terrain tile texture (JPG).
 * Files live in assets/terrain/tiles/ and are downloaded via:
 *   npm run download:terrain-tiles
 *
 * :name must be one of:
 *   sand_diff, sand_nor, grass_diff, grass_nor,
 *   gravel_diff, gravel_nor, rock_diff, rock_nor,
 *   snow_diff, snow_nor
 */
const VALID_TILES = new Set([
  'sand_diff',    'sand_nor',
  'sand2_diff',   'sand2_nor',
  'grass_diff',   'grass_nor',
  'grass2_diff',  'grass2_nor',
  'gravel_diff',  'gravel_nor',
  'rock_diff',    'rock_nor',
  'rock2_diff',   'rock2_nor',
  'snow_diff',    'snow_nor',
]);

exports.getTile = (req, res) => {
  const name = req.params.name;
  if (!VALID_TILES.has(name)) {
    return res.status(400).json({ message: `Unknown tile name '${name}'.` });
  }
  const filePath = path.join(terrainConfig.outputDir, 'tiles', `${name}.jpg`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      message: `Tile '${name}' not found. Run: npm run download:terrain-tiles`,
    });
  }
  res.setHeader('Content-Type', 'image/jpeg');
  // Tile textures are stable — cache aggressively in the browser
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  return res.sendFile(filePath);
};

exports.getChunk = (req, res) => {
  const manifest = loadManifest();
  if (!manifest) {
    return res.status(404).json({
      message: 'Terrain manifest not found. Run: npm run build:terrain',
    });
  }

  const cz = Number.parseInt(req.params.cz, 10);
  const cx = Number.parseInt(req.params.cx, 10);
  if (Number.isNaN(cz) || Number.isNaN(cx) || cz < 0 || cx < 0) {
    return res.status(400).json({ message: 'Invalid chunk coordinates' });
  }

  if (cz >= manifest.chunkCountZ || cx >= manifest.chunkCountX) {
    return res.status(404).json({ message: 'Chunk out of range' });
  }

  const chunkPath = path.join(terrainConfig.outputDir, `chunk_${cz}_${cx}.bin`);
  if (!fs.existsSync(chunkPath)) {
    return res.status(404).json({ message: 'Chunk file not found' });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.sendFile(chunkPath);
};
