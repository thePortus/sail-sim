'use strict';

// Town-Economy + Factions + Ships-as-economy + Crew per-player columns. These were previously only added by the
// runtime ensureColumns() backstop (models/index.js) and had no migration — so a freshly *migrated* DB was missing
// them, and any User query (Sequelize selects every model column) failed with "Unknown column 'crew'", cascading
// into 500s on register/login and a state-load failure that left players off-dock. This makes them part of the
// migration authority. IDEMPOTENT: skips any column the runtime backstop already added on this DB.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const DT = Sequelize.DataTypes;
    const table = await queryInterface.describeTable('users');
    const adds = [
      ['gold',         { type: DT.INTEGER,     allowNull: false, defaultValue: 500 }],   // backfills existing rows with a purse
      ['cargo',        { type: DT.TEXT,        allowNull: true,  defaultValue: null }],
      ['tradeLedger',  { type: DT.TEXT,        allowNull: true,  defaultValue: null }],
      ['combatState',  { type: DT.TEXT,        allowNull: true,  defaultValue: null }],
      ['marketLedger', { type: DT.TEXT,        allowNull: true,  defaultValue: null }],
      ['factionRep',   { type: DT.TEXT,        allowNull: true,  defaultValue: null }],
      ['ship',         { type: DT.STRING(64),  allowNull: false, defaultValue: 'pinnace' }],
      ['crew',         { type: DT.INTEGER,     allowNull: true,  defaultValue: null }],
    ];
    for (const [name, spec] of adds) {
      if (!table[name]) { await queryInterface.addColumn('users', name, spec); }
    }
  },

  down: async (queryInterface) => {
    for (const name of ['gold', 'cargo', 'tradeLedger', 'combatState', 'marketLedger', 'factionRep', 'ship', 'crew']) {
      try { await queryInterface.removeColumn('users', name); } catch { /* not present */ }
    }
  },
};
