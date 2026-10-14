const express = require('express');
const { ok, fail } = require('../lib/respond');
const { generateText } = require('../services/llm');

const router = express.Router();

// Tes koneksi provider default (env). Body opsional: { model }
router.post('/test', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const text = await generateText([{ role: 'user', content: 'Balas: ok' }], { model: req.body?.model });
    return ok(res, { reply: String(text).slice(0, 200), duration_ms: Date.now() - t0 }, 'LLM terhubung.');
  } catch (e) {
    next(e);
  }
});

router.post('/client-errors', (req, res) => ok(res, null, 'Tercatat.'));

module.exports = router;
