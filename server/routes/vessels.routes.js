module.exports = app => {
  const vessels = require('../controllers/vessels.controller');
  app.get('/vessels',         vessels.getVessels);
  app.get('/vessels/default', vessels.getDefaultVessel);
  app.get('/vessels/:slug',   vessels.getVesselBySlug);
};
