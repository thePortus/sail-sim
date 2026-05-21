const Sequelize = require('sequelize');
const config    = require('../config/db.config');

const sequelize = new Sequelize(config.DB, config.USER, config.PASSWORD, {
  host:    config.HOST,
  port:    config.port,
  dialect: config.dialect,
  pool:    config.pool,
  logging: false,
});

const db = {};
db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.User = require('./user.model')(sequelize, Sequelize.DataTypes);

module.exports = db;
