const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { needTenant } = require('../lib/scope');
const { audit } = require('./bantuan');

// ---- INSTITUSI (superadmin kelola penuh, lainnya baca milik sendiri) ----
async function listInstitutions(req, res) {
  const q = req.user.role === 'superadmin' && !req.query.institution_id
    ? await pool.query('SELECT * FROM institutions ORDER BY id')
    : await pool.query('SELECT * FROM institutions WHERE id=$1', [req.user.institution_id]);
  ok(res, q.rows);
}
async function createInstitution(req, res) {
  const p = z.object({ name: z.string().min(1), address: z.string().optional(), npsn: z.string().optional() }).parse(req.body);
  const q = await pool.query('INSERT INTO institutions(name,address,npsn) VALUES($1,$2,$3) RETURNING *', [p.name, p.address || null, p.npsn || null]);
  await audit(req, 'create', 'institutions', q.rows[0].id);
  ok(res, q.rows[0], 'Institusi dibuat.');
}

// Data sekolah sendiri (nama, NPSN, alamat) — diisi dari halaman Sekolah,
// biasanya hasil pencarian di data referensi Kemendikdasmen.
async function updateInstitution(req, res) {
  const p = z.object({ name: z.string().min(1), address: z.string().optional(), npsn: z.string().optional() }).parse(req.body);
  const inst = needTenant(req, res);
  if (!inst) return;
  const q = await pool.query('UPDATE institutions SET name=$1, address=$2, npsn=$3 WHERE id=$4 RETURNING *',
    [p.name, p.address || null, p.npsn || null, inst]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Institusi tak ada.');
  await audit(req, 'update', 'institutions', inst);
  ok(res, q.rows[0], 'Data sekolah disimpan.');
}

// ---- LOGO KOP ----
const UPLOAD = path.join(__dirname, '..', '..', 'uploads');
const DIR_LOGO = path.join(UPLOAD, 'logo');
const EXT_LOGO = { 'image/png': '.png', 'image/jpeg': '.jpg' };

// Satu permintaan bisa membawa kedua logo; yang tidak dikirim dibiarkan apa adanya.
async function uploadLogos(req, res) {
  const inst = needTenant(req, res);
  if (!inst) return;
  const kiri = req.files?.kiri?.[0];
  const kanan = req.files?.kanan?.[0];
  if (!kiri && !kanan) return fail(res, 400, 'VALIDATION_ERROR', 'Pilih berkas logo dulu.');

  const lama = (await pool.query('SELECT logo_path, logo_left_path FROM institutions WHERE id=$1', [inst])).rows[0];
  if (!lama) return fail(res, 404, 'NOT_FOUND', 'Institusi tak ada.');

  const dir = path.join(DIR_LOGO, String(inst));
  fs.mkdirSync(dir, { recursive: true });
  const simpan = (f) => {
    const nama = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${EXT_LOGO[f.mimetype]}`;
    fs.writeFileSync(path.join(dir, nama), f.buffer);
    return path.posix.join('logo', String(inst), nama);
  };
  const relKiri = kiri ? simpan(kiri) : lama.logo_left_path;
  const relKanan = kanan ? simpan(kanan) : lama.logo_path;
  const q = await pool.query('UPDATE institutions SET logo_left_path=$1, logo_path=$2 WHERE id=$3 RETURNING *', [relKiri, relKanan, inst]);

  // Berkas lama baru dibuang setelah baris database tersimpan.
  for (const [f, rel] of [[kiri, lama.logo_left_path], [kanan, lama.logo_path]]) {
    if (!f || !rel) continue;
    const p = path.resolve(UPLOAD, rel);
    if (p.startsWith(UPLOAD + path.sep)) fs.rmSync(p, { force: true });
  }
  await audit(req, 'update', 'institutions', inst);
  ok(res, q.rows[0], 'Logo disimpan.');
}

// ---- PENGGUNA (admin kelola guru di institusinya) ----
async function listUsers(req, res) {
  const inst = req.user.role === 'superadmin' ? req.query.institution_id || null : req.user.institution_id;
  const q = inst
    ? await pool.query('SELECT id,name,email,role,institution_id,is_active FROM users WHERE institution_id=$1 ORDER BY id', [inst])
    : await pool.query('SELECT id,name,email,role,institution_id,is_active FROM users ORDER BY id');
  ok(res, q.rows);
}
async function createUser(req, res) {
  const p = z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(6), role: z.enum(['admin', 'guru']) }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const email = p.email.toLowerCase();
  const ada = await pool.query('SELECT id FROM users WHERE lower(email)=$1', [email]);
  if (ada.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Email itu sudah dipakai akun lain.');
  const hash = await bcrypt.hash(p.password, 10);
  const q = await pool.query(
    'INSERT INTO users(institution_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,institution_id',
    [inst, p.name, email, hash, p.role]
  );
  await audit(req, 'create', 'users', q.rows[0].id);
  ok(res, q.rows[0], 'Pengguna dibuat.');
}

// Admin boleh mengubah guru di sekolahnya; akun superadmin tak bisa disentuh, dan
// admin tak boleh menonaktifkan/menurunkan dirinya sendiri supaya tak terkunci.
async function updateUser(req, res) {
  const p = z.object({ name: z.string().min(1), role: z.enum(['admin', 'guru']), is_active: z.boolean() }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  if (Number(req.params.id) === req.user.id && (!p.is_active || p.role !== req.user.role)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Akun Anda sendiri tidak bisa dinonaktifkan atau diturunkan perannya.');
  }
  const q = await pool.query(
    "UPDATE users SET name=$1, role=$2, is_active=$3 WHERE id=$4 AND institution_id=$5 AND role <> 'superadmin' RETURNING id,name,email,role,is_active",
    [p.name, p.role, p.is_active, req.params.id, inst]
  );
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Pengguna tak ditemukan.');
  await audit(req, 'update', 'users', Number(req.params.id));
  ok(res, q.rows[0], 'Pengguna diubah.');
}

async function resetUserPassword(req, res) {
  const p = z.object({ password: z.string() }).parse(req.body);
  if (p.password.length < 6) return fail(res, 400, 'VALIDATION_ERROR', 'Kata sandi baru minimal 6 huruf.');
  const inst = needTenant(req, res);
  if (!inst) return;
  const q = await pool.query(
    "UPDATE users SET password_hash=$1 WHERE id=$2 AND institution_id=$3 AND role <> 'superadmin' RETURNING id",
    [await bcrypt.hash(p.password, 10), req.params.id, inst]
  );
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Pengguna tak ditemukan.');
  await audit(req, 'update', 'users', Number(req.params.id));
  ok(res, null, 'Kata sandi pengguna diganti. Berikan sandi baru itu kepadanya.');
}

// ---- KOP SURAT ----
async function listLetterheads(req, res) {
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  ok(res, (await pool.query('SELECT * FROM letterhead_templates WHERE institution_id=$1 ORDER BY id', [inst])).rows);
}
async function createLetterhead(req, res) {
  const p = z.object({ name: z.string().min(1), paper_size: z.enum(['A4', 'F4']), header_markdown: z.string().min(1), is_default: z.boolean().optional() }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  if (p.is_default) await pool.query('UPDATE letterhead_templates SET is_default=false WHERE institution_id=$1', [inst]);
  const q = await pool.query(
    'INSERT INTO letterhead_templates(institution_id,name,paper_size,header_markdown,is_default) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [inst, p.name, p.paper_size, p.header_markdown, !!p.is_default]
  );
  ok(res, q.rows[0], 'Template kop disimpan.');
}

// Baris pemerintah di kop dipakai semua ujian; ukuran kertas hanya mengubah margin.
async function updateLetterhead(req, res) {
  const p = z.object({ header_markdown: z.string().max(300) }).parse(req.body);
  const inst = needTenant(req, res);
  if (!inst) return;
  const isi = p.header_markdown.split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
  const q = await pool.query('UPDATE letterhead_templates SET header_markdown=$1 WHERE institution_id=$2 RETURNING id', [isi, inst]);
  if (!q.rowCount) {
    await pool.query("INSERT INTO letterhead_templates(institution_id,name,paper_size,header_markdown,is_default) VALUES($1,'Kop sekolah','A4',$2,true),($1,'Kop sekolah','F4',$2,true)", [inst, isi]);
  }
  await audit(req, 'update', 'letterheads', inst);
  ok(res, { header_markdown: isi }, 'Kop surat disimpan.');
}

// ---- KELAS ----
// Kelas (dan siswanya) hanya boleh disentuh sekolah pemiliknya.
async function kelasMilik(inst, classId) {
  const r = await pool.query('SELECT id FROM classes WHERE id=$1 AND institution_id=$2', [classId, inst]);
  return r.rowCount > 0;
}
async function listClasses(req, res) {
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  ok(res, (await pool.query('SELECT * FROM classes WHERE institution_id=$1 ORDER BY academic_year DESC, level, name', [inst])).rows);
}
async function createClass(req, res) {
  const p = z.object({ name: z.string().min(1), academic_year: z.string().min(4), jenjang: z.enum(['SD', 'SMP', 'SMA']), level: z.number().int().min(1).max(12) }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const q = await pool.query('INSERT INTO classes(institution_id,name,academic_year,jenjang,level) VALUES($1,$2,$3,$4,$5) RETURNING *', [inst, p.name, p.academic_year, p.jenjang, p.level]);
  ok(res, q.rows[0], 'Kelas dibuat.');
}
async function updateClass(req, res) {
  const p = z.object({ name: z.string().min(1), academic_year: z.string().min(4), jenjang: z.enum(['SD', 'SMP', 'SMA']), level: z.number().int().min(1).max(12) }).parse(req.body);
  const inst = needTenant(req, res);
  if (!inst) return;
  const q = await pool.query('UPDATE classes SET name=$1, academic_year=$2, jenjang=$3, level=$4 WHERE id=$5 AND institution_id=$6 RETURNING *', [p.name, p.academic_year, p.jenjang, p.level, req.params.id, inst]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Kelas tak ada.');
  ok(res, q.rows[0], 'Kelas diubah.');
}
async function deleteClass(req, res) {
  const inst = needTenant(req, res);
  if (!inst) return;
  if (!(await kelasMilik(inst, req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Kelas tak ada.');
  const isi = await pool.query('SELECT COUNT(*) AS n FROM students WHERE class_id=$1 AND is_active=true', [req.params.id]);
  if (Number(isi.rows[0].n) > 0) return fail(res, 400, 'VALIDATION_ERROR', 'Kelas masih berisi siswa, kosongkan dulu.');
  try {
    const q = await pool.query('DELETE FROM classes WHERE id=$1 RETURNING id', [req.params.id]);
    if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Kelas tak ada.');
    await audit(req, 'delete', 'classes', req.params.id);
    ok(res, null, 'Kelas dihapus.');
  } catch (e) {
    // Ujian dan profil guru menahan kelas lewat foreign key.
    if (e.code === '23503') return fail(res, 400, 'VALIDATION_ERROR', 'Kelas ini masih dipakai ujian atau profil guru. Pindahkan dulu pemakainya.');
    throw e;
  }
}

// ---- MATERI: Mapel > Topik > Bab > Subbab ----
// Mapel milik sekolah + tingkat, jadi Matematika kelas 4 dan kelas 5 adalah dua
// baris. Nama dicocokkan tanpa peduli besar/kecil huruf dan spasinya dirapikan.
const rapiNama = (s) => s.trim().replace(/\s+/g, ' ');

async function listSubjects(req, res) {
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  const g = req.query.grade_level ? Number(req.query.grade_level) : null;
  const q = g
    ? await pool.query('SELECT * FROM subjects WHERE institution_id=$1 AND grade_level=$2 ORDER BY name', [inst, g])
    : await pool.query('SELECT * FROM subjects WHERE institution_id=$1 ORDER BY grade_level NULLS LAST, name', [inst]);
  ok(res, q.rows);
}
async function createSubject(req, res) {
  const p = z.object({ name: z.string().min(1), grade_level: z.number().int().min(1).max(12) }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const name = rapiNama(p.name);
  const ada = await pool.query('SELECT id FROM subjects WHERE institution_id=$1 AND grade_level=$2 AND lower(name)=lower($3)', [inst, p.grade_level, name]);
  if (ada.rowCount) return fail(res, 400, 'VALIDATION_ERROR', `Mapel ${name} untuk tingkat ${p.grade_level} sudah ada.`);
  ok(res, (await pool.query('INSERT INTO subjects(institution_id,grade_level,name) VALUES($1,$2,$3) RETURNING *', [inst, p.grade_level, name])).rows[0], 'Mapel dibuat.');
}
// Topik milik guru lewat created_by. Topik lama tanpa pemilik tetap terbaca
// sebagai publik; admin sekolah boleh merapikannya, guru lain tidak.
const adminSekolah = (req) => req.user.role === 'superadmin' || req.user.role === 'admin';

// Topik diambil bersama sekolahnya sekaligus: satu query untuk cek izin,
// supaya admin sekolah lain tak bisa menyentuh id yang cuma ditebak.
async function topikMilik(req) {
  return (await pool.query(
    `SELECT t.id, t.subject_id, t.created_by, s.institution_id
       FROM topics t LEFT JOIN subjects s ON s.id=t.subject_id
      WHERE t.id=$1`, [req.params.id])).rows[0];
}

function bolehUbahTopik(req, topik) {
  const sekolahSendiri = topik.institution_id === req.user.institution_id;
  if (!sekolahSendiri && req.user.role !== 'superadmin') return 'asing';
  if (topik.created_by !== req.user.id && !adminSekolah(req)) return 'bukan';
  return null;
}
async function listTopics(req, res) {
  if (!req.query.subject_id) return fail(res, 400, 'VALIDATION_ERROR', 'subject_id wajib.');
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  const admin = req.user.role === 'superadmin' || req.user.role === 'admin';
  const q = admin
    ? await pool.query(`SELECT t.* FROM topics t JOIN subjects s ON s.id=t.subject_id
                         WHERE t.subject_id=$1 AND s.institution_id=$2 ORDER BY t.name`, [req.query.subject_id, inst])
    : await pool.query(`SELECT t.* FROM topics t JOIN subjects s ON s.id=t.subject_id
                         WHERE t.subject_id=$1 AND s.institution_id=$2 AND (t.created_by=$3 OR t.created_by IS NULL)
                         ORDER BY t.name`, [req.query.subject_id, inst, req.user.id]);
  ok(res, q.rows);
}
async function createTopic(req, res) {
  const p = z.object({ subject_id: z.number().int(), name: z.string().min(1) }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const sub = await pool.query('SELECT id FROM subjects WHERE id=$1 AND institution_id=$2', [p.subject_id, inst]);
  if (!sub.rowCount) return fail(res, 404, 'NOT_FOUND', 'Mapel tak ditemukan.');
  const name = rapiNama(p.name);
  // Topik publik lama dengan nama sama dipakai ulang supaya tak ada dua label kembar.
  const ada = await pool.query(
    `SELECT * FROM topics WHERE subject_id=$1 AND lower(name)=lower($2) AND (created_by=$3 OR created_by IS NULL)
      ORDER BY (created_by IS NULL), id LIMIT 1`,
    [p.subject_id, name, req.user.id]
  );
  if (ada.rowCount) return ok(res, ada.rows[0], 'Topik sudah ada.');
  ok(res, (await pool.query('INSERT INTO topics(subject_id,created_by,name) VALUES($1,$2,$3) RETURNING *', [p.subject_id, req.user.id, name])).rows[0], 'Topik dibuat.');
}
async function listChapters(req, res) {
  if (!req.query.topic_id) return fail(res, 400, 'VALIDATION_ERROR', 'topic_id wajib.');
  ok(res, (await pool.query('SELECT * FROM chapters WHERE topic_id=$1 ORDER BY id', [req.query.topic_id])).rows);
}
async function createChapter(req, res) {
  const p = z.object({ topic_id: z.number().int(), name: z.string().min(1) }).parse(req.body);
  ok(res, (await pool.query('INSERT INTO chapters(topic_id,name) VALUES($1,$2) RETURNING *', [p.topic_id, p.name])).rows[0], 'Bab dibuat.');
}
async function listSubchapters(req, res) {
  if (!req.query.chapter_id) return fail(res, 400, 'VALIDATION_ERROR', 'chapter_id wajib.');
  ok(res, (await pool.query('SELECT * FROM sub_chapters WHERE chapter_id=$1 ORDER BY id', [req.query.chapter_id])).rows);
}
async function createSubchapter(req, res) {
  const p = z.object({ chapter_id: z.number().int(), name: z.string().min(1) }).parse(req.body);
  ok(res, (await pool.query('INSERT INTO sub_chapters(chapter_id,name) VALUES($1,$2) RETURNING *', [p.chapter_id, p.name])).rows[0], 'Sub bab dibuat.');
}

// Ubah nama saja (pindah induk = hapus lalu buat ulang, biar tak salah pindah).
async function updateSubject(req, res) {
  const p = z.object({ name: z.string().min(1) }).parse(req.body);
  const inst = needTenant(req, res);
  if (!inst) return;
  const name = rapiNama(p.name);
  const lama = (await pool.query('SELECT id, grade_level FROM subjects WHERE id=$1 AND institution_id=$2', [req.params.id, inst])).rows[0];
  if (!lama) return fail(res, 404, 'NOT_FOUND', 'Mapel tak ada.');
  const kembar = await pool.query(
    'SELECT id FROM subjects WHERE institution_id=$1 AND grade_level=$2 AND lower(name)=lower($3) AND id<>$4',
    [inst, lama.grade_level, name, req.params.id]
  );
  if (kembar.rowCount) return fail(res, 400, 'VALIDATION_ERROR', `Mapel ${name} untuk tingkat itu sudah ada.`);
  const q = await pool.query('UPDATE subjects SET name=$1 WHERE id=$2 RETURNING *', [name, req.params.id]);
  ok(res, q.rows[0], 'Mapel diubah.');
}
async function updateTopic(req, res) {
  const p = z.object({ name: z.string().min(1) }).parse(req.body);
  const name = rapiNama(p.name);
  const lama = await topikMilik(req);
  if (!lama) return fail(res, 404, 'NOT_FOUND', 'Topik tak ada.');
  const tolak = bolehUbahTopik(req, lama);
  if (tolak === 'asing') return fail(res, 404, 'NOT_FOUND', 'Topik tak ada.');
  if (tolak) return fail(res, 403, 'FORBIDDEN', 'Topik ini milik guru lain. Hanya admin sekolah yang bisa mengubahnya.');
  const kembar = await pool.query(
    `SELECT id FROM topics WHERE subject_id=$1 AND lower(name)=lower($2) AND id<>$3
       AND created_by IS NOT DISTINCT FROM $4`,
    [lama.subject_id, name, req.params.id, lama.created_by]
  );
  if (kembar.rowCount) return fail(res, 400, 'VALIDATION_ERROR', `Topik ${name} sudah ada.`);
  const q = await pool.query('UPDATE topics SET name=$1 WHERE id=$2 RETURNING *', [name, req.params.id]);
  ok(res, q.rows[0], 'Topik diubah.');
}
async function updateChapter(req, res) {
  const p = z.object({ name: z.string().min(1) }).parse(req.body);
  const q = await pool.query('UPDATE chapters SET name=$1 WHERE id=$2 RETURNING *', [p.name, req.params.id]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Bab tak ada.');
  ok(res, q.rows[0], 'Bab diubah.');
}
async function updateSubchapter(req, res) {
  const p = z.object({ name: z.string().min(1) }).parse(req.body);
  const q = await pool.query('UPDATE sub_chapters SET name=$1 WHERE id=$2 RETURNING *', [p.name, req.params.id]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Subbab tak ada.');
  ok(res, q.rows[0], 'Subbab diubah.');
}

// Tabel anak memakai ON DELETE CASCADE, tapi questions/sources menahan lewat
// foreign key. Tangkap 23503 dan jadikan pesan yang bisa dibaca guru.
async function hapusBertingkat(req, res, tabel, label) {
  try {
    const q = await pool.query(`DELETE FROM ${tabel} WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', `${label} tak ada.`);
    await audit(req, 'delete', tabel, req.params.id);
    ok(res, null, `${label} dihapus.`);
  } catch (e) {
    if (e.code === '23503') return fail(res, 400, 'VALIDATION_ERROR', `${label} ini masih dipakai soal atau materi. Hapus isinya dulu.`);
    throw e;
  }
}
// Mapel dan topik dibatasi pemiliknya; bab/subbab cukup lewat helper di atas.
async function deleteSubject(req, res) {
  const inst = needTenant(req, res);
  if (!inst) return;
  try {
    const q = await pool.query('DELETE FROM subjects WHERE id=$1 AND institution_id=$2 RETURNING id', [req.params.id, inst]);
    if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Mapel tak ada.');
    await audit(req, 'delete', 'subjects', req.params.id);
    ok(res, null, 'Mapel dihapus.');
  } catch (e) {
    if (e.code === '23503') return fail(res, 400, 'VALIDATION_ERROR', 'Mapel ini masih dipakai soal atau materi. Hapus isinya dulu.');
    throw e;
  }
}
async function deleteTopic(req, res) {
  const lama = await topikMilik(req);
  if (!lama) return fail(res, 404, 'NOT_FOUND', 'Topik tak ada.');
  const tolak = bolehUbahTopik(req, lama);
  if (tolak === 'asing') return fail(res, 404, 'NOT_FOUND', 'Topik tak ada.');
  if (tolak) return fail(res, 403, 'FORBIDDEN', 'Topik ini milik guru lain. Hanya admin sekolah yang bisa menghapusnya.');
  return hapusBertingkat(req, res, 'topics', 'Topik');
}
const deleteChapter = (req, res) => hapusBertingkat(req, res, 'chapters', 'Bab');
const deleteSubchapter = (req, res) => hapusBertingkat(req, res, 'sub_chapters', 'Subbab');

// ---- RINGKASAN DASHBOARD ----
// Satu query: dashboard cukup sekali panggil, tak perlu mengunduh ratusan baris.
async function stats(req, res) {
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  ok(res, (await pool.query(`
    SELECT
      (SELECT name FROM institutions WHERE id=$1) AS sekolah,
      (SELECT npsn FROM institutions WHERE id=$1) AS npsn,
      (SELECT COUNT(*) FROM subjects WHERE institution_id=$1)::int AS mapel,
      (SELECT COUNT(*) FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE s.institution_id=$1)::int AS topik,
      (SELECT COUNT(*) FROM questions WHERE institution_id=$1)::int AS soal,
      (SELECT COUNT(*) FROM exams WHERE institution_id=$1)::int AS ujian
  `, [inst])).rows[0]);
}

module.exports = {
  listInstitutions, createInstitution, updateInstitution, uploadLogos, listUsers, createUser, updateUser, resetUserPassword,
  listLetterheads, createLetterhead, updateLetterhead, listClasses, createClass, updateClass, deleteClass,
  listSubjects, createSubject, updateSubject, deleteSubject, listTopics, createTopic, updateTopic, deleteTopic,
  listChapters, createChapter, updateChapter, deleteChapter, listSubchapters, createSubchapter, updateSubchapter, deleteSubchapter,
  stats,
};
