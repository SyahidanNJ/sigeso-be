const express = require('express');
const fs = require('fs');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { auth, roles } = require('../middleware/auth');
const { needTenant } = require('../lib/scope');
const { AppError } = require('../lib/errors');
const { generateText } = require('../services/llm');
const { GeneratedSet, buildGeneratePrompt, parseJson } = require('../services/llm/prompts');

const r = express.Router();
r.use(auth);
const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const GURU = ['superadmin', 'admin', 'guru'];

// ---- BANK SOAL (reusable) ----
r.get('/questions', asyncH(async (req, res) => {
  const f = [];
  const v = [];
  let i = 1;
  for (const k of ['subject_id', 'topic_id', 'chapter_id', 'sub_chapter_id']) {
    if (req.query[k]) { f.push(`${k}=$${i++}`); v.push(req.query[k]); }
  }
  if (req.user.role !== 'superadmin') { f.push(`institution_id=$${i++}`); v.push(req.user.institution_id); }
  const where = f.length ? 'WHERE ' + f.join(' AND ') : '';
  ok(res, (await pool.query(`SELECT * FROM questions ${where} ORDER BY id DESC LIMIT 200`, v)).rows);
}));
r.post('/questions', roles(...GURU), asyncH(async (req, res) => {
  const p = z.object({
    subject_id: z.number().int().optional(), topic_id: z.number().int().optional(),
    chapter_id: z.number().int().optional(), sub_chapter_id: z.number().int().optional(),
    qtype: z.enum(['PG', 'ISIAN', 'URAIAN']), text: z.string().min(1),
    options: z.array(z.string()).optional(), answer_key: z.string().min(1),
    weight: z.number().positive().optional(), rubric: z.string().optional(),
    difficulty: z.enum(['mudah', 'sedang', 'sukar']).optional(),
  }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const q = await pool.query(
    'INSERT INTO questions(institution_id,subject_id,topic_id,chapter_id,sub_chapter_id,qtype,text,options,answer_key,weight,rubric,difficulty,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
    [inst, p.subject_id || null, p.topic_id || null, p.chapter_id || null, p.sub_chapter_id || null, p.qtype, p.text, p.options ? JSON.stringify(p.options) : null, p.answer_key, p.weight || 1, p.rubric || null, p.difficulty || 'sedang', req.user.id]
  );
  ok(res, q.rows[0], 'Soal masuk bank.');
}));
r.delete('/questions/:id', roles(...GURU), asyncH(async (req, res) => {
  await pool.query('DELETE FROM questions WHERE id=$1', [req.params.id]);
  ok(res, null, 'Soal dihapus.');
}));

// ---- GENERATE VIA LLM (sinkron; shortcut: pindah ke pg-boss bila konkuren naik) ----
r.post('/generate', roles(...GURU), asyncH(async (req, res) => {
  const p = z.object({
    sub_chapter_id: z.number().int().optional(), topic_id: z.number().int().optional(),
    count: z.number().int().min(1).max(20), qtypes: z.array(z.enum(['PG', 'ISIAN', 'URAIAN'])).min(1),
    difficulty: z.enum(['mudah', 'sedang', 'sukar']),
  }).parse(req.body);
  const t0 = Date.now();
  const job = (await pool.query("INSERT INTO app_jobs(request_id,job_type,status) VALUES($1,'generate','processing') RETURNING id", [res.locals.requestId])).rows[0];

  try {
    const s = p.sub_chapter_id
      ? await pool.query("SELECT extracted_path FROM sources WHERE sub_chapter_id=$1 AND status='done' ORDER BY id DESC LIMIT 3", [p.sub_chapter_id])
      : await pool.query("SELECT s.extracted_path FROM sources s JOIN sub_chapters sc ON sc.id=s.sub_chapter_id JOIN chapters c ON c.id=sc.chapter_id WHERE c.topic_id=$1 AND s.status='done' ORDER BY s.id DESC LIMIT 3", [p.topic_id]);
    if (!s.rowCount) throw new AppError('VALIDATION_ERROR', 'Belum ada sumber materi untuk topik ini. Unggah materi dulu.');
    const materi = s.rows.map((x) => { try { return fs.readFileSync(x.extracted_path, 'utf8'); } catch { return ''; } }).join('\n').slice(0, 15000);

    const raw = await generateText(buildGeneratePrompt({ materi, count: p.count, qtypes: p.qtypes, difficulty: p.difficulty }), {});
    const parsed = GeneratedSet.parse(parseJson(raw));
    const inst = req.user.role === 'superadmin' ? req.user.institution_id : req.user.institution_id;
    const saved = [];
    for (const g of parsed.questions) {
      const q = await pool.query(
        'INSERT INTO questions(institution_id,topic_id,sub_chapter_id,qtype,text,options,answer_key,weight,rubric,difficulty,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [inst, p.topic_id || null, p.sub_chapter_id || null, g.qtype, g.text, g.options ? JSON.stringify(g.options) : null, g.answer_key, g.weight, g.rubric || null, g.difficulty, req.user.id]
      );
      saved.push(q.rows[0]);
    }
    await pool.query("UPDATE app_jobs SET status='success',progress=100,result=$1 WHERE id=$2", [JSON.stringify({ count: saved.length }), job.id]);
    await pool.query('INSERT INTO llm_usage_logs(request_id,user_id,institution_id,feature,model,duration_ms,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [res.locals.requestId, req.user.id, inst, 'generate', process.env.LLM_DEFAULT_MODEL, Date.now() - t0, 'success']);
    ok(res, saved, `${saved.length} soal dibuat. Cek dan edit sebelum dipakai.`);
  } catch (e) {
    await pool.query('UPDATE app_jobs SET status=$1,error=$2 WHERE id=$3', ['failed', String(e.message).slice(0, 500), job.id]);
    if (e instanceof z.ZodError) throw new AppError('LLM_INVALID_JSON', 'Output LLM tak valid, coba lagi.');
    throw e;
  }
}));

// ---- UJIAN (jumlah soal bebas: ditempel dari bank) ----
r.get('/exams', asyncH(async (req, res) => {
  const inst = req.user.role === 'superadmin' ? req.query.institution_id || null : req.user.institution_id;
  const q = inst
    ? await pool.query('SELECT e.*, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS n_soal FROM exams e WHERE institution_id=$1 ORDER BY id DESC', [inst])
    : await pool.query('SELECT e.*, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS n_soal FROM exams e ORDER BY id DESC');
  ok(res, q.rows);
}));
r.post('/exams', roles(...GURU), asyncH(async (req, res) => {
  const p = z.object({ title: z.string().min(1), class_id: z.number().int(), subject_id: z.number().int().optional(), mode: z.enum(['SATU_LEMBAR', 'TERPISAH', 'HEMAT']).optional(), paper_size: z.enum(['A4', 'F4']).optional() }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const q = await pool.query('INSERT INTO exams(institution_id,subject_id,class_id,title,mode,paper_size,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [inst, p.subject_id || null, p.class_id, p.title, p.mode || 'SATU_LEMBAR', p.paper_size || 'A4', req.user.id]);
  ok(res, q.rows[0], 'Ujian dibuat. Pilih soal dari bank.');
}));
r.get('/exams/:id/items', asyncH(async (req, res) => {
  ok(res, (await pool.query('SELECT q.*, eq.nomor, COALESCE(eq.weight_override,q.weight) AS bobot FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=$1 ORDER BY eq.nomor', [req.params.id])).rows);
}));
r.put('/exams/:id/items', roles(...GURU), asyncH(async (req, res) => {
  const p = z.object({ question_ids: z.array(z.number().int()).max(100) }).parse(req.body);
  await pool.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
  let no = 1;
  for (const qid of p.question_ids) {
    await pool.query('INSERT INTO exam_questions(exam_id,question_id,nomor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, qid, no++]);
  }
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'set-items', 'exams', req.params.id, { count: p.question_ids.length }]);
  ok(res, { count: p.question_ids.length }, 'Soal ujian disimpan.');
}));

// ---- PEMAKAIAN LLM ----
r.get('/llm-usage', roles('superadmin', 'admin'), asyncH(async (req, res) => {
  const q = req.user.role === 'superadmin' && !req.query.institution_id
    ? await pool.query('SELECT * FROM llm_usage_logs ORDER BY id DESC LIMIT 100')
    : await pool.query('SELECT * FROM llm_usage_logs WHERE institution_id=$1 ORDER BY id DESC LIMIT 100', [req.query.institution_id || req.user.institution_id]);
  ok(res, q.rows);
}));

module.exports = r;
