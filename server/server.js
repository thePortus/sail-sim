// call app core logic
const http = require('http');
const app  = require('./app.js');
const db   = require('./models');
const { attachMultiplayer } = require('./multiplayer.js');

// start webserver
const PORT   = process.env.WEB_PORT || 8080;
const server = http.createServer(app);

// Apply any non-destructive schema additions (e.g. users.lastMapVersion) before traffic — fire and
// forget; the first authoritative location save is 30 s out, so this completes well in time.
db.ensureColumns().catch((err) => console.warn('[db] ensureColumns failed:', err.message));

attachMultiplayer(server);

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});