'use strict';

/**
 * Adds `lastMapVersion` to the users table — the MAP_VERSION the player's saved
 * location was recorded under. On login the server discards a saved position whose
 * map version differs from the current MAP_VERSION (re-baked terrain), spawning the
 * player fresh at a harbor instead.
 *
 * This column was originally only created by the fire-and-forget db.ensureColumns()
 * runtime top-up (models/index.js), which has no migration record and silently
 * swallows DB-race failures — so on a fresh/raced deploy the column could be missing,
 * making every login/register query `SELECT ... lastMapVersion` 500 with
 * "Unknown column 'lastMapVersion' in 'field list'". This migration makes it
 * authoritative via `migrate.sh` (sequelize db:migrate).
 *
 * Guarded so it's a no-op if ensureColumns already created the column on this DB
 * (otherwise addColumn would throw a duplicate-column error and abort the migration).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable('users');
    if (table.lastMapVersion) return;
    await queryInterface.addColumn('users', 'lastMapVersion', {
      type:         Sequelize.INTEGER,
      allowNull:    true,
      defaultValue: null,
    });
  },

  down: async (queryInterface) => {
    const table = await queryInterface.describeTable('users');
    if (!table.lastMapVersion) return;
    await queryInterface.removeColumn('users', 'lastMapVersion');
  },
};
