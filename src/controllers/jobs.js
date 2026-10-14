const { pool } = require('../db/pool');
const { ok } = require('../lib/respond');

// Polling status job asinkron (termasuk generate). Frontend polling tiap 2 dtk.
async function getJob(req, res) {
  const q = await pool.query('SELECT * FROM app_jobs WHERE id=$1', [req.params.id]);
  if (!q.rowCount) return ok(res, null, 'Job tak ada.');
  ok(res, q.rows[0]);
}
async function listJobs(req, res) {
  if (!req.query.request_id) return ok(res, []);
  ok(res, (await pool.query('SELECT * FROM app_jobs WHERE request_id=$1 ORDER BY id DESC', [req.query.request_id])).rows);
}

module.exports = { getJob, listJobs };
