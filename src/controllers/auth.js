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
    if (!u || !(await bcrypt.compare(p.password, u.password_hash))) return fail(res, 401, 'UNAUTHORIZED', 'Email atau kata sandi salah.');
    await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity) VALUES($1,$2,$3,$4,$5)', [res.locals.requestId, u.id, u.institution_id, 'login', 'users']);
    return ok(res, { token: sign(u), user: { id: u.id, name: u.name, role: u.role } }, 'Login berhasil.');
  } catch (e) {
    next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
}

// Profil dibaca dari database (bukan cuma isi token) supaya halaman Profil
// bisa menampilkan nama, email, dan sekolah yang terbaru.
async function me(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const t = jwt.verify(h.replace('Bearer ', ''), process.env.JWT_SECRET || 'dev');
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const r = await pool.query(
      'SELECT u.id, u.name, u.email, u.role, i.name AS school FROM users u LEFT JOIN institutions i ON i.id = u.institution_id WHERE u.id = $1',
      [t.id]
    );
    if (!r.rowCount) return fail(res, 401, 'UNAUTHORIZED', 'Pengguna tak ditemukan.');
    return ok(res, r.rows[0]);
  } catch {
    return fail(res, 401, 'UNAUTHORIZED', 'Token tidak valid.');
  }
}

// Guru boleh mengganti nama tampilannya sendiri; email dan peran tidak.
async function updateProfile(req, res, next) {
  try {
    const p = z.object({ name: z.string().trim().min(1, 'Nama belum diisi.').max(120) }).parse(req.body);
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const r = await pool.query('UPDATE users SET name=$1 WHERE id=$2 RETURNING id, name, email, role', [p.name, req.user.id]);
    if (!r.rowCount) return fail(res, 401, 'UNAUTHORIZED', 'Pengguna tak ditemukan.');
    await pool.query(
      'INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6)',
      [res.locals.requestId, req.user.id, req.user.institution_id, 'change_profile', 'users', req.user.id]
    );
    return ok(res, r.rows[0], 'Nama diganti.');
  } catch (e) {
    return next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
}

async function changePassword(req, res, next) {
  try {
    const p = z.object({ lama: z.string().min(1), baru: z.string().min(6) }).parse(req.body);
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!r.rowCount || !(await bcrypt.compare(p.lama, r.rows[0].password_hash))) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Kata sandi lama salah.');
    }
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(p.baru, 10), req.user.id]);
    await pool.query(
      'INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6)',
      [res.locals.requestId, req.user.id, req.user.institution_id, 'change_password', 'users', req.user.id]
    );
    return ok(res, { id: req.user.id }, 'Kata sandi diganti.');
  } catch (e) {
    return next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
}

module.exports = { throttle, institutionsPublic, register, login, me, updateProfile, changePassword };
