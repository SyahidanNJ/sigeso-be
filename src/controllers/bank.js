const fs = require('fs');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { needTenant, tenantId, ujianMilik } = require('../lib/scope');
const { audit } = require('./bantuan');
const { AppError } = require('../lib/errors');
const { hapusBerkasRel } = require('../lib/berkas');
const { generateText } = require('../services/llm');
const { buildGeneratePrompt, rapikanHasil, saringSoal, potongSesuaiRencana, parseJson } = require('../services/llm/prompts');

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
    `SELECT q.*, m.name AS mapel, m.grade_level AS tingkat, sc.name AS subbab
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

// ---- GENERATE UJIAN (sinkron; shortcut: pindah ke antrean latar bila konkuren naik) ----
// Satu permintaan membuat satu ujian: mapel + topik baru disimpan di sini,
// soal masuk bank, dan relasi ujian disimpan dengan approved=false supaya guru
// harus menyetujuinya dulu sebelum ikut dicetak.
const rapiNama = (s) => s.trim().replace(/\s+/g, ' ');

async function cariBuatMapel(inst, gradeLevel, nama) {
  const ada = await pool.query(
    'SELECT * FROM subjects WHERE institution_id=$1 AND grade_level=$2 AND lower(name)=lower($3) ORDER BY id LIMIT 1',
    [inst, gradeLevel, nama]
  );
  if (ada.rowCount) return ada.rows[0];
  return (await pool.query('INSERT INTO subjects(institution_id,grade_level,name) VALUES($1,$2,$3) RETURNING *', [inst, gradeLevel, nama])).rows[0];
}

// Topik milik guru dipakai lebih dulu; kalau tidak ada, topik publik lama
// dengan nama sama dipakai ulang supaya tak muncul dua label kembar.
async function cariBuatTopik(subjectId, userId, nama) {
  const sendiri = await pool.query(
    'SELECT * FROM topics WHERE subject_id=$1 AND created_by=$2 AND lower(name)=lower($3) ORDER BY id LIMIT 1',
    [subjectId, userId, nama]
  );
  if (sendiri.rowCount) return sendiri.rows[0];
  const publik = await pool.query(
    'SELECT * FROM topics WHERE subject_id=$1 AND created_by IS NULL AND lower(name)=lower($2) ORDER BY id LIMIT 1',
    [subjectId, nama]
  );
  if (publik.rowCount) return publik.rows[0];
  return (await pool.query('INSERT INTO topics(subject_id,created_by,name) VALUES($1,$2,$3) RETURNING *', [subjectId, userId, nama])).rows[0];
}

async function materiTopik(topicId) {
  const s = await pool.query(
    "SELECT extracted_path FROM sources WHERE topic_id=$1 AND status='done' ORDER BY id DESC LIMIT 3", [topicId]);
  return s.rows.map((x) => { try { return fs.readFileSync(x.extracted_path, 'utf8'); } catch { return ''; } }).join('\n').slice(0, 12000);
}

// Tiap topik menyebut jumlah per jenis soal; boleh 0 supaya guru bisa membuat
// ujian tanpa uraian, misalnya. Minimal satu jenis harus terisi.
const JumlahTopik = z.object({
  name: z.string().trim().min(1).max(120),
  pg: z.number().int().min(0).max(20).default(0),
  isian: z.number().int().min(0).max(20).default(0),
  uraian: z.number().int().min(0).max(20).default(0),
}).refine((t) => t.pg + t.isian + t.uraian > 0, {
  message: 'Isi jumlah soal minimal satu jenis di tiap topik.',
});

async function generateQuestions(req, res) {
  const p = z.object({
    class_id: z.number().int(),
    exam_type: z.string().trim().min(1).max(60),
    subject_name: z.string().trim().min(1).max(120),
    topics: z.array(JumlahTopik).min(1).max(10),
    paper_size: z.enum(['A4', 'F4']).optional(),
  }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;

  const kelas = (await pool.query('SELECT id, name, level FROM classes WHERE id=$1 AND institution_id=$2', [p.class_id, inst])).rows[0];
  if (!kelas) return fail(res, 400, 'VALIDATION_ERROR', 'Kelas tak ditemukan di sekolah ini.');
  if (!kelas.level) return fail(res, 400, 'VALIDATION_ERROR', 'Kelas ini belum punya tingkat. Atur dulu di halaman Profil.');

  // Topik dengan nama sama digabung, jumlah tiap jenisnya dijumlahkan.
  const gabung = new Map();
  for (const t of p.topics) {
    const nama = rapiNama(t.name);
    const kunci = nama.toLowerCase();
    const lama = gabung.get(kunci);
    gabung.set(kunci, {
      name: nama,
      pg: (lama?.pg || 0) + t.pg,
      isian: (lama?.isian || 0) + t.isian,
      uraian: (lama?.uraian || 0) + t.uraian,
    });
  }
  const daftarTopik = [...gabung.values()];
  const namaMapel = rapiNama(p.subject_name);
  const mapel = await cariBuatMapel(inst, kelas.level, namaMapel);

  const exam = (await pool.query(
    `INSERT INTO exams(institution_id,subject_id,class_id,title,exam_type,mode,paper_size,created_by)
     VALUES($1,$2,$3,$4,$5,'SATU_LEMBAR',$6,$7) RETURNING *`,
    // Judul mengikuti data contoh: "Jenis ujian: Topik". Mapel sudah punya kolom sendiri.
    [inst, mapel.id, kelas.id, `${p.exam_type}: ${daftarTopik.map((t) => t.name).join(', ')}`, p.exam_type, p.paper_size || 'A4', req.user.id]
  )).rows[0];

  const t0 = Date.now();
  const job = (await pool.query("INSERT INTO app_jobs(request_id,job_type,status) VALUES($1,'generate','processing') RETURNING id", [res.locals.requestId])).rows[0];
  const items = [];
  const errors = [];
  let nomor = 1;

  for (const t of daftarTopik) {
    try {
      const topik = await cariBuatTopik(mapel.id, req.user.id, t.name);
      const materi = await materiTopik(topik.id);
      const raw = await generateText(buildGeneratePrompt({
        mapel: namaMapel, topik: topik.name, tingkat: kelas.level, materi,
        rencana: { PG: t.pg, ISIAN: t.isian, URAIAN: t.uraian },
      }), {});
      const soal = potongSesuaiRencana(saringSoal(rapikanHasil(parseJson(raw))), {
        PG: t.pg, ISIAN: t.isian, URAIAN: t.uraian,
      });
      if (!soal.length) throw new Error('AI tidak mengembalikan soal yang sesuai format. Coba lagi.');
      for (const g of soal) {
        const q = (await pool.query(
          `INSERT INTO questions(institution_id,subject_id,topic_id,qtype,text,options,answer_key,weight,rubric,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [inst, mapel.id, topik.id, g.qtype, g.text, g.options ? JSON.stringify(g.options) : null, g.answer_key, g.weight, g.rubric || null, req.user.id]
        )).rows[0];
        await pool.query('INSERT INTO exam_questions(exam_id,question_id,nomor,approved) VALUES($1,$2,$3,false)', [exam.id, q.id, nomor++]);
        items.push({ ...q, nomor: nomor - 1, approved: false, topik: topik.name });
      }
    } catch (e) {
      // Satu topik gagal tidak membatalkan topik lain; guru melihat sisanya.
      errors.push({ topik: t.name, pesan: String(e.message || e) });
    }
  }

  // Semua topik gagal: jangan tinggalkan ujian kosong di daftar guru.
  if (!items.length) await pool.query('DELETE FROM exams WHERE id=$1', [exam.id]);
  const status = errors.length === daftarTopik.length ? 'failed' : 'success';
  await pool.query("UPDATE app_jobs SET status=$1,progress=100,result=$2,error=$3 WHERE id=$4",
    [status, JSON.stringify({ exam_id: exam.id, count: items.length }), errors.length ? errors.map((e) => e.pesan).join(' | ').slice(0, 500) : null, job.id]);
  await pool.query('INSERT INTO llm_usage_logs(request_id,user_id,institution_id,feature,model,duration_ms,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, inst, 'generate', process.env.LLM_DEFAULT_MODEL, Date.now() - t0, status]);

  // Nol soal tetap dianggap gagal: toast sukses akan menyesatkan guru.
  if (!items.length) return fail(res, 502, 'LLM_EMPTY', 'Tidak ada soal yang berhasil dibuat. Coba lagi.', errors);
  ok(res, { exam, items, errors }, `${items.length} soal dibuat${errors.length ? `, ${errors.length} topik gagal` : ''}. Periksa lalu setujui.`);
}

