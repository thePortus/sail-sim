'use strict';

const auth                     = require('../middleware/auth');
const { getLocation, getShip } = require('../controllers/player-location.controller');

module.exports = app => {
  // GET requires a valid JWT — the Angular HTTP interceptor attaches the Bearer token automatically.
  // There is NO write endpoint anymore: the authoritative position is persisted SERVER-side from the
  // validated movement stream (multiplayer.js savePlayerLocation), so a client can't write a fake one.
  app.get('/player-location/:callsign', auth.verifyToken, getLocation);
  // The player's OWNED vessel — map-INDEPENDENT (unlike location), so the client can build the right hull
  // before connecting even on a freshly-baked map. Keyed by the JWT's user id, not a spoofable param.
  app.get('/player-ship', auth.verifyToken, getShip);
};
