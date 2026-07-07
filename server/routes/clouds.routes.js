module.exports = app => {
  const clouds = require('../controllers/clouds.controller');

  // 3-D cloud noise volume — downloaded via:
  //   npm run download:cloud-noise
  // :name must be 'greyNoise3D.bin'.
  app.get('/clouds/:name', clouds.getCloudAsset);
};
