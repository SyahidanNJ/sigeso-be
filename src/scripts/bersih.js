// Pembersih berkas yatim: berkas di uploads/ yang tak lagi dirujuk database.
// Bawaannya cuma menampilkan daftar (dry-run). Tambahkan --hapus untuk membuang.
// Berkas yang lebih baru dari 24 jam tak disentuh supaya tak menabrak proses yang
// sedang menulis (cetak/ekspor berjalan, unggahan baru).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const { UPLOAD } = require('../lib/berkas');

const HAPUS = process.argv.includes('--hapus');
const BATAS_UMUR = 24 * 60 * 60 * 1000;

function semuaBerkas(dir, hasil = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) semuaBerkas(f, hasil); else hasil.push(f);
  }
  return hasil;
}

function ukuran(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

(async () => {
  if (!pool) { console.error('Database belum dikonfigurasi (.env).'); process.exit(1); }
  if (!fs.existsSync(UPLOAD)) { console.log('Folder uploads/ belum ada — tidak ada yang perlu dibersihkan.'); return; }

  const ref = new Set();
  const dirRef = [];
  const tambah = (p) => {
    if (!p) return;
    const f = path.resolve(p);
    if (!f.startsWith(path.resolve(UPLOAD) + path.sep)) return;
    if (!fs.existsSync(f)) return;
    if (fs.statSync(f).isDirectory()) dirRef.push(f); else ref.add(f);
  };

  (await pool.query('SELECT file_path, extracted_path FROM sources')).rows.forEach((s) => { tambah(s.file_path); tambah(s.extracted_path); });
  (await pool.query('SELECT file_path FROM submission_images')).rows.forEach((s) => tambah(s.file_path));
  // pdf_path menyimpan folder job cetak, jadi seluruh isinya dianggap terpakai.
  (await pool.query('SELECT pdf_path FROM exam_sheets WHERE pdf_path IS NOT NULL')).rows.forEach((s) => tambah(s.pdf_path));
  (await pool.query('SELECT rel_path FROM generated_files')).rows.forEach((s) => tambah(path.join(UPLOAD, s.rel_path)));
  (await pool.query('SELECT logo_path, logo_left_path FROM institutions')).rows.forEach((s) => {
    if (s.logo_path) tambah(path.resolve(UPLOAD, s.logo_path));
    if (s.logo_left_path) tambah(path.resolve(UPLOAD, s.logo_left_path));
  });

  const kini = Date.now();
  const kandidat = [];
  for (const f of semuaBerkas(UPLOAD)) {
    const f2 = path.resolve(f);
    if (ref.has(f2)) continue;
    if (dirRef.some((d) => f2.startsWith(d + path.sep))) continue;
    const st = fs.statSync(f2);
    if (kini - st.mtimeMs < BATAS_UMUR) continue;
    kandidat.push({ f: f2, size: st.size });
  }

  kandidat.sort((a, b) => b.size - a.size);
  const total = kandidat.reduce((a, k) => a + k.size, 0);

  if (!kandidat.length) {
    console.log(`Bersih. ${ref.size} berkas dirujuk, ${dirRef.length} folder job dipakai, tidak ada yatim.`);
    return;
  }

  const per = {};
  for (const k of kandidat) {
    const g = path.relative(UPLOAD, k.f).split(path.sep)[0];
    per[g] = (per[g] || 0) + k.size;
  }

  console.log(`${kandidat.length} berkas tak dirujuk database (${ukuran(total)}):`);
  Object.entries(per).sort((a, b) => b[1] - a[1]).forEach(([g, n]) => console.log(`  ${ukuran(n).padStart(8)}  ${g}/`));
  // Saat daftarnya masih wajar, tampilkan semuanya supaya bisa diperiksa satu per satu.
  const tampil = kandidat.length <= 60 ? kandidat : kandidat.slice(0, 20);
  console.log('\nBerkas:');
  tampil.forEach((k) => console.log(`  ${ukuran(k.size).padStart(8)}  ${path.relative(UPLOAD, k.f)}`));
  if (tampil.length < kandidat.length) console.log(`  … dan ${kandidat.length - tampil.length} berkas lain.`);

  if (!HAPUS) {
    console.log('\nBelum ada yang dihapus. Jalankan "npm run bersih -- --hapus" kalau daftar ini sudah benar.');
    return;
  }

  let berhasil = 0;
  for (const k of kandidat) {
    try { fs.rmSync(k.f, { force: true }); berhasil += 1; } catch { /* biarkan, coba lagi nanti */ }
  }
  // Folder job yang jadi kosong ikut dibuang; folder bersama (print/export/sources/
  // jawaban) tetap ada supaya unggahan berikutnya punya tempat.
  const sisaKosong = [];
  (function sapu(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) sapu(path.join(dir, e.name));
    }
    if (path.dirname(dir) !== path.resolve(UPLOAD) && fs.readdirSync(dir).length === 0) sisaKosong.push(dir);
  })(UPLOAD);
  sisaKosong.forEach((d) => { try { fs.rmdirSync(d); } catch { /* biarkan */ } });

  console.log(`\n${berhasil} berkas dihapus (${ukuran(total)}), ${sisaKosong.length} folder kosong dibersihkan.`);
})().catch((e) => { console.error('Gagal:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
