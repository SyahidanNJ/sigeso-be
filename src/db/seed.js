require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// Membuat superadmin awal + 1 institusi contoh bila belum ada.
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const email = process.env.SEED_EMAIL || 'admin@sigeso.local';
  const pass = process.env.SEED_PASSWORD || 'ganti-password-ini';
  const ex = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (ex.rowCount) {
    console.log('seed: superadmin sudah ada');
  } else {
    const inst = await pool.query("INSERT INTO institutions(name,address) VALUES('Sekolah Contoh','Jl. Contoh No.1') RETURNING id");
    await pool.query('INSERT INTO users(institution_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [
      inst.rows[0].id, 'Superadmin', email, await bcrypt.hash(pass, 10), 'superadmin',
    ]);
    console.log(`seed OK: ${email}`);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
