const fs = require('fs');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { needTenant, tenantId, ujianMilik } = require('../lib/scope');
const { audit } = require('./bantuan');
const { AppError } = require('../lib/errors');
const { relDiUploads, hapusBerkasRel } = require('../lib/berkas');
const { generateText } = require('../services/llm');
const { GeneratedSet, buildGeneratePrompt, parseJson } = require('../services/llm/prompts');

// ---- BANK SOAL (reusable) ----
// Ikut membawa nama mapel/tingkat/subbab supaya daftar soal bisa dikelompokkan dan
// disaring per materi di layar.
async function listQuestions(req, res) {
  const f = [];
  const v = [];
  let i = 1;
  for (const k of ['subject_id', 'topic_id', 'chapter_id', 'sub_chapter_id']) {
    if (req.query[k]) { f.push(`q.${k}=$${i++}`); v.push(req.query[k]); }
  }
  // Pencarian teks berlaku lintas subbab, jadi kata kunci tetap ketemu di soal lama.
  if (req.query.q) { f.push(`q.text ILIKE $${i++}`); v.push(`%${req.query.q}%`); }
  // Halaman berikutnya ke arah soal lama; dipakai tombol "muat 200 sebelumnya".
  if (req.query.before_id) { f.push(`q.id < $${i++}`); v.push(req.query.before_id); }
  if (req.user.role !== 'superadmin') { f.push(`q.institution_id=$${i++}`); v.push(req.user.institution_id); }
  const where = f.length ? 'WHERE ' + f.join(' AND ') : '';
  ok(res, (await pool.query(
    `SELECT q.*, m.name AS mapel, t.grade_level AS tingkat, sc.name AS subbab
       FROM questions q
       LEFT JOIN subjects m ON m.id = q.subject_id
       LEFT JOIN sub_chapters sc ON sc.id = q.sub_chapter_id
       LEFT JOIN chapters c ON c.id = sc.chapter_id
       LEFT JOIN topics t ON t.id = COALESCE(q.topic_id, c.topic_id)
       ${where} ORDER BY q.id DESC LIMIT 200`, v)).rows);
}
// Kunci PG harus satu huruf yang benar-benar ada di daftar pilihan. Kunci salah
// format membuat penilaian otomatis ikut salah tanpa suara, jadi ditahan di sini
// (aturan sama dengan GeneratedQ di services/llm/prompts.js).
function rapikanKunci(qtype, options, answerKey) {
  if (qtype !== 'PG') return answerKey.trim();
  const huruf = String(answerKey).trim().toUpperCase();
  if (!/^[A-Z]$/.test(huruf) || !options || options.length < 2 || huruf.charCodeAt(0) - 64 > options.length) {
    throw new AppError('VALIDATION_ERROR', 'Soal pilihan ganda butuh minimal 2 pilihan, dan kuncinya satu huruf dari daftar itu (A, B, C, ...).');
  }
  return huruf;
}

async function createQuestion(req, res) {
  const p = z.object({
    subject_id: z.number().int().optional(), topic_id: z.number().int().optional(),
    chapter_id: z.number().int().optional(), sub_chapter_id: z.number().int().optional(),
    qtype: z.enum(['PG', 'ISIAN', 'URAIAN']), text: z.string().min(1),
    options: z.array(z.string()).optional(), answer_key: z.string().min(1),
    weight: z.number().positive().optional(), rubric: z.string().optional(),
  }).parse(req.body);
  p.answer_key = rapikanKunci(p.qtype, p.options, p.answer_key);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const q = await pool.query(
    'INSERT INTO questions(institution_id,subject_id,topic_id,chapter_id,sub_chapter_id,qtype,text,options,answer_key,weight,rubric,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
    [inst, p.subject_id || null, p.topic_id || null, p.chapter_id || null, p.sub_chapter_id || null, p.qtype, p.text, p.options ? JSON.stringify(p.options) : null, p.answer_key, p.weight || 1, p.rubric || null, req.user.id]
  );
  ok(res, q.rows[0], 'Soal masuk bank.');
}
// Isi soal boleh diperbaiki; jenisnya (PG/ISIAN/URAIAN) sengaja tidak bisa diubah.
async function updateQuestion(req, res) {
  const p = z.object({
    text: z.string().min(1), options: z.array(z.string()).optional(),
    answer_key: z.string().min(1), weight: z.number().positive().optional(),
    rubric: z.string().optional(),
  }).parse(req.body);
  const superadmin = req.user.role === 'superadmin';
  const lama = (await pool.query(
    `SELECT qtype FROM questions WHERE id=$1${superadmin ? '' : ' AND institution_id=$2'}`,
    superadmin ? [req.params.id] : [req.params.id, req.user.institution_id]
  )).rows[0];
  if (!lama) return fail(res, 404, 'NOT_FOUND', 'Soal tak ada.');
  const kunci = rapikanKunci(lama.qtype, p.options, p.answer_key);
  // weight/rubric yang tidak dikirim dibiarkan apa adanya (jangan terhapus).
  const q = await pool.query(
    'UPDATE questions SET text=$1, options=$2, answer_key=$3, weight=COALESCE($4,weight), rubric=COALESCE($5,rubric), updated_at=now() WHERE id=$6 RETURNING *',
    [p.text, p.options ? JSON.stringify(p.options) : null, kunci, p.weight ?? null, p.rubric ?? null, req.params.id]
  );
  await audit(req, 'update', 'questions', req.params.id);
  ok(res, q.rows[0], 'Soal diperbarui.');
}
// Saring per sekolah, sama seperti listQuestions. Soal yang sudah dipakai di
// ujian ditahan foreign key exam_questions -> jadikan pesan yang bisa dibaca.
async function deleteQuestion(req, res) {
  const superadmin = req.user.role === 'superadmin';
  try {
    const q = await pool.query(
      `DELETE FROM questions WHERE id=$1${superadmin ? '' : ' AND institution_id=$2'} RETURNING id`,
      superadmin ? [req.params.id] : [req.params.id, req.user.institution_id]
    );
    if (!q.rowCount) return fail(res, 404, 'NOT_FOUND', 'Soal tak ada.');
    await audit(req, 'delete', 'questions', req.params.id);
    ok(res, null, 'Soal dihapus.');
  } catch (e) {
    if (e.code === '23503') return fail(res, 400, 'VALIDATION_ERROR', 'Soal ini sedang dipakai di sebuah ujian. Keluarkan dulu dari ujian itu.');
    throw e;
  }
}

