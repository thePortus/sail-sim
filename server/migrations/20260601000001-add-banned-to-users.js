'use strict';

/** Adds a `banned` boolean to the users table.
 *  When true, login is refused. Toggled by Owner/Admin via the /ban and /unban
 *  chat commands (or PUT /user/ban/:callsign). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'banned', {
      type:         Sequelize.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'banned');
  },
};
