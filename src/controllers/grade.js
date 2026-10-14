const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { AppError } = require('../lib/errors');
const { generateText } = require('../services/llm');
const { GradeOut, buildGradePrompt, parseJson } = require('../services/llm/prompts');

const DIR = path.join(__dirname, '..', '..', 'uploads', 'jawaban');
fs.mkdirSync(DIR, { recursive: true });

// Upload 1-N foto untuk 1 siswa (dikenali via QR per halaman atau qr_base).
// shortcut: QR dibaca dari input guru (qr_code), bukan computer vision. Upgrade: decode QR otomatis.
async function uploadJawaban(req, res) {
  const p = z.object({ qr_code: z.string().min(1) }).parse(req.body);
  if (!req.files?.length) return fail(res, 400, 'VALIDATION_ERROR', 'Foto wajib.');
  const page = (await pool.query('SELECT * FROM exam_sheet_pages WHERE qr_code=$1', [p.qr_code])).rows[0]
    || (await pool.query('SELECT * FROM exam_sheet_pages WHERE qr_code LIKE $1 ORDER BY page_no LIMIT 1', [`${p.qr_code}%`])).rows[0];
  if (!page) throw new AppError('QR_NOT_FOUND', 'QR tak dikenal. Ketik ulang kode di bawah QR.');
  const sheet = (await pool.query('SELECT sh.*, e.id AS exam_id FROM exam_sheets sh JOIN exams e ON e.id=sh.exam_id WHERE sh.id=$1', [page.sheet_id])).rows[0];

  let sub = (await pool.query('SELECT * FROM submissions WHERE sheet_id=$1', [sheet.id])).rows[0];
  if (!sub) sub = (await pool.query("INSERT INTO submissions(sheet_id,status) VALUES($1,'needs_review') RETURNING *", [sheet.id])).rows[0];
  if (sub.status === 'final') throw new AppError('VALIDATION_ERROR', 'Nilai sudah final, tak bisa tambah foto.');

  const items = (await pool.query('SELECT q.*, eq.nomor FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=$1 ORDER BY eq.nomor', [sheet.exam_id])).rows;
  const images = [];
  for (let i = 0; i < req.files.length; i++) {
    const f = req.files[i];
    const row = (await pool.query('INSERT INTO submission_images(submission_id,page_no,file_path,qr_detected) VALUES($1,$2,$3,$4) RETURNING *', [sub.id, page.page_no + i, f.path, p.qr_code])).rows[0];
    images.push(row);
  }

  // Nilai via vision LLM
  const t0 = Date.now();
  const kunci = items.map((q) => `${q.nomor}. ${q.qtype} kunci=${q.answer_key} bobot=${q.weight}`).join('; ');
  const content = [{ type: 'text', text: buildGradePrompt(kunci) }];
  for (const im of images) {
    const ext = path.extname(im.file_path).slice(1).replace('jpg', 'jpeg');
    const b64 = fs.readFileSync(im.file_path).toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:image/${ext};base64,${b64}` } });
  }
  let hasil;
  try {
    const raw = await generateText([{ role: 'user', content }], {});
    try {
      hasil = GradeOut.parse(parseJson(raw));
    } catch {
      const raw2 = await generateText([{ role: 'user', content: [...content, { type: 'text', text: 'Jawabanmu bukan JSON valid. Ulangi HANYA dengan JSON.' }] }], {});
      hasil = GradeOut.parse(parseJson(raw2));
    }
  } catch (e) {
    await pool.query("UPDATE submissions SET status='needs_review', feedback=$1 WHERE id=$2", ['Gagal dinilai otomatis, isi manual.', sub.id]);
    throw e.code ? e : new AppError('LLM_INVALID_JSON', 'Gagal membaca foto, isi manual.');
  }
  const benar = new Set(hasil.pg.filter((x) => x.benar).map((x) => x.nomor));
  let tot = 0, dpt = 0;
  for (const q of items.filter((x) => x.qtype === 'PG')) { tot += Number(q.weight); if (benar.has(q.nomor)) dpt += Number(q.weight); }
  const pgScore = tot ? Math.round((dpt / tot) * 100) : 0;
  await pool.query('UPDATE submissions SET pg_score=$1, essay_suggested=$2, final_score=$3, feedback=$4, graded_by=$5 WHERE id=$6',
    [pgScore, JSON.stringify(hasil.uraian), pgScore, hasil.feedback, req.user.id, sub.id]);
  await pool.query('INSERT INTO llm_usage_logs(request_id,user_id,institution_id,feature,model,duration_ms,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'grade', process.env.LLM_DEFAULT_MODEL, Date.now() - t0, 'success']);
  ok(res, { submission_id: sub.id, pg_score: pgScore, uraian: hasil.uraian, feedback: hasil.feedback }, 'Dinilai. Wajib review sebelum kunci.');
}

async function listSubmissions(req, res) {
  if (!req.query.exam_id) return fail(res, 400, 'VALIDATION_ERROR', 'exam_id wajib.');
  ok(res, (await pool.query(
    'SELECT s.*, st.name, st.nis FROM submissions s JOIN exam_sheets sh ON sh.id=s.sheet_id JOIN students st ON st.id=sh.student_id WHERE sh.exam_id=$1 ORDER BY st.name', [req.query.exam_id]
  )).rows);
}

async function reviewSubmission(req, res) {
  const p = z.object({ final_score: z.number().min(0).max(100), feedback: z.string().optional() }).parse(req.body);
  const q = await pool.query("UPDATE submissions SET final_score=$1, feedback=COALESCE($2,feedback), graded_by=$3 WHERE id=$4 AND status='needs_review' RETURNING *", [p.final_score, p.feedback || null, req.user.id, req.params.id]);
  if (!q.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Sudah final atau tak ada.');
  ok(res, q.rows[0], 'Koreksi tersimpan, belum final.');
}

async function finalizeSubmission(req, res) {
  const q = await pool.query("UPDATE submissions SET status='final', finalized_at=now() WHERE id=$1 AND status='needs_review' RETURNING *", [req.params.id]);
  if (!q.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Sudah final atau tak ada.');
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'finalize', 'submissions', req.params.id, { final_score: q.rows[0].final_score }]);
  ok(res, q.rows[0], 'Nilai final dan terkunci.');
}

module.exports = { DIR, uploadJawaban, listSubmissions, reviewSubmission, finalizeSubmission };
