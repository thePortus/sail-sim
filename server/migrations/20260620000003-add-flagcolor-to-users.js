'use strict';

// Custom FLAG COLOUR per-player column: a #rrggbb hex (default '#b22222', a deep ensign red) the player picks at
// the shipwright; broadcast so everyone sees their flags in that colour. The player's identity → persists across
// ship changes. Added to the migration authority alongside the runtime ensureColumns() backstop (models/index.js),
// or a freshly *migrated* DB would 500 on every User query (Sequelize selects every model column). IDEMPOTENT.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const DT = Sequelize.DataTypes;
    const table = await queryInterface.describeTable('users');
    if (!table.flagColor) {
      await queryInterface.addColumn('users', 'flagColor', { type: DT.STRING(7), allowNull: true, defaultValue: '#b22222' });
    }
  },

  down: async (queryInterface) => {
    try { await queryInterface.removeColumn('users', 'flagColor'); } catch { /* not present */ }
  },
};
