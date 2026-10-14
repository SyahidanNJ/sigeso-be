const express = require('express');
const { execSync } = require('child_process');
const { ok } = require('../lib/respond');
const { dbStatus } = require('../db/pool');

const router = express.Router();
function bin(v) {
  try {
    execSync(v, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const PANDOC = process.env.PANDOC_BIN || 'pandoc';
const TYPST = process.env.TYPST_BIN || 'typst';

router.get('/', async (req, res) => {
  const db = await dbStatus();
  res.setHeader('Cache-Control', 'no-store');
  return ok(res, {
    status: db.ok ? 'ok' : 'degraded',
    database: db,
    pandoc: bin(`"${PANDOC}" --version`),
    typst: bin(`"${TYPST}" --version`),
  });
});

module.exports = router;
