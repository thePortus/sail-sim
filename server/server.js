// call app core logic
const http = require('http');
const app  = require('./app.js');
const db   = require('./models');
const economy = require('./economy');
const diplomacy = require('./diplomacy');
const nav = require('./nav');
const { attachMultiplayer } = require('./multiplayer.js');

// start webserver
const PORT   = process.env.WEB_PORT || 8080;
const server = http.createServer(app);

// Boot: apply non-destructive schema top-ups (columns + the economy table) AND restore the town economy
// BEFORE serving traffic, so the first query/trade sees a ready DB + a hydrated market. Resilient — if the
// DB is unreachable the economy still seeds in memory from the manifest and trades work (flush retries).
async function boot() {
  try {
    // Create the users table from the model on a FRESH db (CREATE TABLE IF NOT EXISTS — no-op + never alters an
    // existing table), so the runtime backstop fully bootstraps even if the sequelize migrations weren't run.
    // ensureColumns() then tops up an OLDER table that predates the economy/ship/crew columns.
    await db.User.sync();
    await db.ensureColumns();
    await db.ensureTables();
    await economy.loadState();
    // Restore (or rivalry-seed) the inter-faction political map AFTER the economy so the contested-border
    // town data is available to bias initial wars toward genuine territorial rivals.
    await diplomacy.load(diplomacy.rivalWeightsFromTowns(economy.townList()));
    nav.loadNavGrid();   // navigable-water grid for NPC sea-routing (lazy-loads anyway; warm it at boot)
  } catch (err) {
    console.warn('[boot] schema/economy init issue (continuing):', err.message);
  }
  attachMultiplayer(server);
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}.`);
  });
}
boot();

// Persist the global town economy on a graceful stop (player purse/cargo already persist inline + on the 30 s loop).
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) { return; }
  shuttingDown = true;
  try { await economy.flushState(true); } catch { /* best-effort */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);