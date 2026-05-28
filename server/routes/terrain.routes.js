module.exports = app => {
  const terrain = require('../controllers/terrain.controller');

  app.get('/terrain/manifest', terrain.getManifest);
  app.get('/terrain/chunk/:cz/:cx', terrain.getChunk);
  app.get('/terrain/normal-map',   terrain.getNormalMap);
  app.get('/terrain/specular-map', terrain.getSpecularMap);
  app.get('/terrain/ao-map',       terrain.getAOMap);
};
