const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pool } = require('../../db/pool');
const { AppError } = require('../../lib/errors');
const {
  kopTypst, judulTypst, metaTypst, identitasKosongTypst, soalTypst, kunciTypst, copyLogos,
} = require('./layout');

const DIR = path.join(__dirname, '..', '..', '..', 'uploads', 'print');
fs.mkdirSync(DIR, { recursive: true });
const TYPST = process.env.TYPST_BIN || 'typst';

function paperSize(size) {
  return size === 'F4'
    ? '#set page(width: 21.5cm, height: 33cm, margin: 1.8cm)'
    : '#set page(paper: "a4", margin: 1.6cm)';
}

function rapikan(items) {
  return items.map((q) => ({ ...q, options: typeof q.options === 'string' ? JSON.parse(q.options || '[]') : (q.options || []) }));
}

async function compile(typ, pdf) {
  return new Promise((resolve, reject) => {
    execFile(TYPST, ['compile', typ, pdf], { timeout: 60000 }, (err) => {
      if (err) return reject(new AppError('PANDOC_FAILED', 'Gagal merender PDF: ' + String(err.message).slice(0, 200)));
      resolve(pdf);
    });
  });
}

async function getKop(institutionId, paperSize) {
  const q = await pool.query('SELECT * FROM letterhead_templates WHERE institution_id=$1 AND paper_size=$2 ORDER BY is_default DESC, id LIMIT 1', [institutionId, paperSize]);
  return q.rows[0] || { header_markdown: 'SEKOLAH' };
}

// Data yang dibutuhkan kop dan blok identitas: kelas, tahun pelajaran, mapel.
async function konteksUjian(examId) {
  const exam = (await pool.query(`
    SELECT e.*, c.name AS kelas, c.academic_year, c.level AS tingkat, s.name AS mapel
    FROM exams e
    JOIN classes c ON c.id=e.class_id
    LEFT JOIN subjects s ON s.id=e.subject_id
    WHERE e.id=$1`, [examId])).rows[0];
  if (!exam) throw new AppError('NOT_FOUND', 'Ujian tak ada.');
  const inst = (await pool.query('SELECT * FROM institutions WHERE id=$1', [exam.institution_id])).rows[0];
  const kop = await getKop(exam.institution_id, exam.paper_size);
  return { exam, inst, kop };
}

// Hanya soal yang disetujui guru. Nomor dicetak ulang 1..n supaya tidak ada
// nomor bolong akibat soal yang belum disetujui atau sudah dikeluarkan.
async function soalDisetujui(examId) {
  const rows = rapikan((await pool.query(
    `SELECT q.* FROM exam_questions eq
       JOIN questions q ON q.id=eq.question_id
      WHERE eq.exam_id=$1 AND eq.approved
      ORDER BY eq.nomor, q.id`, [examId])).rows);
  return rows.map((q, i) => ({ ...q, nomor: i + 1 }));
}

function buatJob(awalan, examId) {
  const jobDir = path.join(DIR, `${awalan}-${examId}-${Date.now()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  return jobDir;
}

async function renderPdf(jobDir, nama, isi) {
  const typ = path.join(jobDir, `${nama}.typ`);
  fs.writeFileSync(typ, isi);
  const pdf = path.join(jobDir, `${nama}.pdf`);
  await compile(typ, pdf);
  return `${path.basename(jobDir)}/${nama}.pdf`;
}

// Satu lembar soal untuk difotokopi guru. Tanpa siswa, QR, atau lembar jawaban.
async function printExam(examId) {
  const { exam, inst, kop } = await konteksUjian(examId);
  const items = await soalDisetujui(examId);
  if (!items.length) throw new AppError('VALIDATION_ERROR', 'Belum ada soal yang disetujui. Setujui dulu di daftar review.');
  const jobDir = buatJob('ujian', examId);
  const logos = copyLogos(jobDir, inst);
  const isi = `${paperSize(exam.paper_size)}
#set text(lang: "id", size: 10.5pt)
${kopTypst({ kop, inst, logos })}
${judulTypst(exam)}
${metaTypst(exam)}
${identitasKosongTypst(exam)}
${soalTypst(items)}`;
  return { file: await renderPdf(jobDir, `soal-ujian-${examId}`, isi), count: items.length };
}

// Kunci jawaban dicetak terpisah agar tidak ikut terfotokopi bersama soal.
async function printAnswerKey(examId) {
  const { exam, inst, kop } = await konteksUjian(examId);
  const items = await soalDisetujui(examId);
  if (!items.length) throw new AppError('VALIDATION_ERROR', 'Belum ada soal yang disetujui.');
  const jobDir = buatJob('kunci', examId);
  const logos = copyLogos(jobDir, inst);
  const isi = `${paperSize(exam.paper_size)}
#set text(lang: "id", size: 10.5pt)
${kopTypst({ kop, inst, logos })}
${judulTypst(exam)}
${metaTypst(exam)}
${kunciTypst(items)}`;
  return { file: await renderPdf(jobDir, `kunci-ujian-${examId}`, isi), count: items.length };
}

module.exports = { printExam, printAnswerKey, soalDisetujui, DIR };
