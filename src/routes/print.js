const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { auth, roles } = require('../middleware/auth');
const { printExam, DIR } = require('../services/print');

const r = express.Router();
r.use(auth);
const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const GURU = ['superadmin', 'admin', 'guru'];

r.post('/exams/:id/print', roles(...GURU), asyncH(async (req, res) => {
  const out = await printExam(req.params.id);
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'print', 'exams', req.params.id, out]);
  ok(res, { download: `/api/v1/downloads/${out.file}`, ...out }, `${out.sheets} lembar dicetak.`);
}));

r.get('/exams/:id/sheets', asyncH(async (req, res) => {
  ok(res, (await pool.query('SELECT sh.*, st.name, st.nis FROM exam_sheets sh JOIN students st ON st.id=sh.student_id WHERE sh.exam_id=$1 ORDER BY st.name', [req.params.id])).rows);
}));

r.post('/sheets/:id/reprint', roles(...GURU), asyncH(async (req, res) => {
  const sh = (await pool.query('SELECT sh.*, e.title, e.paper_size, e.institution_id, st.name, st.nis FROM exam_sheets sh JOIN exams e ON e.id=sh.exam_id JOIN students st ON st.id=sh.student_id WHERE sh.id=$1', [req.params.id])).rows[0];
  if (!sh) return fail(res, 404, 'NOT_FOUND', 'Lembar tak ada.');
  const items = (await pool.query('SELECT q.*, eq.nomor FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=$1 ORDER BY eq.nomor', [sh.exam_id])).rows;
  const kop = (await pool.query('SELECT * FROM letterhead_templates WHERE institution_id=$1 AND paper_size=$2 ORDER BY is_default DESC, id LIMIT 1', [sh.institution_id, sh.paper_size])).rows[0] || { header_markdown: 'SEKOLAH' };
  const { execFile } = require('child_process');
  const QR = require('qrcode');
  const jobDir = path.join(DIR, `reprint-${sh.id}-${Date.now()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  await QR.toFile(path.join(jobDir, 'qr1.png'), `${sh.qr_base}:p1`, { width: 120 });
  await QR.toFile(path.join(jobDir, 'qr2.png'), `${sh.qr_base}:p2`, { width: 120 });
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/[#*_`$@<>\[\]]/g, (c) => '\\' + c);
  const kopLines = (kop.header_markdown || 'SEKOLAH').split('\n').map((l) => `#align(center)[#strong[${esc(l)}]]`).join('\n');
  const soal = items.map((qq, i) => {
    const opts = typeof qq.options === 'string' ? JSON.parse(qq.options) : qq.options;
    let body = qq.qtype === 'PG'
      ? `${(opts || []).map((o) => `#box(stroke: black, inset: 3pt)[#text(size: 9pt)[${esc(o)}]]`).join(' ')}\nJawaban: #box(stroke: black, width: 1.2cm, inset: 3pt)[ ]`
      : qq.qtype === 'ISIAN' ? 'Jawaban: #box(stroke: black, width: 8cm, inset: 5pt)[ ]' : '#rect(width: 100%, height: 3cm, stroke: black)[]';
    return `${i + 1}. ${esc(qq.text)}\n${body}\n`;
  }).join('\n');
  const paper = sh.paper_size === 'F4' ? '#set page(width: 21.5cm, height: 33cm, margin: 1.8cm)' : '#set page(paper: "a4", margin: 2cm)';
  const typ = `${paper}\n#set text(lang: "id", size: 11pt)\n${kopLines}\n#line(length: 100%)\n#align(center)[#strong[${esc(sh.title)}]]\nNama: #strong[${esc(sh.name)}] NIS: ${esc(sh.nis)} #h(1fr) #image("qr1.png", width: 2cm)\n${soal}\n#pagebreak()\n#align(center)[#strong[LEMBAR JAWABAN]]\nNama: #strong[${esc(sh.name)}] #h(1fr) #image("qr2.png", width: 2cm)\n`;
  fs.writeFileSync(path.join(jobDir, 'satu.typ'), typ);
  const pdf = path.join(jobDir, `lembar-${sh.id}.pdf`);
  await new Promise((resolve, reject) => execFile(process.env.TYPST_BIN || 'typst', ['compile', path.join(jobDir, 'satu.typ'), pdf], { timeout: 60000 }, (e) => (e ? reject(e) : resolve())));
  await pool.query('UPDATE exam_sheets SET print_count=print_count+1 WHERE id=$1', [sh.id]);
  const rel = path.basename(jobDir) + `/lembar-${sh.id}.pdf`;
  ok(res, { download: `/api/v1/downloads/${rel}` }, 'Lembar ulang dicetak.');
}));

r.get('/downloads/*', asyncH(async (req, res) => {
  const rel = req.params[0] || '';
  if (rel.includes('..') || path.isAbsolute(rel)) return fail(res, 400, 'VALIDATION_ERROR', 'Path tak valid.');
  const f = path.join(DIR, rel);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) return fail(res, 404, 'NOT_FOUND', 'File tak ada.');
  res.download(f);
}));

module.exports = r;