// ---- GENERATE VIA LLM (sinkron; shortcut: pindah ke pg-boss bila konkuren naik) ----
async function generateQuestions(req, res) {
  const p = z.object({
    sub_chapter_id: z.number().int().optional(), topic_id: z.number().int().optional(),
    count: z.number().int().min(1).max(20), qtypes: z.array(z.enum(['PG', 'ISIAN', 'URAIAN'])).min(1),
  }).parse(req.body);
  const t0 = Date.now();
  const job = (await pool.query("INSERT INTO app_jobs(request_id,job_type,status) VALUES($1,'generate','processing') RETURNING id", [res.locals.requestId])).rows[0];

  try {
    // Sumber materi sekaligus pemetaan materi (mapel/bab/sub) untuk soal yang dibuat.
    const sumberSql = `SELECT s.extracted_path, sc.id AS sub_id, c.id AS bab_id, c.topic_id AS topik_id, t.subject_id AS mapel_id
       FROM sources s JOIN sub_chapters sc ON sc.id = s.sub_chapter_id
       JOIN chapters c ON c.id = sc.chapter_id JOIN topics t ON t.id = c.topic_id`;
    const s = p.sub_chapter_id
      ? await pool.query(`${sumberSql} WHERE s.sub_chapter_id=$1 AND s.status='done' ORDER BY s.id DESC LIMIT 3`, [p.sub_chapter_id])
      : await pool.query(`${sumberSql} WHERE c.topic_id=$1 AND s.status='done' ORDER BY s.id DESC LIMIT 3`, [p.topic_id]);
    if (!s.rowCount) throw new AppError('VALIDATION_ERROR', 'Belum ada sumber materi untuk topik ini. Unggah materi dulu.');
    const asal = s.rows[0];
    const materi = s.rows.map((x) => { try { return fs.readFileSync(x.extracted_path, 'utf8'); } catch { return ''; } }).join('\n').slice(0, 15000);

    const raw = await generateText(buildGeneratePrompt({ materi, count: p.count, qtypes: p.qtypes }), {});
    const parsed = GeneratedSet.parse(parseJson(raw));
    const inst = req.user.institution_id;
    const saved = [];
    for (const g of parsed.questions) {
      // Mapel & bab ikut dicatat supaya soal hasil AI tidak menggantung tanpa materi.
      const q = await pool.query(
        'INSERT INTO questions(institution_id,subject_id,topic_id,chapter_id,sub_chapter_id,qtype,text,options,answer_key,weight,rubric,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [inst, asal.mapel_id || null, p.topic_id || asal.topik_id || null, p.sub_chapter_id ? asal.bab_id : null, p.sub_chapter_id || null, g.qtype, g.text, g.options ? JSON.stringify(g.options) : null, g.answer_key, g.weight, g.rubric || null, req.user.id]
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
}

// ---- UJIAN (jumlah soal bebas: ditempel dari bank) ----
async function listExams(req, res) {
  const inst = req.user.role === 'superadmin' ? req.query.institution_id || null : req.user.institution_id;
  const q = inst
    ? await pool.query('SELECT e.*, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS n_soal FROM exams e WHERE institution_id=$1 ORDER BY id DESC', [inst])
    : await pool.query('SELECT e.*, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS n_soal FROM exams e ORDER BY id DESC');
  ok(res, q.rows);
}
async function createExam(req, res) {
  const p = z.object({ title: z.string().min(1), exam_type: z.string().trim().min(1).max(60).optional(), class_id: z.number().int(), subject_id: z.number().int().optional(), mode: z.enum(['SATU_LEMBAR', 'TERPISAH', 'HEMAT']).optional(), paper_size: z.enum(['A4', 'F4']).optional() }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const q = await pool.query('INSERT INTO exams(institution_id,subject_id,class_id,title,exam_type,mode,paper_size,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [inst, p.subject_id || null, p.class_id, p.title, p.exam_type || 'Ulangan Harian', p.mode || 'SATU_LEMBAR', p.paper_size || 'A4', req.user.id]);
  ok(res, q.rows[0], 'Ujian dibuat. Pilih soal dari bank.');
}

async function updateExam(req, res) {
  const p = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    exam_type: z.string().trim().min(1).max(60).optional(),
  }).refine((x) => x.title || x.exam_type).parse(req.body);
  const inst = needTenant(req, res);
  if (!inst) return;
  const r = await pool.query('UPDATE exams SET title=COALESCE($1,title), exam_type=COALESCE($2,exam_type) WHERE id=$3 AND institution_id=$4 RETURNING *',
    [p.title || null, p.exam_type || null, req.params.id, inst]);
  if (!r.rowCount) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  await audit(req, 'update', 'exams', r.rows[0].id);
  ok(res, r.rows[0], 'Ujian diperbarui.');
}

// Menghapus ujian ikut menghapus lembar, foto, dan nilainya (cascade).
async function deleteExam(req, res) {
  const inst = needTenant(req, res);
  if (!inst) return;
  if (!(await ujianMilik(inst, req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  const n = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM submissions s JOIN exam_sheets sh ON sh.id=s.sheet_id WHERE sh.exam_id=$1) AS nilai`,
    [req.params.id]
  )).rows[0].nilai;
  if (n > 0 && !req.body?.dengan_nilai) {
    return fail(res, 400, 'VALIDATION_ERROR', `Ujian ini sudah punya ${n} nilai. Centang "hapus beserta nilai" kalau memang mau dibuang.`);
  }
  // Foto jawaban tak ikut terhapus oleh cascade database; kumpulkan dulu.
  const foto = (await pool.query(
    `SELECT si.file_path FROM submission_images si
       JOIN submissions s ON s.id = si.submission_id
       JOIN exam_sheets sh ON sh.id = s.sheet_id
      WHERE sh.exam_id = $1`, [req.params.id]
  )).rows.map((r) => r.file_path);
  const hasil = (await pool.query('SELECT rel_path FROM generated_files WHERE exam_id=$1', [req.params.id])).rows.map((r) => r.rel_path);
  const r = await pool.query('DELETE FROM exams WHERE id=$1 AND institution_id=$2 RETURNING id', [req.params.id, inst]);
  if (!r.rowCount) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  hapusBerkasRel(foto.map(relDiUploads).filter(Boolean));
  hapusBerkasRel(hasil);
  await audit(req, 'delete', 'exams', r.rows[0].id, { ikut_nilai: n });
  ok(res, { id: r.rows[0].id }, n ? `Ujian dan ${n} nilainya dihapus.` : 'Ujian dihapus.');
}
async function listExamItems(req, res) {
  if (!(await ujianMilik(tenantId(req), req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  ok(res, (await pool.query('SELECT q.*, eq.nomor, COALESCE(eq.weight_override,q.weight) AS bobot FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=$1 ORDER BY eq.nomor', [req.params.id])).rows);
}
async function setExamItems(req, res) {
  const p = z.object({ question_ids: z.array(z.number().int()).max(100) }).parse(req.body);
  if (!(await ujianMilik(tenantId(req), req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  await pool.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
  let no = 1;
  for (const qid of p.question_ids) {
    await pool.query('INSERT INTO exam_questions(exam_id,question_id,nomor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, qid, no++]);
  }
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'set-items', 'exams', req.params.id, { count: p.question_ids.length }]);
  ok(res, { count: p.question_ids.length }, 'Soal ujian disimpan.');
}

// ---- PEMAKAIAN LLM ----
async function llmUsage(req, res) {
  const q = req.user.role === 'superadmin' && !req.query.institution_id
    ? await pool.query('SELECT * FROM llm_usage_logs ORDER BY id DESC LIMIT 100')
    : await pool.query('SELECT * FROM llm_usage_logs WHERE institution_id=$1 ORDER BY id DESC LIMIT 100', [req.query.institution_id || req.user.institution_id]);
  ok(res, q.rows);
}

module.exports = { listQuestions, createQuestion, updateQuestion, deleteQuestion, generateQuestions, listExams, createExam, updateExam, deleteExam, listExamItems, setExamItems, llmUsage };
