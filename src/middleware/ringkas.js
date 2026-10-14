// Log request satu baris yang enak dibaca manusia (dev).
// Produksi/Docker tetap bisa pakai JSON via REQUEST_LOG=json.
// shortcut: ganti pino-pretty bila butuh warna/filter canggih.
const SENSOR = ['password', 'token', 'authorization', 'apikey', 'api_key', 'api_key_enc', 'nis'];

function ringkasNilai(v) {
  if (Array.isArray(v)) return `[${v.length} item]`;
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + '…' : v;
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SENSOR.includes(k.toLowerCase()) ? '***' : ringkasNilai(val);
    return o;
  }
  return v;
}

function badan(req) {
  const data = { ...req.query, ...req.body };
  for (const k of Object.keys(data)) {
    if (SENSOR.includes(k.toLowerCase())) data[k] = '***';
    else data[k] = ringkasNilai(data[k]);
  }
  const s = JSON.stringify(data);
  return s === '{}' ? '' : ' ' + (s.length > 300 ? s.slice(0, 300) + '…' : s);
}

function ringkas(req, res, next) {
  const t0 = Date.now();
  const full = req.originalUrl.split('?')[0];
  const masuk = `${req.method} ${full}${badan(req)}`;
  res.on('finish', () => {
    const user = req.user ? ` user=${req.user.id}` : '';
    // eslint-disable-next-line no-console
    console.log(`→ ${masuk}\n← ${req.method} ${full} ${res.statusCode} ${Date.now() - t0}ms${user} ${res.locals.requestId || ''}`);
  });
  next();
}

module.exports = ringkas;
