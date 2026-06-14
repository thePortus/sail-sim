const Sequelize = require('sequelize');
const config    = require('../config/db.config');

const sequelize = new Sequelize(config.DB, config.USER, config.PASSWORD, {
  host:    config.HOST,
  port:    config.port,
  dialect: config.dialect,
  pool:    config.pool,
  logging: false,
});

const db = {};
db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.User = require('./user.model')(sequelize, Sequelize.DataTypes);
db.EconomyState = require('./economy-state.model')(sequelize, Sequelize.DataTypes);

/**
 * Self-applying, NON-destructive schema top-up. This project has no sequelize.sync(), so new columns
 * must be added explicitly. addColumn is idempotent here (we swallow the "already exists" error), so
 * it's safe to run on every boot and needs no separate migration step. Add future columns to `adds`.
 */
db.ensureColumns = async () => {
  const qi = sequelize.getQueryInterface();
  const adds = [
    ['lastMapVersion', { type: Sequelize.DataTypes.INTEGER, allowNull: true, defaultValue: null }],
    // Town Economy: gold defaults to 500 so the addColumn backfills existing players with a starting purse.
    ['gold',        { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 500 }],
    ['cargo',       { type: Sequelize.DataTypes.TEXT,    allowNull: true,  defaultValue: null }],
    ['tradeLedger', { type: Sequelize.DataTypes.TEXT,    allowNull: true,  defaultValue: null }],
    ['combatState', { type: Sequelize.DataTypes.TEXT,    allowNull: true,  defaultValue: null }],
    // Phase 3 discovery ledger: JSON { mapVersion, towns:{ [townId]:{specialty,day,goods:[{id,ask,bid}]} } }.
    ['marketLedger', { type: Sequelize.DataTypes.TEXT,   allowNull: true,  defaultValue: null }],
    // Factions: JSON { [factionId]: standing } reputation (neutral 0 start). Persists across maps (it's the
    // player's, not the world's). Scaffold only — no gameplay effects yet (the events module wires those in).
    ['factionRep',   { type: Sequelize.DataTypes.TEXT,   allowNull: true,  defaultValue: null }],
    // Ships-as-economy: the player's OWNED vessel slug. Persists across maps (it's the player's, NOT the
    // world's — unlike lastVesselSlug which rides the map-gated position save). Everyone (incl. existing
    // players, via the backfill) starts in the 'pinnace' — ships are now bought at a shipwright for gold.
    ['ship',         { type: Sequelize.DataTypes.STRING(64), allowNull: false, defaultValue: 'pinnace' }],
    // Crew resource: remaining sailors (NULL backfills as "full complement" on next load). Persists across
    // maps (the player's, not the world's). Grapeshot lowers it; a port tavern raises it back.
    ['crew',         { type: Sequelize.DataTypes.INTEGER, allowNull: true, defaultValue: null }],
  ];
  for (const [name, spec] of adds) {
    try {
      await qi.addColumn('users', name, spec);
      console.log(`[db] added column users.${name}`);
    } catch {
      /* already exists (or DB unreachable) — a genuinely missing column surfaces at query time */
    }
  }
};

/**
 * Idempotent table top-up (dev/runtime backstop; the migration in server/migrations is the prod authority).
 * Mirrors ensureColumns — createTable swallows "already exists". AWAIT this before serving traffic so a fresh
 * DB has the table before the first economy query (economy.loadState also tolerates a missing table).
 */
db.ensureTables = async () => {
  const qi = sequelize.getQueryInterface();
  const DT = Sequelize.DataTypes;
  try {
    await qi.createTable('economyStates', {
      mapVersion:  { type: DT.INTEGER, primaryKey: true, allowNull: false },
      lastTickDay: { type: DT.INTEGER, allowNull: false, defaultValue: 0 },
      towns:       { type: DT.TEXT('medium'), allowNull: false },
    });
    console.log('[db] created table economyStates');
  } catch {
    /* already exists (or DB unreachable) */
  }
};

module.exports = db;
