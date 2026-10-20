const cheerio = require('cheerio');
const { AppError } = require('./errors');

// Data referensi sekolah dari situs Kemendikdasmen. Situs itu tidak punya API,
// jadi halaman HTML-nya yang diurai. Semua yang rapuh (URL + pola urai)
// dikumpulkan di sini supaya cukup satu berkas untuk diperbaiki kalau berubah.
const BASE = 'https://referensi.data.kemendikdasmen.go.id';
const TIMEOUT_MS = 8000;
const MAKS_BYTE = 3 * 1024 * 1024;
const UA = 'SigesoBot/1.0 (+atribusi sumber)';

// Cache di memori saja: hasil pilihan guru nanti tersimpan permanen di tabel
// institutions, jadi cache ini cuma meredam pencarian berulang ke situs orang.
const cache = new Map();
const BATAS_ENTRI = 200;

function dariCache(kunci) {
  const isi = cache.get(kunci);
  if (!isi) return null;
  if (Date.now() > isi.sampai) { cache.delete(kunci); return null; }
  return isi.nilai;
}
function keCache(kunci, nilai, ttlMs) {
  if (cache.size >= BATAS_ENTRI) cache.delete(cache.keys().next().value);
  cache.set(kunci, { nilai, sampai: Date.now() + ttlMs });
}

const entitas = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

const bersih = (s) => entitas(s).replace(/\s+/g, ' ').trim();

// Situs ini menulis nama wilayah dengan huruf besar semua; dibuat wajar dulu.
const rapikan = (s) => {
  if (!s || s !== s.toUpperCase()) return s;
  return s.split(' ').map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(' ');
};

async function ambilHtml(url) {
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AppError('SOURCE_SCRAPE_FAILED', 'Data referensi Kemendikdasmen sedang tidak bisa dihubungi.');
  }
  if (!r.ok) throw new AppError('SOURCE_SCRAPE_FAILED', 'Data referensi Kemendikdasmen menolak permintaan.');
  const html = await r.text();
  if (html.length > MAKS_BYTE) throw new AppError('SOURCE_SCRAPE_FAILED', 'Halaman referensi tak terduga besar, dibatalkan.');
  return html;
}

// Hasil pencarian bukan HTML, tapi kode JavaScript yang tertanam di halaman:
//   linknpsn = "<a href=.../pendidikan/npsn/20328861 ...>20328861</a>";
//   data.push([1, linknpsn, "SMP NEGERI 01 SEMARANG", "Kec. Semarang Barat", "Kota Semarang", setatus]);
// Jadi parsernya satu pola yang menangkap keempat isinya sekaligus. NPSN boleh
// memuat huruf (mis. P9948177 untuk PKBM, 9LN01112 untuk sekolah luar negeri).
const POLA_HASIL = /npsn\/([A-Za-z0-9]+)[\s\S]{0,900}?data\.push\(\[\s*\d+\s*,\s*linknpsn\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/g;
const MAKS_TAMPIL = 25;

async function cariSekolah(kata) {
  const kunci = `cari:${kata.toLowerCase()}`;
  const tersimpan = dariCache(kunci);
  if (tersimpan) return tersimpan;

  const html = await ambilHtml(`${BASE}/pendidikan/cari/${encodeURIComponent(kata)}`);
  const hasil = [];
  for (const m of html.matchAll(POLA_HASIL)) {
    hasil.push({ npsn: m[1], nama: bersih(m[2]), kecamatan: bersih(m[3]), kabkota: bersih(m[4]) });
  }
  // Hasil nol memang tidak mencetak baris apa pun. Kalau ada baris tercetak tapi
  // tak satu pun terbaca, berarti bentuk situsnya berubah. (Sebagian kecil yang
  // gagal terbaca masih ditoleransi — 25 baris teratas sudah cukup untuk memilih.)
  if (!hasil.length && (html.match(/linknpsn =/g) || []).length) {
    throw new AppError('SOURCE_CHANGED', 'Bentuk data di situs referensi berubah, pencarian otomatis dimatikan sementara.');
  }

  // Situs memotong di 1000 baris; yang dikirim ke layar cukup 25 teratas.
  const nilai = { total: hasil.length, terpotong: hasil.length >= 1000, hasil: hasil.slice(0, MAKS_TAMPIL) };
  keCache(kunci, nilai, 10 * 60 * 1000);
  return nilai;
}

const LABEL = {
  'Nama': 'nama',
  'Alamat': 'alamat',
  'Desa/Kelurahan': 'desa',
  'Kecamatan/Kota (LN)': 'kecamatan',
  'Kab.-Kota/Negara (LN)': 'kabkota',
  'Propinsi/Luar Negeri (LN)': 'provinsi',
  'Status Sekolah': 'status',
  'Bentuk Pendidikan': 'bentuk',
  'Jenjang Pendidikan': 'jenjang',
};

// Wilayah yang dipakai menyusun alamat. Kalau salah satu tak terbaca, gurunya
// diberi tahu supaya tak menyimpan alamat setengah jadi tanpa sadar.
const WILAYAH = [['desa', 'Desa/Kelurahan'], ['kecamatan', 'Kecamatan'], ['kabkota', 'Kabupaten/Kota'], ['provinsi', 'Provinsi']];

// Situs menjawab NPSN yang tak ada bukan dengan halaman kosong, tapi dengan
// baris contoh bernama ini. Kalau suatu saat tulisannya berganti, akibatnya
// hanya nama aneh muncul di form — bukan data yang hilang.
const NAMA_KOSONG = 'Satuan Pendidikan Bukan Indonesia';

async function detailSekolah(npsn) {
  const kunci = `npsn:${npsn}`;
  const tersimpan = dariCache(kunci);
  if (tersimpan) return tersimpan;

  const html = await ambilHtml(`${BASE}/pendidikan/npsn/${npsn}`);
  const $ = cheerio.load(html);
  const data = { npsn };
  // Tabelnya berbentuk <td>Label</td><td>:</td><td>Isi</td>.
  $('td').each((_, td) => {
    const field = LABEL[$(td).text().trim()];
    if (!field) return;
    const $td = $(td);
    if ($td.next('td').text().trim() !== ':') return;
    const isi = bersih($td.nextAll('td').eq(1).text());
    data[field] = !isi || isi === '-' ? null : isi;
  });
  // Tak satu pun label dikenal = bentuk tabel di situs berubah, bukan sekolahnya
  // yang tak ada. Dua keadaan itu berbeda, dan pesannya harus berbeda.
  if (Object.keys(data).length <= 1) throw new AppError('SOURCE_CHANGED', 'Bentuk data di situs referensi berubah.');
  if (!data.nama || data.nama === NAMA_KOSONG) throw new AppError('NOT_FOUND', 'Sekolah dengan NPSN itu tak ada di data referensi.');

  for (const f of ['desa', 'kecamatan', 'kabkota', 'provinsi']) if (data[f]) data[f] = rapikan(data[f]);
  data.wilayah_kurang = WILAYAH.filter(([f]) => !data[f]).map(([, label]) => label);
  // Satu baris alamat siap pakai untuk kolom alamat sekolah.
  data.alamat_lengkap = [data.alamat, data.desa, data.kecamatan, data.kabkota, data.provinsi]
    .filter(Boolean).join(', ');

  keCache(kunci, data, 24 * 60 * 60 * 1000);
  return data;
}

module.exports = { cariSekolah, detailSekolah };
