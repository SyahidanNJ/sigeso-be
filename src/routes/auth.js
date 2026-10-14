const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');

const router = express.Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function sign(u) {
  return jwt.sign({ id: u.id, role: u.role, institution_id: u.institution_id }, process.env.JWT_SECRET || 'dev', { expiresIn: '12h' });
}

router.post('/login', async (req, res, next) => {
  try {
    const p = loginSchema.parse(req.body);
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const r = await pool.query('SELECT * FROM users WHERE email=$1 AND is_active=true', [p.email]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(p.password, u.password_hash))) return fail(res, 401, 'UNAUTHORIZED', 'Email atau password salah.');
    await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity) VALUES($1,$2,$3,$4,$5)', [res.locals.requestId, u.id, u.institution_id, 'login', 'users']);
    return ok(res, { token: sign(u), user: { id: u.id, name: u.name, role: u.role } }, 'Login berhasil.');
  } catch (e) {
    next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
});

router.get('/me', async (req, res) => {
  const h = req.headers.authorization || '';
  try {
    const u = jwt.verify(h.replace('Bearer ', ''), process.env.JWT_SECRET || 'dev');
    return ok(res, u);
  } catch {
    return fail(res, 401, 'UNAUTHORIZED', 'Token tidak valid.');
  }
});

module.exports = router;
