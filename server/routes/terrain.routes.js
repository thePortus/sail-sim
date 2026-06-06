module.exports = app => {
  const terrain = require('../controllers/terrain.controller');

  app.get('/terrain/manifest', terrain.getManifest);
  app.get('/terrain/chunk/:cz/:cx', terrain.getChunk);
  app.get('/terrain/normal-map',   terrain.getNormalMap);
  app.get('/terrain/specular-map', terrain.getSpecularMap);
  app.get('/terrain/ao-map',       terrain.getAOMap);
  app.get('/terrain/splat-map',    terrain.getSplatMap);   // S2 control/splat map

  // Tiling material textures — downloaded via: npm run download:terrain-tiles
  // Name pattern: <biome>_diff or <biome>_nor  (e.g. rock_diff, rock_nor)
  app.get('/terrain/tile/:name', terrain.getTile);
};
