const fs = require('fs');
const path = require('path');

const usePostgres = !!process.env.DATABASE_URL;

if (usePostgres) {
  try {
    const pgdb = require('./db-postgres');
    pgdb.testConnection().then(ok => {
      if (ok) {
        console.log('[DB] Using PostgreSQL');
      } else {
        throw new Error('Connection failed');
      }
    }).catch(() => {
      console.log('[DB] PostgreSQL unreachable, falling back to JSON');
    });
    module.exports = pgdb;
  } catch (e) {
    console.log('[DB] PostgreSQL failed to load, using local JSON');
    module.exports = require('./db-json');
  }
} else {
  console.log('[DB] Using local JSON (no DATABASE_URL)');
  module.exports = require('./db-json');
}
