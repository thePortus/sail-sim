module.exports = app => {
  const terrain = require('../controllers/terrain.controller');

  app.get('/terrain/manifest', terrain.getManifest);
  app.get('/terrain/chunk/:cz/:cx', terrain.getChunk);
  app.get('/terrain/normal-map', terrain.getNormalMap);
};
