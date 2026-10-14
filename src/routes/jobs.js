const express = require('express');
const { pool } = require('../db/pool');
const { ok } = require('../lib/respond');
const { auth } = require('../middleware/auth');

const r = express.Router();
r.use(auth);

// Polling status job asinkron (termasuk generate). Frontend polling tiap 2 dtk.
r.get('/jobs/:id', async (req, res, next) => {
  try {
    const q = await pool.query('SELECT * FROM app_jobs WHERE id=$1', [req.params.id]);
    if (!q.rowCount) return ok(res, null, 'Job tak ada.');
    ok(res, q.rows[0]);
  } catch (e) { next(e); }
});
r.get('/jobs', async (req, res, next) => {
  try {
    if (!req.query.request_id) return ok(res, []);
    ok(res, (await pool.query('SELECT * FROM app_jobs WHERE request_id=$1 ORDER BY id DESC', [req.query.request_id])).rows);
  } catch (e) { next(e); }
});

module.exports = r;
