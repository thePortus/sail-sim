'use strict';

/** Adds a `friends` column to the users table.
 *  Stored as a JSON array of callsign strings (TEXT, nullable).
 *  Mutual friendship requires BOTH players to have each other in their list. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'friends', {
      type:         Sequelize.TEXT,
      allowNull:    true,
      defaultValue: null,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'friends');
  },
};
