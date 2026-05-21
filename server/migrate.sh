#!/bin/sh
# create db
node_modules/.bin/sequelize db:create
# migrate models to the database
node_modules/.bin/sequelize db:migrate
# upload seeder data
node_modules/.bin/sequelize db:seed:all