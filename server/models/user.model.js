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

    // ── Friend list ──────────────────────────────────────────────────────────
    // JSON array of callsigns this user has explicitly friended.
    // Mutual friendship requires both players to have each other in their list.
    friends: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
  });
};
