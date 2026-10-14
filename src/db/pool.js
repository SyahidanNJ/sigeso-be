const { Pool } = require('pg');
const logger = require('../lib/logger');

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (e) => logger.error({ err: e }, 'pg pool error'));
} else {
  logger.warn('DATABASE_URL kosong, mode tanpa-DB (health degraded).');
}

async function dbStatus() {
  if (!pool) return { ok: false, reason: 'no DATABASE_URL' };
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { pool, dbStatus };
