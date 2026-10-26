const fs = require('fs');
const path = require('path');
const { UPLOAD } = require('../../lib/berkas');
const { rapikanGambar } = require('../../lib/gambar');

// Potongan Typst untuk lembar cetak. Dipakai bersama oleh cetak, cetak ulang,
// dan ekspor dokumen supaya ketiganya tak pernah berbeda layout.

function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/[#*_`$@<>\[\]]/g, (c) => '\\' + c);
}

// Nama kelas di database sudah berbentuk "Kelas 4"; label cetak juga "Kelas".
function kelasCetak(kelas) {
  return String(kelas || '-').replace(/^kelas\s+/i, '');
}

const JENIS = {
  PG: { huruf: 'A', label: 'PILIHAN GANDA', petunjuk: 'Berilah tanda silang (×) pada huruf a, b, c, atau d pada jawaban yang paling tepat!' },
  ISIAN: { huruf: 'B', label: 'ISIAN', petunjuk: 'Isilah titik-titik berikut dengan jawaban yang benar!' },
  URAIAN: { huruf: 'C', label: 'URAIAN', petunjuk: 'Jawablah pertanyaan berikut dengan uraian yang jelas!' },
};

// Typst mencari gambar relatif terhadap file .typ, jadi logo disalin ke folder job.
// Pinggiran kosong dipotong dulu agar kedua logo terlihat sama besar.
function copyLogos(jobDir, inst) {
  const hasil = { kiri: null, kanan: null };
  const dasar = path.resolve(UPLOAD);
  for (const [sisi, rel] of [['kiri', inst?.logo_left_path], ['kanan', inst?.logo_path]]) {
    if (!rel) continue;
    const src = path.resolve(dasar, rel);
    if (!src.startsWith(dasar + path.sep) || !fs.existsSync(src)) continue;
    const nama = `logo-${sisi}.png`;
    if (rapikanGambar(src, path.join(jobDir, nama))) {
      hasil[sisi] = nama;
      continue;
    }
    const asli = `logo-${sisi}${path.extname(src).toLowerCase()}`;
    fs.copyFileSync(src, path.join(jobDir, asli));
    hasil[sisi] = asli;
  }
  return hasil;
}

// Madrasah (Kemenag) vs sekolah dinas. \b mencegah "SMA"/"MALANG" dianggap "MA".
const MADRASAH = /\b(?:RA|BA|MI|MIS|MIN|MTS|MTSN|MTSS|MA|MAS|MAN|MAK|MAKN)\b|RAUDHATUL ATHFAL|BUSTANUL ATHFAL|MADRASAH (?:IBTIDAIYAH|TSANAWIYAH|ALIYAH)/i;

function wilayah(alamat) {
  const s = String(alamat || '');
  const kab = /\bKab(?:upaten)?\.?\s+([^,]+)/i.exec(s);
  if (kab) return `KABUPATEN ${kab[1].trim().toUpperCase()}`;
  const kota = /\bKota\s+([^,]+)/i.exec(s);
  return kota ? `KOTA ${kota[1].trim().toUpperCase()}` : '';
}

// Kop otomatis: dua baris instansi di atas nama sekolah.
function kopOtomatis(inst) {
  const w = wilayah(inst?.address);
  if (MADRASAH.test(String(inst?.name || ''))) {
    return ['KEMENTERIAN AGAMA REPUBLIK INDONESIA', w ? `KANTOR KEMENTERIAN AGAMA ${w}` : ''].filter(Boolean);
  }
  return w ? [`PEMERINTAH ${w}`, 'DINAS PENDIDIKAN'] : [];
}

function kopTypst({ kop, inst, logos = {} }) {
  const nama = String(inst?.name || '').trim();
  const alamat = String(inst?.address || '').trim();
  const manual = String(kop?.header_markdown || '').split('\n').map((s) => s.trim()).filter(Boolean);
  // Kop manual dipakai bila diisi; baris yang menduplikasi nama/alamat dibuang
  // karena keduanya sudah dicetak di bawahnya.
  const pemerintah = (manual.length ? manual : kopOtomatis(inst))
    .filter((s) => s.toLowerCase() !== nama.toLowerCase() && s.toLowerCase() !== alamat.toLowerCase());
  const bagian = [
    pemerintah.length
      ? `#block[#set par(leading: 0.45em)\n${pemerintah.map((l) => `#text(size: 10pt, weight: "bold")[${esc(l)}]`).join(' \\\n')}]`
      : '',
    pemerintah.length ? '#v(3pt)' : '',
    `#text(size: 14pt, weight: "bold")[${esc(nama.toUpperCase())}]`,
    ...(alamat ? ['#v(1pt)', `#text(size: 9pt)[${esc(alamat)}]`] : []),
  ].filter(Boolean);

  // Tinggi sama untuk kedua logo; lebar mengikuti rasio asli agar tak gepeng.
  const gambar = (f) => (f ? `#image("${f}", width: 2.6cm, height: 2.3cm, fit: "contain")` : '');
  return `#grid(
  columns: (2.8cm, 1fr, 2.8cm),
  align: (center + horizon, center + top, center + horizon),
  [${gambar(logos.kiri)}],
  [#set align(center)
${bagian.join('\n')}],
  [${gambar(logos.kanan)}],
)
#v(3pt)
#line(length: 100%, stroke: 1.2pt)
#v(-7pt)
#line(length: 100%, stroke: 0.5pt)
`;
}

