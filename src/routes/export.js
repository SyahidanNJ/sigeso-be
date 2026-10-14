const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ExcelJS = require('exceljs');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { auth, roles } = require('../middleware/auth');
const { AppError } = require('../lib/errors');

const r = express.Router();
r.use(auth);
const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const DIR = path.join(__dirname, '..', '..', 'uploads', 'export');
fs.mkdirSync(DIR, { recursive: true });
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/[#*_`$@<>\[\]]/g, (c) => '\\' + c);

async function dataNilai(examId) {
  const exam = (await pool.query('SELECT e.*, c.name AS kelas FROM exams e JOIN classes c ON c.id=e.class_id WHERE e.id=$1', [examId])).rows[0];
  if (!exam) throw new AppError('NOT_FOUND', 'Ujian tak ada.');
  const rows = (await pool.query(
    'SELECT st.name, st.nis, s.pg_score, s.final_score, s.status, s.feedback FROM submissions s JOIN exam_sheets sh ON sh.id=s.sheet_id JOIN students st ON st.id=sh.student_id WHERE sh.exam_id=$1 ORDER BY st.name', [examId]
  )).rows;
  const kop = (await pool.query('SELECT * FROM letterhead_templates WHERE institution_id=$1 ORDER BY is_default DESC, id LIMIT 1', [exam.institution_id])).rows[0];
  return { exam, rows, kop };
}

r.get('/exams/:id/export', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const format = req.query.format || 'xlsx';
  const { exam, rows, kop } = await dataNilai(req.params.id);
  const stamp = Date.now();
  let rel;

  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Nilai');
    ws.addRow([kop?.name || 'Nilai', exam.title, exam.kelas]);
    ws.addRow(['Nama', 'NIS', 'PG', 'Final', 'Status', 'Feedback']);
    rows.forEach((x) => ws.addRow([x.name, x.nis, x.pg_score, x.final_score, x.status, x.feedback]));
    ws.columns.forEach((c) => { c.width = 18; });
    rel = `export/nilai-${exam.id}-${stamp}.xlsx`;
    await wb.xlsx.writeFile(path.join(DIR, `nilai-${exam.id}-${stamp}.xlsx`));
  } else if (format === 'pdf') {
    const kopLines = (kop?.header_markdown || 'SEKOLAH').split('\n').map((l) => `#align(center)[#strong[${esc(l)}]]`).join('\n');
    const typ = `#set page(paper: "a4", margin: 2cm)\n#set text(lang: "id", size: 11pt)\n${kopLines}\n#line(length: 100%)\n#align(center)[#strong[Daftar Nilai: ${esc(exam.title)}]]\n#table(columns: 5, [*No*], [*Nama*], [*PG*], [*Final*], [*Status*], ${rows.map((x, i) => `[${i + 1}], [${esc(x.name)}], [${x.pg_score ?? '-'}], [${x.final_score ?? '-'}], [${x.status}]`).join(', ')})\n`;
    const jobDir = path.join(DIR, `nilai-${exam.id}-${stamp}`);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'nilai.typ'), typ);
    const pdf = path.join(jobDir, 'nilai.pdf');
    await new Promise((resolve, reject) => execFile(process.env.TYPST_BIN || 'typst', ['compile', path.join(jobDir, 'nilai.typ'), pdf], { timeout: 60000 }, (e) => (e ? reject(new AppError('PANDOC_FAILED', 'Gagal render PDF nilai.')) : resolve())));
    rel = `export/nilai-${exam.id}-${stamp}/nilai.pdf`;
  } else if (format === 'docx') {
    const md = `# Daftar Nilai: ${exam.title}\n\n| No | Nama | PG | Final | Status |\n|---|---|---|---|---|\n${rows.map((x, i) => `| ${i + 1} | ${x.name} | ${x.pg_score ?? '-'} | ${x.final_score ?? '-'} | ${x.status} |`).join('\n')}\n`;
    const jobDir = path.join(DIR, `nilai-${exam.id}-${stamp}`);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'nilai.md'), md);
    const docx = path.join(jobDir, 'nilai.docx');
    await new Promise((resolve, reject) => execFile(process.env.PANDOC_BIN || 'pandoc', [path.join(jobDir, 'nilai.md'), '-o', docx], { timeout: 60000 }, (e) => (e ? reject(new AppError('PANDOC_FAILED', 'Pandoc belum terinstal / gagal konversi.')) : resolve())));
    rel = `export/nilai-${exam.id}-${stamp}/nilai.docx`;
  } else {
    return fail(res, 400, 'VALIDATION_ERROR', 'format: xlsx, pdf, docx.');
  }

  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'export', 'exams', req.params.id, { format }]);
  ok(res, { download: `/api/v1/downloads/${rel}` }, 'Ekspor siap diunduh.');
}));

module.exports = r;
