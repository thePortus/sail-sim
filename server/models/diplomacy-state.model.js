module.exports = (sequelize, DataTypes) => {
  // Singleton inter-faction diplomacy state (Diplomacy module). ONE row (id=1) — unlike the economy this is
  // NOT map-gated: the four nations and their wars/alliances persist across map regens (the relations are the
  // world's politics, not its geometry). `rel` is a small JSON blob { "a|b": "war"|"peace"|"alliance" } over
  // the 6 unordered faction pairs; `lastShiftDay` tracks the in-game day of the last rare state change.
  return sequelize.define('diplomacyState', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, allowNull: false, defaultValue: 1 },
    lastShiftDay:{ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rel:         { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
  }, { timestamps: false });
};
