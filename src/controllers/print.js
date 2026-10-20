const { pool } = require('../db/pool');
const { ok } = require('../lib/respond');
const { catatBerkas } = require('../lib/berkas');
const { printExam, reprintSheet: renderUlang } = require('../services/print');

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
  const out = await renderUlang(req.params.id);
  await catatBerkas({ institution_id: out.institution_id, exam_id: out.exam_id, kind: 'cetak-ulang', rel: `print/${out.rel}` });
  ok(res, { download: `/api/v1/downloads/${out.rel}` }, 'Lembar ulang dicetak.');
}

module.exports = { printUjian, listSheets, reprintSheet };
