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

router.get('/', async (req, res) => {
  const db = await dbStatus();
  res.setHeader('Cache-Control', 'no-store');
  return ok(res, {
    status: db.ok ? 'ok' : 'degraded',
    database: db,
    pandoc: bin('pandoc --version'),
    typst: bin('typst --version'),
  });
});

module.exports = router;
