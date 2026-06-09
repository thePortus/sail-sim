module.exports = app => {
  const sky = require('../controllers/sky.controller');

  // Equirectangular sky textures (NASA public domain) — downloaded via:
  //   npm run download:sky-textures
  // :name must be 'moon' or 'stars'.
  app.get('/sky/:name', sky.getSkyTexture);
};
