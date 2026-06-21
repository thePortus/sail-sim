'use strict';

// Player's custom SHIP NAME per-player column. STRING(64), default 'Saltmeadow' (the intro tutorial's starter
// trader). Shown to other players (label subtitle + a 3D nameboard on the stern); set when the tutorial ends,
// renamable at the shipwright, and named again on buying a new hull. Not unique. Added to the migration authority
// alongside the runtime ensureColumns() backstop (models/index.js), or a freshly *migrated* DB would 500 on every
// User query (Sequelize selects every model column). IDEMPOTENT: skips if already present.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const DT = Sequelize.DataTypes;
    const table = await queryInterface.describeTable('users');
    if (!table.shipName) {
      await queryInterface.addColumn('users', 'shipName', { type: DT.STRING(64), allowNull: true, defaultValue: 'Saltmeadow' });
    }
  },

  down: async (queryInterface) => {
    try { await queryInterface.removeColumn('users', 'shipName'); } catch { /* not present */ }
  },
};
