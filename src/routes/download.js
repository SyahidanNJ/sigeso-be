const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { auth } = require('../middleware/auth');

const r = express.Router();
r.use(auth);

// Unduhan terpadu untuk uploads/print dan uploads/export (auth wajib, anti traversal).
r.get('/downloads/*', async (req, res) => {
  const rel = req.params[0] || '';
  if (rel.includes('..') || path.isAbsolute(rel)) return fail(res, 400, 'VALIDATION_ERROR', 'Path tak valid.');
  const base = path.join(__dirname, '..', '..', 'uploads');
  const f = path.join(base, rel);
  if (!f.startsWith(base) || !fs.existsSync(f)) return fail(res, 404, 'NOT_FOUND', 'File tak ada.');
  res.download(f);
});

module.exports = r;
