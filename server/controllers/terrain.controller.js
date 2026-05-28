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

exports.getNormalMap = (req, res) => {
  const nmPath = path.join(terrainConfig.outputDir, 'normal_map.png');
  if (!fs.existsSync(nmPath)) {
    return res.status(404).json({
      message: 'Normal map not found. Run: npm run build:terrain',
    });
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(nmPath);
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
