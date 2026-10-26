const { pool } = require('../db/pool');

// Helper multi-tenant: non-superadmin dikunci ke institusinya sendiri.
// Superadmin boleh menyasar institusi lain lewat body/query, tapi kalau tidak
// menyebut apa pun dia jatuh ke institusinya sendiri (tanpa ini, akun seed
// superadmin tak bisa memakai halaman Kelas sama sekali).
function tenantId(req, bodyInst) {
  if (req.user.role === 'superadmin') return bodyInst ?? req.query.institution_id ?? req.user.institution_id ?? null;
  return req.user.institution_id;
}

function needTenant(req, res, bodyInst) {
  const id = tenantId(req, bodyInst);
  if (!id) {
    res.status(400).json({ status: false, error: true, code: 'VALIDATION_ERROR', message: 'institution_id wajib.', details: null, data: null, requestId: res.locals.requestId });
    return null;
  }
  return Number(id);
}

// Ujian hanya boleh disentuh pemiliknya. Dipakai di rute yang cuma memakai id
// (cetak, kunci) supaya sekolah lain tak bisa menebak id.
async function ujianMilik(inst, examId) {
  if (!inst) return false;
  const r = await pool.query('SELECT id FROM exams WHERE id=$1 AND institution_id=$2', [examId, inst]);
  return r.rowCount > 0;
}

module.exports = { tenantId, needTenant, ujianMilik };
