const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const QR = require('qrcode');
const { randomBytes } = require('crypto');
const { pool } = require('../../db/pool');
const { AppError } = require('../../lib/errors');
const {
  kopTypst, judulTypst, metaTypst, identitasTypst, soalTypst, lembarJawabanTypst, copyLogos,
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
    SELECT e.*, c.name AS kelas, c.academic_year, s.name AS mapel
    FROM exams e
    JOIN classes c ON c.id=e.class_id
    LEFT JOIN subjects s ON s.id=e.subject_id
    WHERE e.id=$1`, [examId])).rows[0];
  if (!exam) throw new AppError('NOT_FOUND', 'Ujian tak ada.');
  const inst = (await pool.query('SELECT * FROM institutions WHERE id=$1', [exam.institution_id])).rows[0];
  const kop = await getKop(exam.institution_id, exam.paper_size);
  return { exam, inst, kop };
}

async function ambilSoal(examId) {
  return rapikan((await pool.query(
    'SELECT q.*, eq.nomor FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=$1 ORDER BY eq.nomor', [examId]
  )).rows);
}

function renderSheet({ exam, inst, kop, logos, student, items, qr1, qr2 }) {
  return `${kopTypst({ kop, inst, logos })}
${judulTypst(exam)}
${metaTypst(exam)}
${identitasTypst({ student, exam, qr: qr1 })}
${soalTypst(items)}
${lembarJawabanTypst({ student, exam, qr: qr2, items })}`;
}

async function sheetFor(examId, studentId) {
  let s = await pool.query('SELECT * FROM exam_sheets WHERE exam_id=$1 AND student_id=$2', [examId, studentId]);
  if (!s.rowCount) {
    const base = 'SG' + randomBytes(6).toString('hex');
    s = await pool.query('INSERT INTO exam_sheets(exam_id,student_id,qr_base) VALUES($1,$2,$3) RETURNING *', [examId, studentId, base]);
    await pool.query('INSERT INTO exam_sheet_pages(sheet_id,page_no,qr_code) VALUES($1,1,$2),($1,2,$3)', [s.rows[0].id, `${base}:p1`, `${base}:p2`]);
    s = await pool.query('SELECT * FROM exam_sheets WHERE id=$1', [s.rows[0].id]);
  }
  return s.rows[0];
}

async function printExam(examId) {
  const { exam, inst, kop } = await konteksUjian(examId);
  const items = await ambilSoal(examId);
  if (!items.length) throw new AppError('VALIDATION_ERROR', 'Ujian belum punya soal.');
  const students = (await pool.query('SELECT * FROM students WHERE class_id=$1 AND is_active=true ORDER BY name', [exam.class_id])).rows;
  if (!students.length) throw new AppError('VALIDATION_ERROR', 'Kelas belum punya siswa.');

  const jobDir = path.join(DIR, `exam-${examId}-${Date.now()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const logos = copyLogos(jobDir, inst);
  const parts = [`${paperSize(exam.paper_size)}\n#set text(lang: "id", size: 10.5pt)\n`];
  for (let i = 0; i < students.length; i++) {
    const st = students[i];
    const sheet = await sheetFor(examId, st.id);
    const qr1 = `qr-${sheet.id}-1.png`;
    const qr2 = `qr-${sheet.id}-2.png`;
    await QR.toFile(path.join(jobDir, qr1), `${sheet.qr_base}:p1`, { width: 120 });
    await QR.toFile(path.join(jobDir, qr2), `${sheet.qr_base}:p2`, { width: 120 });
    parts.push(renderSheet({ exam, inst, kop, logos, student: st, items, qr1, qr2 }));
    if (i < students.length - 1) parts.push('#pagebreak()\n');
    await pool.query('UPDATE exam_sheets SET pdf_path=$1 WHERE id=$2', [jobDir, sheet.id]);
  }
  const typ = path.join(jobDir, 'semua.typ');
  fs.writeFileSync(typ, parts.join('\n'));
  const pdf = path.join(jobDir, `cetak-ujian-${examId}.pdf`);
  await compile(typ, pdf);
  return { file: path.basename(jobDir) + `/cetak-ujian-${examId}.pdf`, sheets: students.length };
}

// Cetak ulang satu lembar memakai renderer yang sama dengan cetak semua.
async function reprintSheet(sheetId) {
  const sh = (await pool.query('SELECT * FROM exam_sheets WHERE id=$1', [sheetId])).rows[0];
  if (!sh) throw new AppError('NOT_FOUND', 'Lembar tak ada.');
  const student = (await pool.query('SELECT * FROM students WHERE id=$1', [sh.student_id])).rows[0];
  const { exam, inst, kop } = await konteksUjian(sh.exam_id);
  const items = await ambilSoal(sh.exam_id);

  const jobDir = path.join(DIR, `reprint-${sheetId}-${Date.now()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const logos = copyLogos(jobDir, inst);
  const qr1 = 'qr-1.png';
  const qr2 = 'qr-2.png';
  await QR.toFile(path.join(jobDir, qr1), `${sh.qr_base}:p1`, { width: 120 });
  await QR.toFile(path.join(jobDir, qr2), `${sh.qr_base}:p2`, { width: 120 });

  const typ = `${paperSize(exam.paper_size)}\n#set text(lang: "id", size: 10.5pt)\n${renderSheet({ exam, inst, kop, logos, student, items, qr1, qr2 })}`;
  fs.writeFileSync(path.join(jobDir, 'satu.typ'), typ);
  const pdf = path.join(jobDir, `lembar-${sheetId}.pdf`);
  await compile(path.join(jobDir, 'satu.typ'), pdf);
  return {
    rel: `${path.basename(jobDir)}/lembar-${sheetId}.pdf`,
    institution_id: exam.institution_id,
    exam_id: exam.id,
  };
}

module.exports = { printExam, reprintSheet, DIR };
