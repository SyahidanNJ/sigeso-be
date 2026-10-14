require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, 'migrate.sql'), 'utf8');
  await pool.query(sql);
  console.log('migrasi sigeso_db OK');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
