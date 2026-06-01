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
// Vessel GLBs change rarely; let browsers cache them across sessions (ETag still
// revalidates on change). The client also instantiates each GLB once in-memory
// per session (VesselAssetCacheService), so this mainly speeds cold loads.
app.use('/geometry', express.static(path.join(__dirname, 'assets/geometry'), {
  maxAge: '1d',
  etag: true,
}));
// set API routes
require('./routes/index')(app);

module.exports = app;