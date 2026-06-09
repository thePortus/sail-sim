'use strict';

const auth            = require('../middleware/auth');
const { getLocation } = require('../controllers/player-location.controller');

module.exports = app => {
  // GET requires a valid JWT — the Angular HTTP interceptor attaches the Bearer token automatically.
  // There is NO write endpoint anymore: the authoritative position is persisted SERVER-side from the
  // validated movement stream (multiplayer.js savePlayerLocation), so a client can't write a fake one.
  app.get('/player-location/:callsign', auth.verifyToken, getLocation);
};
