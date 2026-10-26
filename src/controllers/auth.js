const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { kirimEmail, appUrl } = require('../lib/mailer');

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

// Daftar kelas untuk form pendaftaran. Hanya metadata kelas, tanpa siswa.
async function classesPublic(req, res, next) {
  try {
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const inst = Number(req.params.id);
    if (!inst) return fail(res, 400, 'VALIDATION_ERROR', 'Sekolah tak dikenal.');
    ok(res, (await pool.query(
      'SELECT id, name, level, jenjang, academic_year FROM classes WHERE institution_id=$1 ORDER BY academic_year DESC, level, name',
      [inst]
    )).rows);
  } catch (e) { next(e); }
}

// Profil lengkap dipakai /auth/me, /auth/profile, dan login supaya bentuknya
// sama: header, halaman Profil, dan halaman Ujian membaca medan yang sama.
const PROFIL_SQL = `
  SELECT u.id, u.name, u.email, u.role, u.institution_id, u.default_class_id,
         i.name AS school, c.name AS class_name, c.level, c.jenjang, c.academic_year
    FROM users u
    LEFT JOIN institutions i ON i.id = u.institution_id
    LEFT JOIN classes c ON c.id = u.default_class_id
   WHERE u.id = $1`;

async function profil(userId) {
  return (await pool.query(PROFIL_SQL, [userId])).rows[0];
}

async function register(req, res, next) {
  try {
    const p = z.object({
      name: z.string().min(1), email: z.string().email(), password: z.string().min(6),
      institution_id: z.number().int(), class_id: z.number().int().optional().nullable(),
    }).parse(req.body);
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const inst = await pool.query('SELECT id FROM institutions WHERE id=$1', [p.institution_id]);
    if (!inst.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Institusi tak dikenal.');
    let classId = null;
    if (p.class_id) {
      const k = await pool.query('SELECT id FROM classes WHERE id=$1 AND institution_id=$2', [p.class_id, p.institution_id]);
      if (!k.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Kelas tak dikenal di sekolah itu. Atur nanti di halaman Profil.');
      classId = p.class_id;
    }
    const ada = await pool.query('SELECT id FROM users WHERE email=$1', [p.email]);
    if (ada.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Email sudah terdaftar, silakan login.');
    const q = await pool.query(
      'INSERT INTO users(institution_id,name,email,password_hash,role,default_class_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,institution_id,default_class_id',
      [p.institution_id, p.name, p.email, await bcrypt.hash(p.password, 10), 'guru', classId]
    );
    await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6)',
      [res.locals.requestId, q.rows[0].id, p.institution_id, 'register', 'users', q.rows[0].id]);
    ok(res, { token: sign(q.rows[0]), user: { id: q.rows[0].id, name: q.rows[0].name, role: 'guru', default_class_id: classId } }, 'Pendaftaran berhasil, selamat datang.');
  } catch (e) {
    next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
}

async function login(req, res, next) {
  try {
    const p = loginSchema.parse(req.body);
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const r = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1) AND is_active=true', [p.email]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(p.password, u.password_hash))) return fail(res, 401, 'UNAUTHORIZED', 'Email atau kata sandi salah.');
    await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity) VALUES($1,$2,$3,$4,$5)', [res.locals.requestId, u.id, u.institution_id, 'login', 'users']);
    return ok(res, { token: sign(u), user: { id: u.id, name: u.name, role: u.role, default_class_id: u.default_class_id } }, 'Login berhasil.');
  } catch (e) {
    next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
}

// Profil dibaca dari database (bukan cuma isi token) supaya halaman Profil
// bisa menampilkan nama, email, sekolah, dan kelas terbaru.
async function me(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const t = jwt.verify(h.replace('Bearer ', ''), process.env.JWT_SECRET || 'dev');
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const p = await profil(t.id);
    if (!p) return fail(res, 401, 'UNAUTHORIZED', 'Pengguna tak ditemukan.');
    return ok(res, p);
  } catch {
    return fail(res, 401, 'UNAUTHORIZED', 'Token tidak valid.');
  }
}

