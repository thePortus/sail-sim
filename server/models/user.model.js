module.exports = (sequelize, DataTypes) => {
  return sequelize.define('user', {
    username: { type: DataTypes.STRING(50),  allowNull: false, unique: true },
    callsign:    { type: DataTypes.STRING(100), allowNull: false, unique: true },
    password: { type: DataTypes.STRING,      allowNull: false },
    role: {
      type: DataTypes.ENUM('Owner', 'Admin', 'Editor', 'Viewer'),
      defaultValue: 'Viewer',
    },

    // When true, login is refused. Set/cleared by Owner/Admin via /ban /unban.
    banned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // ── Last-known sailing position ──────────────────────────────────────────
    // Persisted on each auto-save (every 30 s), on exit, and on logout.
    // NULL means the player has never sailed — they will spawn at the island default.
    lastX:           { type: DataTypes.DOUBLE,     allowNull: true, defaultValue: null },
    lastZ:           { type: DataTypes.DOUBLE,     allowNull: true, defaultValue: null },
    lastHeading:     { type: DataTypes.FLOAT,      allowNull: true, defaultValue: null },
    lastVesselSlug:  { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
    lastCallsign:    { type: DataTypes.STRING(16), allowNull: true, defaultValue: null },
    locationSavedAt: { type: DataTypes.DATE,       allowNull: true, defaultValue: null },
    // Map version the saved position belongs to. On spawn, a saved location is restored only when this
    // matches the server's current MAP_VERSION (movement-constants.js); otherwise the player coastal-
    // spawns on the new map. NULL = a legacy save from before this column existed (treated as current).
    lastMapVersion:  { type: DataTypes.INTEGER,    allowNull: true, defaultValue: null },

    // ── Friend list ──────────────────────────────────────────────────────────
    // JSON array of callsigns this user has explicitly friended.
    // Mutual friendship requires both players to have each other in their list.
    friends: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },

    // ── Town Economy ───────────────────────────────────────────────────────────
    // gold: the player's purse (gold pieces). New players start with 500.
    // cargo: JSON object { goodId: qty } of held trade goods (the ship's hold).
    // tradeLedger: JSON array of recent transactions (written now; surfaced in a later phase).
    // gold/cargo persist across server restart AND across map regen (they are the player's, not the world's).
    gold:        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 500 },
    cargo:       { type: DataTypes.TEXT,    allowNull: true,  defaultValue: null },
    tradeLedger: { type: DataTypes.TEXT,    allowNull: true,  defaultValue: null },

    // Persistent ship damage: JSON { zones, slug, mapVersion } of the player's last hull state. Restored on
    // reconnect (so battle damage survives logout/restart) UNLESS its mapVersion is stale (new map → full
    // hull). Cleared to full by a dock repair or a sunk→respawn.
    combatState: { type: DataTypes.TEXT,    allowNull: true,  defaultValue: null },
  });
};
