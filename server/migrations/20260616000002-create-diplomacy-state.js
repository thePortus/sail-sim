'use strict';

// Diplomacy — singleton inter-faction political map (one row, id=1): `rel` is a JSON blob of pair→state
// (war/peace/alliance), `lastShiftDay` gates the rare relation shifts. Previously created only by the runtime
// ensureTables() backstop with no migration; this adds it to the migration authority. IDEMPOTENT — skips if the
// runtime backstop already created the table on this DB.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const DT = Sequelize.DataTypes;
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (tables.includes('diplomacystates')) { return; }
    await queryInterface.createTable('diplomacyStates', {
      id:           { type: DT.INTEGER, primaryKey: true, allowNull: false, defaultValue: 1 },
      lastShiftDay: { type: DT.INTEGER, allowNull: false, defaultValue: 0 },
      rel:          { type: DT.TEXT,    allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('diplomacyStates');
  },
};
