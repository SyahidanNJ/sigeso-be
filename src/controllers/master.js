const bcrypt = require('bcryptjs');
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
  const hash = await bcrypt.hash(p.password, 10);
  const q = await pool.query(
    'INSERT INTO users(institution_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,institution_id',
    [inst, p.name, p.email, hash, p.role]
  );
  await audit(req, 'create', 'users', q.rows[0].id);
  ok(res, q.rows[0], 'Pengguna dibuat.');
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

// ---- KELAS ----
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
  const q = await pool.query('UPDATE classes SET name=$1, academic_year=$2, jenjang=$3, level=$4 WHERE id=$5 RETURNING *', [p.name, p.academic_year, p.jenjang, p.level, req.params.id]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Kelas tak ada.');
  ok(res, q.rows[0], 'Kelas diubah.');
}
async function deleteClass(req, res) {
  const isi = await pool.query('SELECT COUNT(*) AS n FROM students WHERE class_id=$1 AND is_active=true', [req.params.id]);
  if (Number(isi.rows[0].n) > 0) return fail(res, 400, 'VALIDATION_ERROR', 'Kelas masih berisi siswa, kosongkan dulu.');
  const q = await pool.query('DELETE FROM classes WHERE id=$1 RETURNING id', [req.params.id]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Kelas tak ada.');
  await audit(req, 'delete', 'classes', req.params.id);
  ok(res, null, 'Kelas dihapus.');
}

// ---- SISWA (+ impor JSON dari CSV yang diparsing di FE) ----
async function listStudents(req, res) {
  if (!req.query.class_id) return fail(res, 400, 'VALIDATION_ERROR', 'class_id wajib.');
  ok(res, (await pool.query('SELECT * FROM students WHERE class_id=$1 AND is_active=true ORDER BY name', [req.query.class_id])).rows);
}
async function createStudent(req, res) {
  const p = z.object({ class_id: z.number().int(), name: z.string().min(1), nis: z.string().min(1) }).parse(req.body);
  const q = await pool.query('INSERT INTO students(class_id,name,nis) VALUES($1,$2,$3) RETURNING *', [p.class_id, p.name, p.nis]);
  ok(res, q.rows[0], 'Siswa ditambahkan.');
}
async function updateStudent(req, res) {
  const p = z.object({ name: z.string().min(1), nis: z.string().min(1) }).parse(req.body);
  const q = await pool.query('UPDATE students SET name=$1, nis=$2 WHERE id=$3 AND is_active=true RETURNING *', [p.name, p.nis, req.params.id]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Siswa tak ada.');
  ok(res, q.rows[0], 'Siswa diubah.');
}
async function deleteStudent(req, res) {
  const q = await pool.query('UPDATE students SET is_active=false WHERE id=$1 AND is_active=true RETURNING id', [req.params.id]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Siswa tak ada.');
  await audit(req, 'delete', 'students', req.params.id);
  ok(res, null, 'Siswa dihapus. Nilai yang sudah ada tetap tersimpan.');
}
// Dipakai dua jalur: tempel data dan unggah .xlsx. NIS sama di kelas yang sama
// hanya diperbarui namanya, jadi impor aman diulang.
async function sisipkanSiswa(class_id, rows) {
  let n = 0;
  for (const s of rows) {
    await pool.query('INSERT INTO students(class_id,name,nis) VALUES($1,$2,$3) ON CONFLICT(class_id,nis) DO UPDATE SET name=EXCLUDED.name,is_active=true', [class_id, s.name, s.nis]);
    n++;
  }
  return n;
}

async function importStudents(req, res) {
  const p = z.object({ class_id: z.number().int(), rows: z.array(z.object({ name: z.string().min(1), nis: z.string().min(1) })).max(200) }).parse(req.body);
  const n = await sisipkanSiswa(p.class_id, p.rows);
  await audit(req, 'import', 'students', p.class_id, { count: n });
  ok(res, { imported: n }, `${n} siswa diimpor.`);
}

// Kolom dicari dari judulnya (Nama/NIS); kalau tak ada judul, anggap A=nama, B=NIS.
async function importStudentsFile(req, res) {
  const class_id = Number(req.body.class_id);
  if (!req.file) return fail(res, 400, 'VALIDATION_ERROR', 'Berkas .xlsx wajib.');
  if (!class_id) return fail(res, 400, 'VALIDATION_ERROR', 'Pilih kelasnya dulu.');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); } catch { return fail(res, 400, 'VALIDATION_ERROR', 'Berkas tidak bisa dibaca sebagai .xlsx.'); }
  const ws = wb.worksheets[0];
  if (!ws) return fail(res, 400, 'VALIDATION_ERROR', 'Berkas tidak punya lembar kerja.');
  const kepala = (ws.getRow(1).values || []).slice(1).map((v) => String(v ?? '').trim().toLowerCase());
  let iNama = kepala.findIndex((h) => h.includes('nama'));
  let iNis = kepala.findIndex((h) => h.includes('nis'));
  let mulai = 2;
  if (iNama < 0 || iNis < 0) { iNama = 0; iNis = 1; mulai = 1; }
  const rows = [];
  for (let r = mulai; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = String(row.getCell(iNama + 1).text || '').trim();
    const nis = String(row.getCell(iNis + 1).text || '').trim();
    if (!name && !nis) continue;
    if (!name || !nis) return fail(res, 400, 'VALIDATION_ERROR', `Baris ${r}: nama dan NIS harus terisi dua-duanya.`);
    rows.push({ name, nis });
  }
  if (!rows.length) return fail(res, 400, 'VALIDATION_ERROR', 'Tidak ada baris yang bisa diimpor.');
  if (rows.length > 200) return fail(res, 400, 'VALIDATION_ERROR', `Ada ${rows.length} baris; maksimal 200 sekali impor.`);
  const n = await sisipkanSiswa(class_id, rows);
  await audit(req, 'import', 'students', class_id, { count: n, berkas: req.file.originalname });
  ok(res, { imported: n }, `${n} siswa diimpor.`);
}

// ---- MATERI: Mapel > Topik > Bab > Subbab ----
async function listSubjects(req, res) {
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  ok(res, (await pool.query('SELECT * FROM subjects WHERE institution_id=$1 ORDER BY name', [inst])).rows);
}
async function createSubject(req, res) {
  const p = z.object({ name: z.string().min(1) }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  ok(res, (await pool.query('INSERT INTO subjects(institution_id,name) VALUES($1,$2) RETURNING *', [inst, p.name])).rows[0], 'Mapel dibuat.');
}
async function listTopics(req, res) {
  if (!req.query.subject_id) return fail(res, 400, 'VALIDATION_ERROR', 'subject_id wajib.');
  const g = req.query.grade_level ? Number(req.query.grade_level) : null;
  const q = g
    ? await pool.query('SELECT * FROM topics WHERE subject_id=$1 AND grade_level=$2 ORDER BY name', [req.query.subject_id, g])
    : await pool.query('SELECT * FROM topics WHERE subject_id=$1 ORDER BY grade_level,name', [req.query.subject_id]);
  ok(res, q.rows);
}
async function createTopic(req, res) {
  const p = z.object({ subject_id: z.number().int(), grade_level: z.number().int().min(1).max(12), name: z.string().min(1) }).parse(req.body);
  ok(res, (await pool.query('INSERT INTO topics(subject_id,grade_level,name) VALUES($1,$2,$3) RETURNING *', [p.subject_id, p.grade_level, p.name])).rows[0], 'Topik dibuat.');
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
  const q = await pool.query('UPDATE subjects SET name=$1 WHERE id=$2 RETURNING *', [p.name, req.params.id]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Mapel tak ada.');
  ok(res, q.rows[0], 'Mapel diubah.');
}
async function updateTopic(req, res) {
  const p = z.object({ name: z.string().min(1) }).parse(req.body);
  const q = await pool.query('UPDATE topics SET name=$1 WHERE id=$2 RETURNING *', [p.name, req.params.id]);
  if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Topik tak ada.');
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
const deleteSubject = (req, res) => hapusBertingkat(req, res, 'subjects', 'Mapel');
const deleteTopic = (req, res) => hapusBertingkat(req, res, 'topics', 'Topik');
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
      (SELECT COUNT(*) FROM classes WHERE institution_id=$1)::int AS kelas,
      (SELECT COUNT(*) FROM students s JOIN classes c ON c.id=s.class_id WHERE c.institution_id=$1 AND s.is_active)::int AS siswa,
      (SELECT COUNT(*) FROM subjects WHERE institution_id=$1)::int AS mapel,
      (SELECT COUNT(*) FROM sources WHERE institution_id=$1)::int AS materi,
      (SELECT COUNT(*) FROM questions WHERE institution_id=$1)::int AS soal,
      (SELECT COUNT(*) FROM exams WHERE institution_id=$1)::int AS ujian,
      (SELECT COUNT(*) FROM exam_sheets sh JOIN exams e ON e.id=sh.exam_id WHERE e.institution_id=$1)::int AS lembar,
      (SELECT COUNT(*) FROM submissions su JOIN exam_sheets sh ON sh.id=su.sheet_id JOIN exams e ON e.id=sh.exam_id
        WHERE e.institution_id=$1 AND su.status='needs_review')::int AS perlu_koreksi,
      (SELECT COUNT(*) FROM submissions su JOIN exam_sheets sh ON sh.id=su.sheet_id JOIN exams e ON e.id=sh.exam_id
        WHERE e.institution_id=$1 AND su.status='final')::int AS sudah_final,
      -- Rincian untuk dashboard: kelas mana saja + jumlah siswanya, mapel mana saja + jumlah soalnya.
      (SELECT COALESCE(json_agg(x ORDER BY x.nama), '[]'::json) FROM (
        SELECT c.name AS nama,
          (SELECT COUNT(*) FROM students st WHERE st.class_id=c.id AND st.is_active)::int AS siswa
        FROM classes c WHERE c.institution_id=$1
      ) x) AS kelas_rinci,
      (SELECT COALESCE(json_agg(y ORDER BY y.nama), '[]'::json) FROM (
        SELECT su.name AS nama,
          (SELECT COUNT(*) FROM questions q WHERE q.subject_id=su.id)::int AS soal
        FROM subjects su WHERE su.institution_id=$1
      ) y) AS mapel_rinci
  `, [inst])).rows[0]);
}

module.exports = {
  listInstitutions, createInstitution, updateInstitution, listUsers, createUser,
  listLetterheads, createLetterhead, listClasses, createClass, updateClass, deleteClass,
  listStudents, createStudent, updateStudent, deleteStudent, importStudents, importStudentsFile,
  listSubjects, createSubject, updateSubject, deleteSubject, listTopics, createTopic, updateTopic, deleteTopic,
  listChapters, createChapter, updateChapter, deleteChapter, listSubchapters, createSubchapter, updateSubchapter, deleteSubchapter,
  stats,
};
