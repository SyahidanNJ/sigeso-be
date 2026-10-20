const { ok, fail } = require('../lib/respond');
const { cariSekolah, detailSekolah } = require('../lib/referensi');

// Situs referensi bukan milik kita: batasi pencarian per pengguna supaya satu
// akun yang mengetik cepat tak menghujani server orang. Hanya di memori.
const BATAS_CARI = 20;
const JENDELA_MS = 60 * 1000;
const BATAS_PENGGUNA = 500;
const jejak = new Map();

function lewatBatas(userId) {
  const kini = Date.now();
  const dipakai = (jejak.get(userId) || []).filter((t) => kini - t < JENDELA_MS);
  dipakai.push(kini);
  if (!jejak.has(userId) && jejak.size >= BATAS_PENGGUNA) jejak.delete(jejak.keys().next().value);
  jejak.set(userId, dipakai);
  return dipakai.length > BATAS_CARI;
}

// Pencarian sekolah di data referensi Kemendikdasmen (untuk mengisi data sekolah).
async function cari(req, res) {
  const kata = String(req.query.q || '').trim();
  if (kata.length < 3) return fail(res, 400, 'VALIDATION_ERROR', 'Ketik minimal 3 huruf nama sekolah atau NPSN-nya.');
  if (lewatBatas(req.user.id)) return fail(res, 429, 'QUOTA_EXCEEDED', 'Terlalu banyak pencarian dalam waktu singkat. Tunggu sebentar, atau isi datanya manual.');
  ok(res, await cariSekolah(kata));
}

async function detail(req, res) {
  const npsn = String(req.params.npsn || '').trim();
  // NPSN umumnya angka, tapi ada juga yang memuat huruf (PKBM, sekolah luar negeri).
  if (!/^[A-Za-z0-9]{4,12}$/.test(npsn)) return fail(res, 400, 'VALIDATION_ERROR', 'NPSN tidak sah.');
  ok(res, await detailSekolah(npsn));
}

module.exports = { cari, detail };
