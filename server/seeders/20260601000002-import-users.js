/**
 * @file Restores a player backup produced by the Owner's in-game `/export` command (GET /user/export).
 *       A v2 backup restores every account PLUS each player's wallet (gold), faction standing, owned ship,
 *       cargo/ledgers, battle damage and last-known position. v1 backups (credentials only) still import
 *       fine. The world town-economy is NOT part of the backup — it re-seeds fresh on restore.
 *
 * Usage:
 *   1. As the Owner, run `/export` in chat to download `users.json`.
 *   2. Place that file at server/seeders/import/users.json (or set USERS_IMPORT_FILE to its path).
 *   3. Run the seeders (npm run migrate, or `npx sequelize-cli db:seed:all`).
 *
 * Behaviour:
 *   - Passwords import as-is (the export stores the existing MD5 hashes).
 *   - Existing usernames are SKIPPED (never clobbers a live account or the seeded owner) — so this restores
 *     into a fresh DB and is safe to re-run.
 *   - The runtime-added economy columns (gold/cargo/ship/factionRep/…) are ensured here first, since the
 *     seeder may run BEFORE the server boots (which is what normally adds them) — otherwise a restored
 *     wallet/faction would be dropped.
 *   - If the file is absent, the seeder is a no-op (normal for a fresh install).
 */

const fs   = require('fs');
const path = require('path');

function resolveImportFile() {
  if (process.env.USERS_IMPORT_FILE) return process.env.USERS_IMPORT_FILE;
  return path.resolve(__dirname, 'import', 'users.json');
}

const ROLES = ['Owner', 'Admin', 'Editor', 'Viewer'];
const numOrNull = (v) => (v === null || v === undefined || v === '' || !isFinite(+v) ? null : +v);
const intOrNull = (v) => { const n = numOrNull(v); return n === null ? null : Math.round(n); };
// JSON-text columns round-trip as strings; tolerate an object too (stringify it).
const jsonText  = (v) => (v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)));

/** Idempotently add the runtime per-player economy columns (mirrors models/index.js) so a pre-boot restore
 *  has somewhere to put the wallet/faction/ship data. addColumn throws if a column already exists — swallowed. */
async function ensureSchema(queryInterface, Sequelize) {
  const DT = Sequelize.DataTypes;
  const adds = [
    ['lastMapVersion', { type: DT.INTEGER, allowNull: true, defaultValue: null }],
    ['gold',          { type: DT.INTEGER, allowNull: false, defaultValue: 500 }],
    ['cargo',         { type: DT.TEXT,    allowNull: true,  defaultValue: null }],
    ['tradeLedger',   { type: DT.TEXT,    allowNull: true,  defaultValue: null }],
    ['combatState',   { type: DT.TEXT,    allowNull: true,  defaultValue: null }],
    ['marketLedger',  { type: DT.TEXT,    allowNull: true,  defaultValue: null }],
    ['factionRep',    { type: DT.TEXT,    allowNull: true,  defaultValue: null }],
    ['ship',          { type: DT.STRING(64), allowNull: false, defaultValue: 'pinnace' }],
  ];
  for (const [name, spec] of adds) {
    try { await queryInterface.addColumn('users', name, spec); } catch { /* already exists */ }
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const file = resolveImportFile();
    if (!fs.existsSync(file)) {
      console.log(`[seed:import] No import file at ${file} — skipping.`);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`[seed:import] Could not parse ${file}: ${err.message} — skipping.`);
      return;
    }

    await ensureSchema(queryInterface, Sequelize);

    // ── Users (with full per-player economy + location state) ──────────────────────────────────────
    const users = Array.isArray(parsed) ? parsed : (parsed.users || []);
    const [existing] = await queryInterface.sequelize.query('SELECT username FROM users');
    const have = new Set(existing.map(r => r.username));
    const now = new Date();

    const rows = users
      .filter(u => u && u.username && u.callsign && u.password && !have.has(u.username))
      .map(u => ({
        username:  String(u.username),
        callsign:  String(u.callsign),
        password:  String(u.password),                       // already an MD5 hash
        role:      ROLES.includes(u.role) ? u.role : 'Viewer',
        banned:    !!u.banned,
        friends:   jsonText(u.friends),
        // last-known position (map-version-gated on spawn)
        lastX:           numOrNull(u.lastX),
        lastZ:           numOrNull(u.lastZ),
        lastHeading:     numOrNull(u.lastHeading),
        lastVesselSlug:  u.lastVesselSlug != null ? String(u.lastVesselSlug) : null,
        lastCallsign:    u.lastCallsign != null ? String(u.lastCallsign) : null,
        locationSavedAt: u.locationSavedAt ? new Date(u.locationSavedAt) : null,
        lastMapVersion:  intOrNull(u.lastMapVersion),
        // town economy — wallet, hold, ledgers, faction standing, owned ship, battle damage
        gold:        Number.isFinite(+u.gold) ? Math.round(+u.gold) : 500,
        cargo:       jsonText(u.cargo),
        tradeLedger: jsonText(u.tradeLedger),
        combatState: jsonText(u.combatState),
        marketLedger: jsonText(u.marketLedger),
        factionRep:  jsonText(u.factionRep),
        ship:        u.ship != null ? String(u.ship) : 'pinnace',
        createdAt: now,
        updatedAt: now,
      }));

    if (rows.length) {
      await queryInterface.bulkInsert('users', rows);
      console.log(`[seed:import] Restored ${rows.length} user(s) (incl. wallet + faction) from ${file}.`);
    } else {
      console.log('[seed:import] No new users to restore (all already exist).');
    }
  },

  async down() {
    // Non-destructive: we don't auto-remove restored data on rollback.
  },
};
