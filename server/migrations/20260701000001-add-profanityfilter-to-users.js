'use strict';

// Per-user CHAT profanity filter column: a BOOLEAN (default TRUE = on) letting a player mask profane words in
// the chat they receive, or opt out to see raw text. The hard block on profane usernames/callsigns/ship names is
// enforced in code (profanity.js) and is NOT this column. Added to the migration authority alongside the runtime
// ensureColumns() backstop (models/index.js), or a freshly *migrated* DB would 500 on every User query (Sequelize
// selects every model column). IDEMPOTENT.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const DT = Sequelize.DataTypes;
    const table = await queryInterface.describeTable('users');
    if (!table.profanityFilter) {
      await queryInterface.addColumn('users', 'profanityFilter', { type: DT.BOOLEAN, allowNull: false, defaultValue: true });
    }
  },

  down: async (queryInterface) => {
    try { await queryInterface.removeColumn('users', 'profanityFilter'); } catch { /* not present */ }
  },
};
