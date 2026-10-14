// Abstraksi LLM: dukung anthropic + openai_compatible (Apmix, OpenAI, OpenRouter, Ollama).
// Provider baru = tambah 1 fungsi di sini + daftarkan ptype, tanpa ubah fitur lain.
const { AppError } = require('../../lib/errors');

async function callOpenAICompatible({ baseUrl, apiKey, model, messages, timeoutMs = 60000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages }),
    });
    if (!r.ok) throw new AppError('LLM_ERROR', `LLM ${r.status}`, { status: r.status });
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    if (e.name === 'AbortError') throw new AppError('LLM_TIMEOUT', 'LLM timeout');
    throw e.code ? e : new AppError('LLM_ERROR', e.message);
  } finally {
    clearTimeout(t);
  }
}

async function callAnthropic({ apiKey, model, messages, timeoutMs = 60000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const rest = messages.filter((m) => m.role !== 'system');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4000, system: system || undefined, messages: rest }),
    });
    if (!r.ok) throw new AppError('LLM_ERROR', `LLM ${r.status}`, { status: r.status });
    const j = await r.json();
    return j.content?.map((c) => c.text || '').join('') ?? '';
  } catch (e) {
    if (e.name === 'AbortError') throw new AppError('LLM_TIMEOUT', 'LLM timeout');
    throw e.code ? e : new AppError('LLM_ERROR', e.message);
  } finally {
    clearTimeout(t);
  }
}

function fromEnv() {
  return {
    ptype: 'openai_compatible',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.apmix.ai/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_DEFAULT_MODEL || 'auto',
  };
}

async function generateText(messages, opts = {}) {
  const cfg = opts.provider || fromEnv();
  if (!cfg.apiKey) throw new AppError('LLM_ERROR', 'LLM_API_KEY kosong (isi .env)');
  if (cfg.ptype === 'anthropic') return callAnthropic({ ...cfg, messages });
  return callOpenAICompatible({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: opts.model || cfg.model, messages });
}

module.exports = { generateText, fromEnv };
