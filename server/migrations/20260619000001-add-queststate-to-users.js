'use strict';

// Quest progress per-player column (intro tutorial + future storyline quests). JSON TEXT:
// { [questId]: { stage, done:[objectiveId], status:'active'|'done' } }. NULL = brand-new player → the server
// auto-starts the intro tutorial on login. Added to the migration authority alongside the runtime ensureColumns()
// backstop (models/index.js), or a freshly *migrated* DB would 500 on every User query (Sequelize selects every
// model column — see the economy/ship/crew migration for the same gotcha). IDEMPOTENT: skips if already present.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const DT = Sequelize.DataTypes;
    const table = await queryInterface.describeTable('users');
    if (!table.questState) {
      await queryInterface.addColumn('users', 'questState', { type: DT.TEXT, allowNull: true, defaultValue: null });
    }
  },

  down: async (queryInterface) => {
    try { await queryInterface.removeColumn('users', 'questState'); } catch { /* not present */ }
  },
};