// Judul cetak = jenis ujian, bukan judul bab. Judul bab tetap dipakai di aplikasi.
function judulTypst(exam) {
  const jenis = String(exam.exam_type || exam.title || '').toUpperCase();
  const tahun = exam.academic_year
    ? `\n#align(center)[#text(size: 10pt)[TAHUN PELAJARAN ${esc(exam.academic_year)}]]`
    : '';
  return `#v(6pt)
#align(center)[#text(size: 12pt, weight: "bold")[${esc(jenis)}]]${tahun}
`;
}

function metaTypst(exam) {
  // Garis isian memakai garis bawah sel, bukan #line di dalam sel: #line tak
  // punya tinggi sehingga menempel di atas teks.
  const isian = 'table.cell(stroke: (bottom: (paint: black, thickness: 0.5pt, dash: "dotted")))[]';
  const baris = [
    ['Mata Pelajaran', `[${esc(exam.mapel || '-')}]`],
    ['Hari/tanggal', isian],
    ['Waktu', isian],
  ];
  return `#v(6pt)
#table(
  columns: (3.2cm, 0.3cm, 1fr),
  stroke: none,
  inset: (x: 0pt, y: 2pt),
${baris.map(([a, b]) => `  [${a}], [:], ${b},`).join('\n')}
)
`;
}

// Lembar soal dipakai satu kelas, jadi identitas siswa dikosongkan dan diisi tangan.
function identitasKosongTypst(exam) {
  const isian = 'table.cell(stroke: (bottom: (paint: black, thickness: 0.5pt, dash: "dotted")))[]';
  return `#v(2pt)
#line(length: 100%, stroke: 0.6pt)
#v(2pt)
#table(
  columns: (2.4cm, 0.2cm, 1fr, 2.4cm, 0.2cm, 1fr),
  stroke: none,
  inset: (x: 0pt, y: 3pt),
  [Nama], [:], ${isian}, [Kelas], [:], [${esc(kelasCetak(exam.kelas))}],
  [NIS], [:], ${isian}, [No. Absen], [:], ${isian},
)
#v(2pt)
#line(length: 100%, stroke: 0.6pt)
`;
}

// Kunci jawaban: satu tabel per jenis soal, plus rubrik uraian bila ada.
function kunciTypst(items) {
  const bagian = (t) => {
    const isi = items.filter((q) => q.qtype === t);
    if (!isi.length) return '';
    const sel = isi.map((q) => `  [${q.nomor}], [${esc(q.answer_key)}${q.rubric ? ` #linebreak() #text(size: 8.5pt, style: "italic")[${esc(q.rubric)}]` : ''}],`).join('\n');
    return `#v(8pt)
#text(size: 11pt, weight: "bold")[${JENIS[t].huruf}. ${JENIS[t].label}]
#v(4pt)
#table(
  columns: (1.2cm, 1fr),
  inset: (x: 4pt, y: 5pt),
  [*No*], [*Kunci*],
${sel}
)
`;
  };
  return `#v(6pt)
#align(center)[#text(size: 13pt, weight: "bold")[KUNCI JAWABAN]]
${['PG', 'ISIAN', 'URAIAN'].map(bagian).join('')}`;
}

function opsiTypst(options) {
  const isi = (options || [])
    .map((o, i) => `#grid(columns: (0.6cm, 1fr), [${String.fromCharCode(97 + i)}.], [${esc(o)}])`)
    .join('\n');
  return `#v(1pt)\n#grid(columns: (0.8cm, 1fr), [], [${isi}])\n`;
}

function soalItem(q) {
  return `#block(breakable: true, inset: (bottom: 6pt))[
  #grid(columns: (0.8cm, 1fr), [${q.nomor}.], [${esc(q.text)}])
${q.qtype === 'PG' ? opsiTypst(q.options) : ''}]
`;
}

function soalTypst(items) {
  let out = '';
  let sebelumnya = null;
  for (const q of items) {
    const j = JENIS[q.qtype];
    // Heading hanya saat jenis berganti. Bila jenis yang sama muncul lagi
    // setelah jenis lain, hurufnya terulang; nomor soal tetap sesuai database.
    if (j && q.qtype !== sebelumnya) {
      // Heading + petunjuk + soal pertama dijaga satu blok supaya tak terpisah halaman.
      out += `#block(breakable: false)[
#v(8pt)
#text(size: 11pt, weight: "bold")[${j.huruf}. ${j.label}]
#v(1pt)
#text(size: 9.5pt, style: "italic")[${esc(j.petunjuk)}]
#v(4pt)
${soalItem(q)}]
`;
      sebelumnya = q.qtype;
      continue;
    }
    out += soalItem(q);
  }
  return out;
}

module.exports = { esc, JENIS, copyLogos, kopOtomatis, kopTypst, judulTypst, metaTypst, identitasKosongTypst, soalTypst, kunciTypst };
