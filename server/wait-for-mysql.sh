#!/bin/sh

# Wait for MySQL to be ready
until nc -z -v -w30 $DB_HOST $DB_PORT
do
  echo "Waiting for database connection..."
  sleep 10
done
echo "Database is up and running!"