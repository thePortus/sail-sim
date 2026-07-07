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
const fs = require('fs');

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
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache');
    // Express/`mime` doesn't know `.ktx2` → it'd send a generic type. Babylon's KTX2 loader
    // still parses it, but send the correct content type for correctness/proxies. (NOTE: this
    // does NOT fix the `biome_*.ktx2` array-texture fallback — Babylon 9.10.1's KTX2 decoder
    // rejects 2D-array KTX2 outright ("Array textures are not currently supported"), so the
    // terrain correctly falls back to the uncompressed RawTexture2DArray.)
    if (filePath.endsWith('.ktx2')) res.setHeader('Content-Type', 'image/ktx2');
  },
}));
// Auto-updater feed + binaries (Sparkle on macOS, WinSparkle on Windows). The appcast XML must be revalidated
// on every update check (no-cache + ETag → 304 when unchanged), while the versioned build artifacts carry
// unique filenames so they can be cached hard. Populated by server/scripts/client-release.js.
app.use('/client', express.static(path.join(__dirname, 'assets/client'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.xml')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

// Native desktop-client download: stream the newest published build for a platform. Streaming (not a redirect
// to /client/…) keeps it working behind the reverse proxy, where only /api is routed to Node.
app.get('/download/:platform', (req, res) => {
  const platform = req.params.platform === 'win' ? 'win' : req.params.platform === 'mac' ? 'mac' : null;
  if (!platform) return res.status(404).send('Unknown platform.');
  const dir = path.join(__dirname, 'assets/client');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => new RegExp(`^SailSim-.*-${platform}\\.zip$`).test(f)); } catch {}
  if (!files.length) return res.status(404).send(`No ${platform} build has been published yet.`);
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));   // newest version last
  res.download(path.join(dir, files[files.length - 1]));
});

// set API routes
require('./routes/index')(app);

module.exports = app;