// Guru boleh mengganti nama tampilannya dan kelas defaultnya sendiri; email
// dan peran tidak. Kelas wajib milik sekolahnya.
async function updateProfile(req, res, next) {
  try {
    const p = z.object({
      name: z.string().trim().min(1, 'Nama belum diisi.').max(120).optional(),
      default_class_id: z.number().int().optional(),
    }).refine((x) => x.name !== undefined || x.default_class_id !== undefined, { message: 'Tidak ada yang diubah.' }).parse(req.body);
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    if (p.default_class_id) {
      const k = await pool.query('SELECT id FROM classes WHERE id=$1 AND institution_id=$2', [p.default_class_id, req.user.institution_id]);
      if (!k.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Kelas tak dikenal di sekolah Anda.');
    }
    const r = await pool.query(
      'UPDATE users SET name=COALESCE($1,name), default_class_id=COALESCE($2,default_class_id) WHERE id=$3 RETURNING id',
      [p.name ?? null, p.default_class_id ?? null, req.user.id]
    );
    if (!r.rowCount) return fail(res, 401, 'UNAUTHORIZED', 'Pengguna tak ditemukan.');
    await pool.query(
      'INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6)',
      [res.locals.requestId, req.user.id, req.user.institution_id, 'change_profile', 'users', req.user.id]
    );
    return ok(res, await profil(req.user.id), 'Profil disimpan.');
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

// ---- LUPA KATA SANDI ----
// Jawaban selalu sama supaya tak bisa dipakai menebak email mana yang terdaftar.
const PESAN_TERKIRIM = 'Kalau email itu terdaftar, tautan atur ulang sudah dikirim. Cek juga folder spam.';
// Batas per alamat email (bukan per IP: satu sekolah biasanya berbagi satu IP).
// shortcut: penanda di memori, hilang saat server restart; pindah ke tabel bila perlu tahan lama.
const batasReset = new Map();
function lewatBatasReset(email) {
  const kini = Date.now();
  const riw = (batasReset.get(email) || []).filter((t) => kini - t < 15 * 60 * 1000);
  riw.push(kini);
  batasReset.set(email, riw);
  return riw.length > 3;
}

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const escHtml = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function forgotPassword(req, res, next) {
  try {
    const p = z.object({ email: z.string().trim().toLowerCase().email('Email belum benar.') }).parse(req.body);
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    if (lewatBatasReset(p.email)) return fail(res, 429, 'QUOTA_EXCEEDED', 'Terlalu banyak permintaan. Tunggu 15 menit lalu coba lagi.');

    const u = (await pool.query('SELECT id, name, email FROM users WHERE lower(email)=$1 AND is_active=true', [p.email])).rows[0];
    if (!u) return ok(res, null, PESAN_TERKIRIM);

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query("DELETE FROM password_resets WHERE expires_at < now() OR used_at IS NOT NULL");
    await pool.query("INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES($1,$2, now() + interval '60 minutes')", [u.id, hashToken(token)]);

    const link = `${appUrl()}/reset-sandi?token=${token}`;
    try {
      await kirimEmail({
        to: u.email,
        subject: 'Atur ulang kata sandi Sigeso',
        text: `Halo ${u.name},\n\nKami menerima permintaan mengatur ulang kata sandi akun Sigeso Anda.\nBuka tautan ini untuk membuat kata sandi baru:\n\n${link}\n\nTautan berlaku 60 menit dan hanya bisa dipakai sekali. Kalau Anda tidak meminta ini, abaikan email ini.\n\n— Sigeso`,
        html: `<p>Halo ${escHtml(u.name)},</p><p>Kami menerima permintaan mengatur ulang kata sandi akun Sigeso Anda.</p><p><a href="${link}">Buat kata sandi baru</a></p><p>Tautan berlaku 60 menit dan hanya bisa dipakai sekali. Kalau Anda tidak meminta ini, abaikan email ini.</p><p>— Sigeso</p>`,
      });
    } catch (e) {
      // Token yang tak sempat terkirim jangan tertinggal bisa dipakai.
      await pool.query('DELETE FROM password_resets WHERE token_hash=$1', [hashToken(token)]);
      throw e;
    }
    return ok(res, null, PESAN_TERKIRIM);
  } catch (e) {
    return next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
}

async function resetPassword(req, res, next) {
  try {
    const p = z.object({ token: z.string(), baru: z.string() }).parse(req.body);
    if (p.baru.length < 6) return fail(res, 400, 'VALIDATION_ERROR', 'Kata sandi baru minimal 6 huruf.');
    if (p.token.length < 20) return fail(res, 400, 'VALIDATION_ERROR', 'Tautan tidak valid. Minta tautan baru dari halaman lupa sandi.');
    if (!pool) return fail(res, 500, 'DB_ERROR', 'Database belum dikonfigurasi.');
    const q = await pool.query(
      "UPDATE password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id",
      [hashToken(p.token)]
    );
    if (!q.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Tautan sudah kedaluwarsa atau pernah dipakai. Minta tautan baru.');
    const uid = q.rows[0].user_id;
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(p.baru, 10), uid]);
    await pool.query('DELETE FROM password_resets WHERE user_id=$1 AND used_at IS NULL', [uid]);
    const u = (await pool.query('SELECT institution_id FROM users WHERE id=$1', [uid])).rows[0];
    await pool.query(
      'INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6)',
      [res.locals.requestId, uid, u?.institution_id || null, 'reset_password', 'users', uid]
    );
    return ok(res, null, 'Kata sandi sudah diganti. Silakan masuk.');
  } catch (e) {
    return next(e.code ? e : Object.assign(e, { code: 'VALIDATION_ERROR', httpStatus: 400 }));
  }
}

module.exports = { throttle, institutionsPublic, classesPublic, register, login, me, updateProfile, changePassword, forgotPassword, resetPassword };
