if (!process.env.DATABASE_URL) {
  console.error('[DB] DATABASE_URL is not set. PostgreSQL is required.');
  process.exit(1);
}

console.log('[DB] Using PostgreSQL');
module.exports = require('./db-postgres');
