const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const QR = require('qrcode');
const { randomBytes } = require('crypto');
const { pool } = require('../../db/pool');
const { AppError } = require('../../lib/errors');

const DIR = path.join(__dirname, '..', '..', '..', 'uploads', 'print');
fs.mkdirSync(DIR, { recursive: true });
const TYPST = process.env.TYPST_BIN || 'typst';

// shortcut: template 2 halaman tetap (soal | jawaban). Upgrade: paginasi dinamis bila soal >15.
function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/[#*_`$@<>\[\]]/g, (c) => '\\' + c);
}

function kopBlock(kop) {
  const lines = (kop?.header_markdown || 'SEKOLAH').split('\n').map((l) => `#align(center)[#strong[${esc(l)}]]`).join('\n');
  return `${lines}\n#line(length: 100%)\n`;
}

function soalBlock(items) {
  return items.map((q, i) => {
    const no = i + 1;
    let body = '';
    if (q.qtype === 'PG') {
      const opts = (q.options || []).map((o) => `#box(stroke: black, inset: 3pt)[#text(size: 9pt)[${esc(o)}]]`).join(' ');
      body = `${opts}\nJawaban: #box(stroke: black, width: 1.2cm, inset: 3pt)[ ]`;
    } else if (q.qtype === 'ISIAN') {
      body = `Jawaban: #box(stroke: black, width: 8cm, inset: 5pt)[ ]`;
    } else {
      body = `#rect(width: 100%, height: 3cm, stroke: black)[]`;
    }
    return `${no}. ${esc(q.text)}\n${body}\n`;
  }).join('\n');
}

function lembarSiswa({ kop, exam, student, items, qrBase, qr1, qr2 }) {
  return `${kopBlock(kop)}
#align(center)[#strong[${esc(exam.title)}]]
Nama: #strong[${esc(student.name)}] \u00a0 NIS: ${esc(student.nis)} #h(1fr) #image("${qr1}", width: 2cm)
${soalBlock(items)}
#pagebreak()
#align(center)[#strong[LEMBAR JAWABAN]]
Nama: #strong[${esc(student.name)}] #h(1fr) #image("${qr2}", width: 2cm)
#table(columns: 3, [*No*], [*Jawaban*], [*Nilai*], ${items.map((q, i) => `[${i + 1}], [#box(stroke: black, width: 4cm, inset: 4pt)[ ]], []`).join(', ')})
`;
}

function paperSize(size) {
  return size === 'F4' ? '#set page(width: 21.5cm, height: 33cm, margin: 1.8cm)' : '#set page(paper: "a4", margin: 2cm)';
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

async function renderSiswa(jobDir, exam, kop, student, items, sheet) {
  const qr1 = `qr-${sheet.id}-1.png`;
  const qr2 = `qr-${sheet.id}-2.png`;
  await QR.toFile(path.join(jobDir, qr1), `${sheet.qr_base}:p1`, { width: 120 });
  await QR.toFile(path.join(jobDir, qr2), `${sheet.qr_base}:p2`, { width: 120 });
  return lembarSiswa({ kop, exam, student, items, qrBase: sheet.qr_base, qr1, qr2 });
}

async function printExam(examId) {
  const exam = (await pool.query('SELECT * FROM exams WHERE id=$1', [examId])).rows[0];
  if (!exam) throw new AppError('NOT_FOUND', 'Ujian tak ada.');
  const items = (await pool.query('SELECT q.*, eq.nomor FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=$1 ORDER BY eq.nomor', [examId])).rows;
  if (!items.length) throw new AppError('VALIDATION_ERROR', 'Ujian belum punya soal.');
  const students = (await pool.query('SELECT * FROM students WHERE class_id=$1 AND is_active=true ORDER BY name', [exam.class_id])).rows;
  if (!students.length) throw new AppError('VALIDATION_ERROR', 'Kelas belum punya siswa.');
  const kop = await getKop(exam.institution_id, exam.paper_size);

  const jobDir = path.join(DIR, `exam-${examId}-${Date.now()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const parts = [`${paperSize(exam.paper_size)}\n#set text(lang: "id", size: 11pt)\n`];
  for (const st of students) {
    const sheet = await sheetFor(examId, st.id);
    parts.push(await renderSiswa(jobDir, exam, kop, st, items.map((q) => ({ ...q, options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options })), sheet));
    parts.push('#pagebreak()\n');
    await pool.query('UPDATE exam_sheets SET pdf_path=$1, print_count=print_count+1 WHERE id=$2', [jobDir, sheet.id]);
  }
  const typ = path.join(jobDir, 'semua.typ');
  fs.writeFileSync(typ, parts.join('\n'));
  const pdf = path.join(jobDir, `cetak-ujian-${examId}.pdf`);
  await compile(typ, pdf);
  return { file: path.basename(jobDir) + `/cetak-ujian-${examId}.pdf`, sheets: students.length };
}

module.exports = { printExam, DIR };
