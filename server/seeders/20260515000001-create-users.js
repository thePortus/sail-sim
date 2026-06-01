/**
 * @file Seeds the database with the site owner account from environment
 *       variables.  In the future this seeder will also load additional
 *       accounts from a provided JSON file.
 */

const md5    = require('md5');
const config = require('../config/db.config.js');

/*
let importPath = './import/';

if (process.env.NODE_ENV == 'test') {
  importPath += 'test-data/';
}
else {
  importPath += 'data/';
}

importPath += 'users.json';

const importData = require(importPath);
*/ 
const ownerUsername = process.env.OWNER_USERNAME || 'sail-sim-owner';
const ownerPassword = process.env.OWNER_PASSWORD || 'password';
const ownerCallsign = process.env.OWNER_CALLSIGN || 'Teach';

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkInsert('users', [
      {
        username:  ownerUsername,
        password:  md5(ownerPassword),
        callsign:     ownerCallsign,
        role:      'Owner',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    /*
    for (const importDatum of importData) {
      await queryInterface.bulkInsert('users', [
        {
          username:  importDatum.username,
          password:  importDatum.password,
          callsign:  importDatum.callsign,
          role:      importDatum.role,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      {});
    }
    */
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('users', { username: ownerUsername });
  },
};
