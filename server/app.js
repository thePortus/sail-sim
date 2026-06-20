/**
 * @file Main app script. Sets favicon and cors. Allows JSON content.
 * Sets the '/' route to serve static welcome page, and all other routes
 * to be defined by the `routes/` directory. Starts listening on
 * specifiedi port.
 * @author David J. Thomas
 */

const express = require('express');
const cors = require('cors');
const favicon = require('serve-favicon');
const path = require('path');

const app = express();

// Behind a reverse proxy in production (it sets X-Forwarded-For). Trust the first hop so express-rate-limit
// can identify clients by their real IP — without this it throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR (which
// was crashing requests / dropping connections live). `1` = trust exactly one proxy (don't use `true`, which
// would let clients spoof the header to dodge rate limits). Bump if more proxy hops are added.
app.set('trust proxy', 1);

// favicon location
app.use(favicon(path.join(__dirname, 'favicon.ico')));

app.use(cors({
  origin: '*'
}));
// parse requests of content-type - application/json
app.use(express.json());
// parse requests of content-type - application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));

app.use('/', express.static(path.join(__dirname, 'pages')))
app.use('/api', express.static(path.join(__dirname, 'pages')));
// Vessel GLBs share a fixed filename but their CONTENTS change when re-exported, so we
// must not let the browser serve a stale copy. `Cache-Control: no-cache` tells the browser
// to REVALIDATE on every load (conditional request); with ETag the server answers 304 when
// the file is unchanged (tiny), and re-sends only when it actually changed. This avoids the
// old `max-age: 1d` trap where the browser served a day-old GLB without ever asking.
// The client still parses each GLB once in-memory per session (VesselAssetCacheService).
app.use('/geometry', express.static(path.join(__dirname, 'assets/geometry'), {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
// set API routes
require('./routes/index')(app);

module.exports = app;