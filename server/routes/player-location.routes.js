'use strict';

const auth                            = require('../middleware/auth');
const { getLocation, saveLocation }  = require('../controllers/player-location.controller');

module.exports = app => {
  // Both endpoints require a valid JWT — the Angular HTTP interceptor attaches
  // the Bearer token automatically, so no client-side changes are needed.
  app.get('/player-location/:callsign', auth.verifyToken, getLocation);
  app.put('/player-location/:callsign', auth.verifyToken, saveLocation);
};
