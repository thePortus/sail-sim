'use strict';

// Shipwright per-hull UPGRADE columns: cannonUpgrade (heavier guns → more damage) + armorUpgrade (+25% hull HP).
// Each buyable once at the shipwright; reset to false when a new ship is bought (they're per-hull). BOOLEAN,
// default false. Added to the migration authority alongside the runtime ensureColumns() backstop (models/index.js),
// or a freshly *migrated* DB would 500 on every User query (Sequelize selects every model column). IDEMPOTENT.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const DT = Sequelize.DataTypes;
    const table = await queryInterface.describeTable('users');
    if (!table.cannonUpgrade) {
      await queryInterface.addColumn('users', 'cannonUpgrade', { type: DT.BOOLEAN, allowNull: false, defaultValue: false });
    }
    if (!table.armorUpgrade) {
      await queryInterface.addColumn('users', 'armorUpgrade', { type: DT.BOOLEAN, allowNull: false, defaultValue: false });
    }
  },

  down: async (queryInterface) => {
    try { await queryInterface.removeColumn('users', 'cannonUpgrade'); } catch { /* not present */ }
    try { await queryInterface.removeColumn('users', 'armorUpgrade'); } catch { /* not present */ }
  },
};
