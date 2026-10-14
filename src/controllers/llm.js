const { ok } = require('../lib/respond');
const { generateText } = require('../services/llm');

// Tes koneksi provider default (env). Body opsional: { model }
async function testLlm(req, res) {
  const t0 = Date.now();
  const text = await generateText([{ role: 'user', content: 'Balas: ok' }], { model: req.body?.model });
  return ok(res, { reply: String(text).slice(0, 200), duration_ms: Date.now() - t0 }, 'LLM terhubung.');
}

function clientError(req, res) {
  ok(res, null, 'Tercatat.');
}

module.exports = { testLlm, clientError };
