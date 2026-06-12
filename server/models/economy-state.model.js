module.exports = (sequelize, DataTypes) => {
  // Singleton global town-economy state, one row per MAP_VERSION (Town Economy — Phase 2). `towns` is a JSON
  // blob { [townId]: { stock: { goodId: qty }, treasury } } — MEDIUMTEXT since ~50 towns × ~10 goods can exceed
  // TEXT's 64 KB. A row whose mapVersion != the server's current MAP_VERSION is stale → the economy reseeds.
  return sequelize.define('economyState', {
    mapVersion:  { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
    lastTickDay: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    towns:       { type: DataTypes.TEXT('medium'), allowNull: false, defaultValue: '{}' },
  }, { timestamps: false });
};
