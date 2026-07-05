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
db.DiplomacyState = require('./diplomacy-state.model')(sequelize, Sequelize.DataTypes);

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
    // Player's custom ship name (shown to others + a 3D stern nameboard). Default 'Saltmeadow' (the starter trader).
    ['shipName',     { type: Sequelize.DataTypes.STRING(64), allowNull: true,  defaultValue: 'Saltmeadow' }],
    // Shipwright per-hull upgrades (each buyable once; reset on a new ship): heavier cannons + +25% hull armor.
    ['cannonUpgrade', { type: Sequelize.DataTypes.BOOLEAN, allowNull: false, defaultValue: false }],
    ['armorUpgrade',  { type: Sequelize.DataTypes.BOOLEAN, allowNull: false, defaultValue: false }],
    // Custom flag colour (#rrggbb) — the player's chosen flag tint, shown to everyone. Persists across ships.
    ['flagColor',    { type: Sequelize.DataTypes.STRING(7), allowNull: true, defaultValue: '#b22222' }],
    // Crew resource: remaining sailors (NULL backfills as "full complement" on next load). Persists across
    // maps (the player's, not the world's). Grapeshot lowers it; a port tavern raises it back.
    ['crew',         { type: Sequelize.DataTypes.INTEGER, allowNull: true, defaultValue: null }],
    // Quest progress (intro tutorial + future storyline). NULL = new player → intro auto-starts on login.
    ['questState',   { type: Sequelize.DataTypes.TEXT,    allowNull: true,  defaultValue: null }],
    // Per-user CHAT profanity filter — masks profane words in received chat. Default TRUE (on); backfills
    // existing players as filtered. The player can opt out. (Name/callsign block is separate + always on.)
    ['profanityFilter', { type: Sequelize.DataTypes.BOOLEAN, allowNull: false, defaultValue: true }],
  ];
  for (const [name, spec] of adds) {
    try {
      await qi.addColumn('users', name, spec);
      console.log(`[db] added column users.${name}`);
    } catch (err) {
      // "already exists" is the normal idempotent case (swallow). Anything else (no ALTER grant, table missing,
      // type clash) would otherwise hide as an "Unknown column" at query time — so LOG it. Best-effort detection
      // across dialects via the message.
      const m = String(err && err.message || '');
      if (!/exist|duplicate/i.test(m)) { console.warn(`[db] ensureColumns: could not add users.${name}: ${m}`); }
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
  const mk = async (name, spec) => {
    try { await qi.createTable(name, spec); console.log(`[db] created table ${name}`); }
    catch (err) {
      // "already exists" is the normal idempotent case (swallow). Anything else (no CREATE grant, bad dialect)
      // would otherwise hide as a "Table doesn't exist" at query time — so LOG it.
      const m = String(err && err.message || '');
      if (!/exist/i.test(m)) { console.warn(`[db] ensureTables: could not create ${name}: ${m}`); }
    }
  };
  await mk('economyStates', {
    mapVersion:  { type: DT.INTEGER, primaryKey: true, allowNull: false },
    lastTickDay: { type: DT.INTEGER, allowNull: false, defaultValue: 0 },
    towns:       { type: DT.TEXT('medium'), allowNull: false },
  });
  await mk('diplomacyStates', {
    id:           { type: DT.INTEGER, primaryKey: true, allowNull: false, defaultValue: 1 },
    lastShiftDay: { type: DT.INTEGER, allowNull: false, defaultValue: 0 },
    rel:          { type: DT.TEXT, allowNull: false },
  });
};

module.exports = db;
