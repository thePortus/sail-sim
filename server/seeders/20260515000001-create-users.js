/**
 * @file Seeds the database with the site owner account from environment
 *       variables.  In the future this seeder will also load additional
 *       accounts from a provided JSON file.
 */

const md5    = require('md5');
const config = require('../config/db.config.js');

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkInsert('users', [
      {
        username:  config.OWNER_USERNAME,
        password:  md5(config.OWNER_PASSWORD),
        email:     config.OWNER_EMAIL,
        role:      'Owner',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('users', { username: config.OWNER_USERNAME });
  },
};
