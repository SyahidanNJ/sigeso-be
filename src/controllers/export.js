const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ExcelJS = require('exceljs');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { AppError } = require('../lib/errors');
const { catatBerkas } = require('../lib/berkas');

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

async function exportNilai(req, res) {
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

  await catatBerkas({ institution_id: exam.institution_id, exam_id: exam.id, kind: 'nilai', rel });
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'export', 'exams', req.params.id, { format }]);
  ok(res, { download: `/api/v1/downloads/${rel}` }, 'Ekspor siap diunduh.');
}

async function dataSoal(examId) {
  const exam = (await pool.query('SELECT e.*, c.name AS kelas FROM exams e JOIN classes c ON c.id=e.class_id WHERE e.id=$1', [examId])).rows[0];
  if (!exam) throw new AppError('NOT_FOUND', 'Ujian tak ada.');
  const items = (await pool.query('SELECT q.*, eq.nomor FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=$1 ORDER BY eq.nomor', [examId])).rows;
  if (!items.length) throw new AppError('VALIDATION_ERROR', 'Ujian belum punya soal.');
  const kop = (await pool.query('SELECT * FROM letterhead_templates WHERE institution_id=$1 ORDER BY is_default DESC, id LIMIT 1', [exam.institution_id])).rows[0];
  return { exam, items: items.map((q) => ({ ...q, options: typeof q.options === 'string' ? JSON.parse(q.options || '[]') : (q.options || []) })), kop };
}

function mdSoal(exam, items, kop, isi) {
  const kopMd = (kop?.header_markdown || 'SEKOLAH').split('\n').map((l) => `# ${l}`).join('\n');
  let md = `${kopMd}\n\n# ${exam.title} (${isi === 'kunci' ? 'Kunci Jawaban' : 'Soal'})\n`;
  if (isi !== 'kunci') {
    const soal = items.map((q, i) => {
      const opts = q.qtype === 'PG' ? '\n' + q.options.map((o) => `   - ${o}`).join('\n') : '';
      return `${i + 1}. ${q.text}${opts}`;
    }).join('\n\n');
    md += `\n## Soal\n\n${soal}\n`;
  }
  if (isi !== 'soal') {
    const kunci = items.map((q, i) => `${i + 1}. ${q.answer_key}`).join('\n');
    md += `\n## Kunci Jawaban\n\n${kunci}\n`;
  }
  return md;
}

async function exportDokumen(req, res) {
  const format = req.query.format || 'pdf';
  const isi = ['soal', 'kunci'].includes(req.query.isi) ? req.query.isi : 'semua';
  const nama = isi === 'semua' ? 'dokumen' : isi;
  const { exam, items, kop } = await dataSoal(req.params.id);
  const stamp = Date.now();
  const jobDir = path.join(DIR, `dokumen-${exam.id}-${stamp}`);
  fs.mkdirSync(jobDir, { recursive: true });
  let rel;
  if (format === 'docx') {
    fs.writeFileSync(path.join(jobDir, `${nama}.md`), mdSoal(exam, items, kop, isi));
    await new Promise((resolve, reject) => execFile(process.env.PANDOC_BIN || 'pandoc', [path.join(jobDir, `${nama}.md`), '-o', path.join(jobDir, `${nama}.docx`)], { timeout: 60000 }, (e) => (e ? reject(new AppError('PANDOC_FAILED', 'Pandoc gagal konversi.')) : resolve())));
    rel = `export/dokumen-${exam.id}-${stamp}/${nama}.docx`;
  } else if (format === 'pdf') {
    const kopLines = (kop?.header_markdown || 'SEKOLAH').split('\n').map((l) => `#align(center)[#strong[${esc(l)}]]`).join('\n');
    let typ = `#set page(paper: "a4", margin: 2cm)\n#set text(lang: "id", size: 11pt)\n${kopLines}\n#line(length: 100%)\n#align(center)[#strong[${esc(exam.title)}]]\n`;
    if (isi !== 'kunci') {
      const soal = items.map((q, i) => {
        const body = q.qtype === 'PG'
          ? q.options.map((o) => `#box(stroke: black, inset: 3pt)[#text(size: 9pt)[${esc(o)}]]`).join(' ')
          : q.qtype === 'ISIAN' ? '#line(length: 8cm)' : '#rect(width: 100%, height: 3cm, stroke: black)[]';
        return `${i + 1}. ${esc(q.text)}\n${body}\n`;
      }).join('\n');
      typ += `${soal}\n`;
    }
    if (isi !== 'soal') {
      const kunci = items.map((q, i) => `[${i + 1}], [${esc(q.answer_key)}]`).join(', ');
      typ += `#pagebreak()\n#align(center)[#strong[Kunci Jawaban]]\n#table(columns: 2, [*No*], [*Kunci*], ${kunci})\n`;
    }
    fs.writeFileSync(path.join(jobDir, `${nama}.typ`), typ);
    await new Promise((resolve, reject) => execFile(process.env.TYPST_BIN || 'typst', ['compile', path.join(jobDir, `${nama}.typ`), path.join(jobDir, `${nama}.pdf`)], { timeout: 60000 }, (e) => (e ? reject(new AppError('PANDOC_FAILED', 'Gagal render PDF soal.')) : resolve())));
    rel = `export/dokumen-${exam.id}-${stamp}/${nama}.pdf`;
  } else {
    return fail(res, 400, 'VALIDATION_ERROR', 'format: pdf, docx.');
  }
  await catatBerkas({ institution_id: exam.institution_id, exam_id: exam.id, kind: 'dokumen', rel });
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'export-doc', 'exams', req.params.id, { format, isi }]);
  ok(res, { download: `/api/v1/downloads/${rel}` }, 'Dokumen soal siap diunduh.');
}

module.exports = { exportNilai, exportDokumen };
