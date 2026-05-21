'use strict';

/**
 * Adds last-known sailing position to the users table.
 *
 * Columns are all nullable so existing rows are unaffected; the game simply
 * treats NULL as "no saved location" and spawns the player at the island default.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'lastX',          { type: Sequelize.DOUBLE,       allowNull: true, defaultValue: null });
    await queryInterface.addColumn('users', 'lastZ',          { type: Sequelize.DOUBLE,       allowNull: true, defaultValue: null });
    await queryInterface.addColumn('users', 'lastHeading',    { type: Sequelize.FLOAT,        allowNull: true, defaultValue: null });
    await queryInterface.addColumn('users', 'lastVesselSlug', { type: Sequelize.STRING(64),   allowNull: true, defaultValue: null });
    await queryInterface.addColumn('users', 'lastCallsign',   { type: Sequelize.STRING(16),   allowNull: true, defaultValue: null });
    await queryInterface.addColumn('users', 'locationSavedAt',{ type: Sequelize.DATE,         allowNull: true, defaultValue: null });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'lastX');
    await queryInterface.removeColumn('users', 'lastZ');
    await queryInterface.removeColumn('users', 'lastHeading');
    await queryInterface.removeColumn('users', 'lastVesselSlug');
    await queryInterface.removeColumn('users', 'lastCallsign');
    await queryInterface.removeColumn('users', 'locationSavedAt');
  },
};
