const fs = require('fs');
const path = require('path');

const usePostgres = !!process.env.DATABASE_URL;

if (usePostgres) {
  console.log('[DB] Using PostgreSQL');
  module.exports = require('./db-postgres');
} else {
  console.log('[DB] Using local JSON (no DATABASE_URL)');
  module.exports = require('./db-json');
}
