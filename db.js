const usePostgres = !!process.env.DATABASE_URL;

if (usePostgres) {
  try {
    console.log('[DB] Using PostgreSQL');
    module.exports = require('./db-postgres');
  } catch (e) {
    console.log('[DB] PostgreSQL failed to load, using local JSON');
    module.exports = require('./db-json');
  }
} else {
  console.log('[DB] Using local JSON (no DATABASE_URL)');
  module.exports = require('./db-json');
}
