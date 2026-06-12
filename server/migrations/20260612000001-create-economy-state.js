'use strict';

// Town Economy — Phase 2. Singleton global town-economy state, one row per MAP_VERSION. `towns` is a JSON blob
// { [townId]: { stock: { goodId: qty }, treasury } }; MEDIUMTEXT since ~50 towns × ~10 goods can exceed 64 KB.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('economyStates', {
      mapVersion:  { type: Sequelize.INTEGER, primaryKey: true, allowNull: false },
      lastTickDay: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      towns:       { type: Sequelize.TEXT('medium'), allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('economyStates');
  },
};
