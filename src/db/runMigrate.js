require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { backfill } = require('./migrate-v2');

// Dua langkah: skema dulu (aman diulang), lalu backfill data lama.
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migrate.sql'), 'utf8');
    await pool.query(sql);
    console.log('skema sigeso_db OK');
    const stat = await backfill(pool);
    console.log('data lama dirapikan:', JSON.stringify(stat));
    console.log('migrasi sigeso_db OK');
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
