/**
 * @file Re-imports user accounts from a backup JSON file produced by the Owner's
 *       in-game `/export` command (GET /user/export). This lets you restore all
 *       registered accounts after a server wipe.
 *
 * Usage:
 *   1. As the Owner, run `/export` in chat to download `sail-sim-users.json`.
 *   2. Place that file at server/seeders/import/users .json (or set the
 *      USERS_IMPORT_FILE env var to its path).
 *   3. Run the seeders (npm run migrate, or `npx sequelize-cli db:seed:all`).
 *
 * Behaviour:
 *   - Passwords are imported as-is (the export stores the existing MD5 hashes).
 *   - Existing usernames are SKIPPED (so this never overwrites live accounts or the
 *     owner seeded earlier); only missing accounts are inserted. Safe to re-run.
 *   - If the file is absent, the seeder is a no-op (normal for a fresh install).
 */

const fs   = require('fs');
const path = require('path');

function resolveImportFile() {
  if (process.env.USERS_IMPORT_FILE) return process.env.USERS_IMPORT_FILE;
  return path.resolve(__dirname, 'import', 'users.json');
}

module.exports = {
  async up(queryInterface) {
    const file = resolveImportFile();
    if (!fs.existsSync(file)) {
      console.log(`[seed:import-users] No import file at ${file} — skipping.`);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`[seed:import-users] Could not parse ${file}: ${err.message} — skipping.`);
      return;
    }

    const users = Array.isArray(parsed) ? parsed : (parsed.users || []);
    if (!users.length) {
      console.log('[seed:import-users] Import file has no users — skipping.');
      return;
    }

    // Skip any username that already exists, so we never clobber live accounts.
    const [existing] = await queryInterface.sequelize.query('SELECT username FROM users');
    const have = new Set(existing.map(r => r.username));

    const now = new Date();
    const rows = users
      .filter(u => u && u.username && u.callsign && u.password && !have.has(u.username))
      .map(u => ({
        username:  String(u.username),
        callsign:  String(u.callsign),
        password:  String(u.password),                       // already an MD5 hash
        role:      ['Owner', 'Admin', 'Editor', 'Viewer'].includes(u.role) ? u.role : 'Viewer',
        friends:   u.friends ?? null,
        banned:    !!u.banned,
        createdAt: now,
        updatedAt: now,
      }));

    if (!rows.length) {
      console.log('[seed:import-users] Nothing new to import (all users already exist).');
      return;
    }

    await queryInterface.bulkInsert('users', rows);
    console.log(`[seed:import-users] Imported ${rows.length} user(s) from ${file}.`);
  },

  async down() {
    // Non-destructive: we don't auto-remove imported users on rollback.
  },
};
