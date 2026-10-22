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

function kopTypst({ kop, inst, logos = {} }) {
  const pemerintah = String(kop?.header_markdown || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const bagian = [
    pemerintah.length ? pemerintah.map((l) => `#text(size: 10pt)[${esc(l)}]`).join(' \\\n') : '',
    pemerintah.length ? '#v(3pt)' : '',
    `#text(size: 14pt, weight: "bold")[${esc(String(inst?.name || '').toUpperCase())}]`,
    ...(inst?.address ? ['#v(1pt)', `#text(size: 9pt)[${esc(inst.address)}]`] : []),
  ].filter(Boolean);

  // Tinggi sama untuk kedua logo; lebar mengikuti rasio asli agar tak gepeng.
  const gambar = (f) => (f ? `#image("${f}", width: 2cm, height: 1.8cm, fit: "contain")` : '');
  return `#grid(
  columns: (2.2cm, 1fr, 2.2cm),
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
  const titik = '#line(length: 100%, stroke: (paint: black, thickness: 0.5pt, dash: "dotted"))';
  const baris = [
    ['Mata Pelajaran', esc(exam.mapel || '-')],
    ['Hari/tanggal', titik],
    ['Kelas', esc(kelasCetak(exam.kelas))],
    ['Waktu', titik],
  ];
  return `#v(6pt)
#table(
  columns: (3.2cm, 0.3cm, 1fr),
  stroke: none,
  inset: (x: 0pt, y: 3pt),
${baris.map(([a, b]) => `  [${a}], [:], [${b}],`).join('\n')}
)
`;
}

function identitasTypst({ student, exam, qr }) {
  return `#v(1pt)
#line(length: 100%, stroke: 0.6pt)
#v(2pt)
#grid(
  columns: (1fr, auto),
  align: (left + top, right + top),
  [
    Nama: #strong[${esc(student.name)}] \\
    NIS: ${esc(student.nis)} \\
    Kelas: ${esc(kelasCetak(exam.kelas))}
  ],
  [#image("${qr}", width: 1.6cm)],
)
#v(2pt)
#line(length: 100%, stroke: 0.6pt)
`;
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

function lembarJawabanTypst({ student, exam, qr, items }) {
  const baris = items.map((q) => `[${q.nomor}], [#box(stroke: 0.5pt, width: 4cm, inset: 4pt)[ ]], []`).join(',\n');
  return `#pagebreak()
#align(center)[#text(size: 13pt, weight: "bold")[LEMBAR JAWABAN]]
#v(4pt)
#grid(
  columns: (1fr, auto),
  align: (left + top, right + top),
  [
    Nama: #strong[${esc(student.name)}] \\
    NIS: ${esc(student.nis)} \\
    Kelas: ${esc(kelasCetak(exam.kelas))} \\
    Mata Pelajaran: ${esc(exam.mapel || '-')}
  ],
  [#image("${qr}", width: 1.8cm)],
)
#v(6pt)
#table(
  columns: (1.4cm, 5cm, 1fr),
  inset: 5pt,
  [*No*], [*Jawaban*], [*Nilai*],
${baris}
)
`;
}

module.exports = { esc, JENIS, copyLogos, kopTypst, judulTypst, metaTypst, identitasTypst, soalTypst, lembarJawabanTypst };
