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

module.exports = db;
