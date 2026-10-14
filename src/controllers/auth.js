const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function sign(u) {
  return jwt.sign({ id: u.id, role: u.role, institution_id: u.institution_id }, process.env.JWT_SECRET || 'dev', { expiresIn: '12h' });
}

// shortcut: throttle in-memory (reset saat restart). Ganti store eksternal bila multi-instance.
const ember = new Map();
function throttle(req, res, next) {
  const k = req.ip;
  const now = Date.now();
  const riw = (ember.get(k) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (riw.length >= 10) return fail(res, 429, 'QUOTA_EXCEEDED', 'Terlalu banyak percobaan, tunggu 15 menit.');
  riw.push(now);
  ember.set(k, riw);
  next();
}

// Daftar publik (hanya nama institusi yang dibuka, tanpa data sensitif).
async function institutionsPublic(req, res, next) {
  try {
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    ok(res, (await pool.query('SELECT id, name FROM institutions ORDER BY name')).rows);
  } catch (e) { next(e); }
}

async function register(req, res, next) {
  try {
    const p = z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(6), institution_id: z.number().int() }).parse(req.body);
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const inst = await pool.query('SELECT id FROM institutions WHERE id=$1', [p.institution_id]);
    if (!inst.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Institusi tak dikenal.');
    const ada = await pool.query('SELECT id FROM users WHERE email=$1', [p.email]);
    if (ada.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Email sudah terdaftar, silakan login.');
    const q = await pool.query(
      'INSERT INTO users(institution_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,institution_id',
      [p.institution_id, p.name, p.email, await bcrypt.hash(p.password, 10), 'guru']
    );
    await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6)',
      [res.locals.requestId, q.rows[0].id, p.institution_id, 'register', 'users', q.rows[0].id]);
    ok(res, { token: sign(q.rows[0]), user: { id: q.rows[0].id, name: q.rows[0].name, role: 'guru' } }, 'Pendaftaran berhasil, selamat datang.');
  } catch (e) {
    next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
}

async function login(req, res, next) {
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
}

function me(req, res) {
  const h = req.headers.authorization || '';
  try {
    const u = jwt.verify(h.replace('Bearer ', ''), process.env.JWT_SECRET || 'dev');
    return ok(res, u);
  } catch {
    return fail(res, 401, 'UNAUTHORIZED', 'Token tidak valid.');
  }
}

module.exports = { throttle, institutionsPublic, register, login, me };
