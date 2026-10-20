const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const QR = require('qrcode');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { catatBerkas } = require('../lib/berkas');
const { printExam, DIR } = require('../services/print');

async function printUjian(req, res) {
  const out = await printExam(req.params.id);
  await catatBerkas({ institution_id: req.user.institution_id, exam_id: Number(req.params.id), kind: 'cetak', rel: `print/${out.file}` });
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, req.user.institution_id, 'print', 'exams', req.params.id, out]);
  ok(res, { download: `/api/v1/downloads/${out.file}`, ...out }, `${out.sheets} lembar dicetak.`);
}

async function listSheets(req, res) {
  ok(res, (await pool.query('SELECT sh.*, st.name, st.nis FROM exam_sheets sh JOIN students st ON st.id=sh.student_id WHERE sh.exam_id=$1 ORDER BY st.name', [req.params.id])).rows);
}

async function reprintSheet(req, res) {
  const sh = (await pool.query('SELECT sh.*, e.title, e.paper_size, e.institution_id, st.name, st.nis FROM exam_sheets sh JOIN exams e ON e.id=sh.exam_id JOIN students st ON st.id=sh.student_id WHERE sh.id=$1', [req.params.id])).rows[0];
  if (!sh) return fail(res, 404, 'NOT_FOUND', 'Lembar tak ada.');
  const items = (await pool.query('SELECT q.*, eq.nomor FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=$1 ORDER BY eq.nomor', [sh.exam_id])).rows;
  const kop = (await pool.query('SELECT * FROM letterhead_templates WHERE institution_id=$1 AND paper_size=$2 ORDER BY is_default DESC, id LIMIT 1', [sh.institution_id, sh.paper_size])).rows[0] || { header_markdown: 'SEKOLAH' };
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
  const rel = path.basename(jobDir) + `/lembar-${sh.id}.pdf`;
  await catatBerkas({ institution_id: sh.institution_id, exam_id: sh.exam_id, kind: 'cetak-ulang', rel: `print/${rel}` });
  ok(res, { download: `/api/v1/downloads/${rel}` }, 'Lembar ulang dicetak.');
}

module.exports = { printUjian, listSheets, reprintSheet };