// ---- UJIAN ----
async function listExams(req, res) {
  const inst = req.user.role === 'superadmin' ? req.query.institution_id || null : req.user.institution_id;
  const sql = `SELECT e.*, s.name AS mapel, c.name AS kelas, c.level AS tingkat,
      (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id)::int AS n_soal,
      (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id AND q.approved)::int AS n_setuju
     FROM exams e
     LEFT JOIN subjects s ON s.id=e.subject_id
     LEFT JOIN classes c ON c.id=e.class_id
    ${inst ? 'WHERE e.institution_id=$1' : ''}
    ORDER BY e.id DESC`;
  ok(res, (inst ? await pool.query(sql, [inst]) : await pool.query(sql)).rows);
}
async function createExam(req, res) {
  const p = z.object({ title: z.string().min(1), exam_type: z.string().trim().min(1).max(60).optional(), class_id: z.number().int(), subject_id: z.number().int().optional(), paper_size: z.enum(['A4', 'F4']).optional() }).parse(req.body);
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  const k = await pool.query('SELECT id FROM classes WHERE id=$1 AND institution_id=$2', [p.class_id, inst]);
  if (!k.rowCount) return fail(res, 400, 'VALIDATION_ERROR', 'Kelas tak ditemukan di sekolah ini.');
  // Semua ujian keluar sebagai satu lembar; kolom mode lama dibiarkan tetap.
  const q = await pool.query("INSERT INTO exams(institution_id,subject_id,class_id,title,exam_type,mode,paper_size,created_by) VALUES($1,$2,$3,$4,$5,'SATU_LEMBAR',$6,$7) RETURNING *",
    [inst, p.subject_id || null, p.class_id, p.title, p.exam_type || 'Ulangan Harian', p.paper_size || 'A4', req.user.id]);
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

// Menghapus ujian ikut melepas relasi soalnya; soalnya tetap ada di bank.
async function deleteExam(req, res) {
  const inst = needTenant(req, res);
  if (!inst) return;
  if (!(await ujianMilik(inst, req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  const hasil = (await pool.query('SELECT rel_path FROM generated_files WHERE exam_id=$1', [req.params.id])).rows.map((r) => r.rel_path);
  const r = await pool.query('DELETE FROM exams WHERE id=$1 AND institution_id=$2 RETURNING id', [req.params.id, inst]);
  if (!r.rowCount) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  hapusBerkasRel(hasil);
  await audit(req, 'delete', 'exams', r.rows[0].id);
  ok(res, { id: r.rows[0].id }, 'Ujian dihapus.');
}
// Nomor soal dirapikan 1..n setelah satu item dikeluarkan.
async function rapikanNomor(examId) {
  await pool.query(`
    UPDATE exam_questions eq SET nomor = x.no
      FROM (SELECT question_id, row_number() OVER (ORDER BY nomor, question_id) AS no
              FROM exam_questions WHERE exam_id=$1) x
     WHERE eq.exam_id=$1 AND eq.question_id=x.question_id`, [examId]);
}

async function listExamItems(req, res) {
  if (!(await ujianMilik(tenantId(req), req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  ok(res, (await pool.query(
    `SELECT q.*, eq.nomor, eq.approved, COALESCE(eq.weight_override,q.weight) AS bobot,
            t.name AS topik, s.name AS mapel
       FROM exam_questions eq
       JOIN questions q ON q.id=eq.question_id
       LEFT JOIN topics t ON t.id=q.topic_id
       LEFT JOIN subjects s ON s.id=q.subject_id
      WHERE eq.exam_id=$1 ORDER BY eq.nomor`, [req.params.id])).rows);
}

// Setuju/kunci, ubah isi, atau tolak satu soal. Soal yang tidak disetujui tetap
// ada di bank dan di ujian, tapi tidak dihitung dan tidak dicetak.
async function updateExamItem(req, res) {
  const p = z.object({
    text: z.string().min(1).optional(),
    options: z.array(z.string()).optional(),
    answer_key: z.string().min(1).optional(),
    rubric: z.string().nullable().optional(),
    approved: z.boolean().optional(),
  }).refine((x) => Object.keys(x).length > 0).parse(req.body);
  if (!(await ujianMilik(tenantId(req), req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');

  const lama = (await pool.query(
    `SELECT q.id, q.qtype, q.text, q.options, q.answer_key, q.rubric
       FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
      WHERE eq.exam_id=$1 AND eq.question_id=$2`, [req.params.id, req.params.questionId])).rows[0];
  if (!lama) return fail(res, 404, 'NOT_FOUND', 'Soal tidak ada di ujian ini.');

  const options = p.options !== undefined ? p.options : lama.options;
  const answer_key = p.answer_key !== undefined ? rapikanKunci(lama.qtype, options, p.answer_key) : lama.answer_key;
  if (p.text !== undefined || p.options !== undefined || p.answer_key !== undefined || p.rubric !== undefined) {
    await pool.query('UPDATE questions SET text=$1, options=$2, answer_key=$3, rubric=$4, updated_at=now() WHERE id=$5',
      [p.text ?? lama.text, options ? JSON.stringify(options) : null, answer_key, p.rubric !== undefined ? p.rubric : lama.rubric, lama.id]);
  }
  if (p.approved !== undefined) {
    await pool.query('UPDATE exam_questions SET approved=$1 WHERE exam_id=$2 AND question_id=$3', [p.approved, req.params.id, req.params.questionId]);
  }
  await audit(req, 'update', 'exam_questions', lama.id);
  ok(res, (await pool.query(
    `SELECT q.*, eq.nomor, eq.approved, COALESCE(eq.weight_override,q.weight) AS bobot
       FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
      WHERE eq.exam_id=$1 AND eq.question_id=$2`, [req.params.id, req.params.questionId])).rows[0],
  p.approved === true ? 'Soal disetujui.' : 'Soal diperbarui.');
}

async function deleteExamItem(req, res) {
  if (!(await ujianMilik(tenantId(req), req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  const d = await pool.query('DELETE FROM exam_questions WHERE exam_id=$1 AND question_id=$2 RETURNING question_id', [req.params.id, req.params.questionId]);
  if (!d.rowCount) return fail(res, 404, 'NOT_FOUND', 'Soal tidak ada di ujian ini.');
  await rapikanNomor(req.params.id);
  await audit(req, 'delete', 'exam_questions', req.params.questionId);
  ok(res, { question_id: Number(req.params.questionId) }, 'Soal dikeluarkan dari ujian.');
}

async function setExamItems(req, res) {
  const p = z.object({ question_ids: z.array(z.number().int()).max(100) }).parse(req.body);
  if (!(await ujianMilik(tenantId(req), req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  await pool.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
  let no = 1;
  for (const qid of p.question_ids) {
    // Item yang dipilih manual dianggap sudah disetujui guru.
    await pool.query('INSERT INTO exam_questions(exam_id,question_id,nomor,approved) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING', [req.params.id, qid, no++]);
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

module.exports = {
  listQuestions, createQuestion, updateQuestion, deleteQuestion, generateQuestions,
  listExams, createExam, updateExam, deleteExam, listExamItems, updateExamItem, deleteExamItem, setExamItems,
  llmUsage,
};
