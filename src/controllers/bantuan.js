const { pool } = require('../db/pool');

const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const GURU = ['superadmin', 'admin', 'guru'];

async function audit(req, action, entity, entity_id, meta) {
  try {
    await pool.query(
      'INSERT INTO audit_logs(request_id,user_id,institution_id,action,entity,entity_id,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [req.requestId || null, req.user.id, req.user.institution_id, action, entity, entity_id, meta || null]
    );
  } catch { /* audit tak boleh menggagalkan aksi */ }
}

module.exports = { asyncH, audit, GURU };
