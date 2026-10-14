const fs = require('fs');
const path = require('path');
const { fail } = require('../lib/respond');

// Unduhan terpadu (auth wajib, anti traversal). Berkas cetak ada di uploads/print,
// ekspor di uploads/export — cari di keduanya agar path lama tetap jalan.
function cariBerkas(base, rel) {
  const f = path.join(base, rel);
  if (f.startsWith(base) && fs.existsSync(f)) return f;
  const g = path.join(base, 'print', rel);
  if (g.startsWith(path.join(base, 'print')) && fs.existsSync(g)) return g;
  return null;
}

async function download(req, res) {
  const rel = req.params[0] || '';
  if (rel.includes('..') || path.isAbsolute(rel)) return fail(res, 400, 'VALIDATION_ERROR', 'Path tak valid.');
  const base = path.join(__dirname, '..', '..', 'uploads');
  const f = cariBerkas(base, rel);
  if (!f) return fail(res, 404, 'NOT_FOUND', 'File tak ada.');
  res.download(f);
}

module.exports = { download };
