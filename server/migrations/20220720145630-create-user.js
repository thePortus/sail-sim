'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('users', {
      id:        { type: Sequelize.INTEGER,                     primaryKey: true, autoIncrement: true },
      username:  { type: Sequelize.STRING(50),  allowNull: false, unique: true },
      email:     { type: Sequelize.STRING(100), allowNull: false, unique: true },
      password:  { type: Sequelize.STRING,      allowNull: false },
      role: {
        type:         Sequelize.ENUM('Owner', 'Admin', 'Editor', 'Viewer'),
        defaultValue: 'Viewer',
      },
      createdAt: { type: Sequelize.DATE },
      updatedAt: { type: Sequelize.DATE },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('users');
  },
};
