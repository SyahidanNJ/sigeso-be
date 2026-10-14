const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { auth, roles } = require('../middleware/auth');
const { needTenant } = require('../lib/scope');

const r = express.Router();
r.use(auth);

async function audit(req, action, entity, entity_id, meta) {
  try {
    await pool.query(
      'INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [req.requestId || null, req.user.id, req.user.institution_id, action, entity, entity_id, meta || null]
    );
  } catch { /* audit tak boleh menggagalkan aksi */ }
}

const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---- INSTITUSI (superadmin kelola penuh, lainnya baca milik sendiri) ----
r.get('/institutions', asyncH(async (req, res) => {
  const q = req.user.role === 'superadmin' && !req.query.institution_id
    ? await pool.query('SELECT * FROM institutions ORDER BY id')
    : await pool.query('SELECT * FROM institutions WHERE id=$1', [req.user.institution_id]);
  ok(res, q.rows);
}));
r.post('/institutions', roles('superadmin'), asyncH(async (req, res) => {
  const p = z.object({ name: z.string().min(1), address: z.string().optional(), npsn: z.string().optional() }).parse(req.body);
  const q = await pool.query('INSERT INTO institutions(name,address,npsn) VALUES($1,$2,$3) RETURNING *', [p.name, p.address || null, p.npsn || null]);
  await audit(req, 'create', 'institutions', q.rows[0].id);
  ok(res, q.rows[0], 'Institusi dibuat.');
}));

// ---- PENGGUNA (admin kelola guru di institusinya) ----
r.get('/users', roles('superadmin', 'admin'), asyncH(async (req, res) => {
  const inst = req.user.role === 'superadmin' ? req.query.institution_id || null : req.user.institution_id;
  const q = inst
    ? await pool.query('SELECT id,name,email,role,institution_id,is_active FROM users WHERE institution_id=$1 ORDER BY id', [inst])
    : await pool.query('SELECT id,name,email,role,institution_id,is_active FROM users ORDER BY id');
  ok(res, q.rows);
}));
r.post('/users', roles('superadmin', 'admin'), asyncH(async (req, res) => {
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
}));

// ---- KOP SURAT ----
r.get('/letterheads', asyncH(async (req, res) => {
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  ok(res, (await pool.query('SELECT * FROM letterhead_templates WHERE institution_id=$1 ORDER BY id', [inst])).rows);
}));
r.post('/letterheads', roles('superadmin', 'admin'), asyncH(async (req, res) => {
  const p = z.object({ name: z.string().min(1), paper_size: z.enum(['A4', 'F4']), header_markdown: z.string().min(1), is_default: z.boolean().optional() }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  if (p.is_default) await pool.query('UPDATE letterhead_templates SET is_default=false WHERE institution_id=$1', [inst]);
  const q = await pool.query(
    'INSERT INTO letterhead_templates(institution_id,name,paper_size,header_markdown,is_default) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [inst, p.name, p.paper_size, p.header_markdown, !!p.is_default]
  );
  ok(res, q.rows[0], 'Template kop disimpan.');
}));

// ---- KELAS ----
r.get('/classes', asyncH(async (req, res) => {
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  ok(res, (await pool.query('SELECT * FROM classes WHERE institution_id=$1 ORDER BY academic_year DESC,name', [inst])).rows);
}));
r.post('/classes', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const p = z.object({ name: z.string().min(1), academic_year: z.string().min(4), level: z.number().int() }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const q = await pool.query('INSERT INTO classes(institution_id,name,academic_year,level) VALUES($1,$2,$3,$4) RETURNING *', [inst, p.name, p.academic_year, p.level]);
  ok(res, q.rows[0], 'Kelas dibuat.');
}));

