const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { catatBerkas } = require('../lib/berkas');
const { tenantId, ujianMilik } = require('../lib/scope');
const { printExam, printAnswerKey } = require('../services/print');

async function printUjian(req, res) {
  if (!(await ujianMilik(tenantId(req), req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  const out = await printExam(req.params.id);
  const inst = tenantId(req);
  await catatBerkas({ institution_id: inst, exam_id: Number(req.params.id), kind: 'cetak', rel: `print/${out.file}` });
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, inst, 'print', 'exams', req.params.id, { count: out.count }]);
  ok(res, { download: `/api/v1/downloads/${out.file}`, ...out }, `${out.count} soal siap dicetak.`);
}

async function kunciJawaban(req, res) {
  if (!(await ujianMilik(tenantId(req), req.params.id))) return fail(res, 404, 'NOT_FOUND', 'Ujian tak ditemukan.');
  const out = await printAnswerKey(req.params.id);
  const inst = tenantId(req);
  await catatBerkas({ institution_id: inst, exam_id: Number(req.params.id), kind: 'kunci', rel: `print/${out.file}` });
  await pool.query('INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [res.locals.requestId, req.user.id, inst, 'print-kunci', 'exams', req.params.id, { count: out.count }]);
  ok(res, { download: `/api/v1/downloads/${out.file}`, ...out }, 'Kunci jawaban siap diunduh.');
}

module.exports = { printUjian, kunciJawaban };