// ---- SISWA (+ impor JSON dari CSV yang diparsing di FE) ----
r.get('/students', asyncH(async (req, res) => {
  if (!req.query.class_id) return fail(res, 400, 'VALIDATION_ERROR', 'class_id wajib.');
  ok(res, (await pool.query('SELECT * FROM students WHERE class_id=$1 AND is_active=true ORDER BY name', [req.query.class_id])).rows);
}));
r.post('/students', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const p = z.object({ class_id: z.number().int(), name: z.string().min(1), nis: z.string().min(1) }).parse(req.body);
  const q = await pool.query('INSERT INTO students(class_id,name,nis) VALUES($1,$2,$3) RETURNING *', [p.class_id, p.name, p.nis]);
  ok(res, q.rows[0], 'Siswa ditambahkan.');
}));
r.post('/students/import', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const p = z.object({ class_id: z.number().int(), rows: z.array(z.object({ name: z.string().min(1), nis: z.string().min(1) })).max(200) }).parse(req.body);
  let n = 0;
  for (const s of p.rows) {
    await pool.query('INSERT INTO students(class_id,name,nis) VALUES($1,$2,$3) ON CONFLICT(class_id,nis) DO UPDATE SET name=EXCLUDED.name,is_active=true', [p.class_id, s.name, s.nis]);
    n++;
  }
  await audit(req, 'import', 'students', p.class_id, { count: n });
  ok(res, { imported: n }, `${n} siswa diimpor.`);
}));

// ---- MATERI: Mapel > Topik > Bab > Subbab ----
r.get('/subjects', asyncH(async (req, res) => {
  const inst = needTenant(req, res, req.query.institution_id);
  if (!inst) return;
  ok(res, (await pool.query('SELECT * FROM subjects WHERE institution_id=$1 ORDER BY name', [inst])).rows);
}));
r.post('/subjects', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const p = z.object({ name: z.string().min(1) }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  ok(res, (await pool.query('INSERT INTO subjects(institution_id,name) VALUES($1,$2) RETURNING *', [inst, p.name])).rows[0], 'Mapel dibuat.');
}));
r.get('/topics', asyncH(async (req, res) => {
  if (!req.query.subject_id) return fail(res, 400, 'VALIDATION_ERROR', 'subject_id wajib.');
  ok(res, (await pool.query('SELECT * FROM topics WHERE subject_id=$1 ORDER BY grade_level,name', [req.query.subject_id])).rows);
}));
r.post('/topics', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const p = z.object({ subject_id: z.number().int(), grade_level: z.number().int(), name: z.string().min(1) }).parse(req.body);
  ok(res, (await pool.query('INSERT INTO topics(subject_id,grade_level,name) VALUES($1,$2,$3) RETURNING *', [p.subject_id, p.grade_level, p.name])).rows[0], 'Topik dibuat.');
}));
r.get('/chapters', asyncH(async (req, res) => {
  if (!req.query.topic_id) return fail(res, 400, 'VALIDATION_ERROR', 'topic_id wajib.');
  ok(res, (await pool.query('SELECT * FROM chapters WHERE topic_id=$1 ORDER BY id', [req.query.topic_id])).rows);
}));
r.post('/chapters', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const p = z.object({ topic_id: z.number().int(), name: z.string().min(1) }).parse(req.body);
  ok(res, (await pool.query('INSERT INTO chapters(topic_id,name) VALUES($1,$2) RETURNING *', [p.topic_id, p.name])).rows[0], 'Bab dibuat.');
}));
r.get('/subchapters', asyncH(async (req, res) => {
  if (!req.query.chapter_id) return fail(res, 400, 'VALIDATION_ERROR', 'chapter_id wajib.');
  ok(res, (await pool.query('SELECT * FROM sub_chapters WHERE chapter_id=$1 ORDER BY id', [req.query.chapter_id])).rows);
}));
r.post('/subchapters', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const p = z.object({ chapter_id: z.number().int(), name: z.string().min(1) }).parse(req.body);
  ok(res, (await pool.query('INSERT INTO sub_chapters(chapter_id,name) VALUES($1,$2) RETURNING *', [p.chapter_id, p.name])).rows[0], 'Sub bab dibuat.');
}));

module.exports = r;
