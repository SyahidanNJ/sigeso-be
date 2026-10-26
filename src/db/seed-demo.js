require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Data contoh yang mengikuti alur aplikasi:
// sekolah -> kop -> kelas -> mapel > topik > bab > subbab -> materi -> soal -> ujian.
// Aman dijalankan berulang: yang sudah ada dipakai ulang.
const TAHUN = '2026/2027';
const DIR_SUMBER = path.join(__dirname, '..', '..', 'uploads', 'sources');

const KELAS = [
  { name: 'Kelas 4', jenjang: 'SD', level: 4 },
  { name: 'Kelas 5', jenjang: 'SD', level: 5 },
  { name: 'Kelas 6', jenjang: 'SD', level: 6 },
];

// Soal per paket materi. PG: kunci satu huruf. ISIAN/URAIAN: kunci teks.
const PAKET = [
  {
    mapel: 'Matematika', tingkat: 4, topik: 'Bilangan Cacah', bab: 'Operasi Hitung', subbab: 'Penjumlahan dan Pengurangan',
    ujian: 'Ulangan Harian: Penjumlahan dan Pengurangan Kelas 4',
    materi: `Penjumlahan dan Pengurangan Bilangan Cacah

Bilangan cacah dimulai dari 0, 1, 2, 3, dan seterusnya. Tidak ada bilangan negatif
dan tidak ada pecahan di dalamnya.

Menjumlah dan mengurang lebih mudah dengan cara bersusun. Susun bilangan sejajar
menurut nilai tempat, yaitu satuan di bawah satuan, puluhan di bawah puluhan,
kemudian hitung mulai dari satuan. Contoh: 356 + 428. Satuan: 6 + 8 = 14, tulis 4
dan simpan 1 ke puluhan. Puluhan: 5 + 2 + 1 = 8. Ratusan: 3 + 4 = 7. Hasilnya 784.

Pada pengurangan, bila angka di atas lebih kecil, pinjam satu dari nilai tempat di
sebelah kirinya. Contoh: 702 - 254. Satuan: 2 - 4 tidak cukup, pinjam 1 menjadi
12 - 4 = 8. Puluhan: 9 - 5 = 4. Ratusan: 6 - 2 = 4. Hasilnya 448.

Soal cerita: kata "bertambah", "membeli lagi", "seluruhnya" menandakan penjumlahan.
Kata "terjual", "diberikan", "sisa" menandakan pengurangan.
`,
    soal: [
      { qtype: 'PG', text: 'Hasil dari 356 + 428 adalah ....', options: ['764', '774', '784', '794'], answer_key: 'C', weight: 1 },
      { qtype: 'PG', text: 'Hasil dari 702 - 254 adalah ....', options: ['438', '448', '458', '548'], answer_key: 'B', weight: 1 },
      { qtype: 'ISIAN', text: 'Hasil dari 245 + 189 = ....', answer_key: '434', weight: 2 },
      { qtype: 'ISIAN', text: 'Hasil dari 600 - 275 = ....', answer_key: '325', weight: 2 },
      { qtype: 'URAIAN', text: 'Di perpustakaan ada 425 buku cerita dan 148 buku pelajaran. Berapa jumlah seluruh buku? Tuliskan cara menghitungnya.', answer_key: '573', weight: 3, rubric: 'Benar 3: operasi 425 + 148 ditulis dan hasilnya 573. Benar 2: cara benar, hasil salah. Benar 1: hanya menulis operasinya.' },
    ],
  },
  {
    mapel: 'Matematika', tingkat: 5, topik: 'Pecahan', bab: 'Pecahan Sederhana', subbab: 'Penjumlahan Pecahan',
    ujian: 'Ulangan Harian: Penjumlahan Pecahan',
    materi: `Penjumlahan Pecahan

Pecahan terdiri atas pembilang (angka di atas) dan penyebut (angka di bawah).
Contoh 2/5: pembilang 2, penyebut 5.

Bila penyebutnya sama, cukup jumlahkan pembilangnya dan penyebutnya tetap.
Contoh: 1/4 + 2/4 = (1 + 2)/4 = 3/4.

Bila penyebutnya berbeda, samakan penyebut lebih dulu dengan mencari kelipatan
persekutuan terkecil (KPK) dari penyebutnya. Contoh: 1/2 + 1/4. KPK dari 2 dan 4
adalah 4, sehingga 1/2 diubah menjadi 2/4. Lalu 2/4 + 1/4 = 3/4.

Hasil penjumlahan sebaiknya ditulis dalam bentuk paling sederhana. Contoh 6/8
disederhanakan menjadi 3/4 karena pembilang dan penyebut sama-sama dibagi 2.

Soal cerita pecahan sering muncul dalam kehidupan sehari-hari, misalnya membagi
bahan masakan atau luas lahan.
`,
    soal: [
      { qtype: 'PG', text: 'Hasil dari 1/4 + 2/4 adalah ....', options: ['1/2', '2/4', '3/4', '3/8'], answer_key: 'C', weight: 1 },
      { qtype: 'PG', text: 'Hasil dari 3/8 + 2/8 adalah ....', options: ['5/8', '5/16', '1/8', '6/8'], answer_key: 'A', weight: 1 },
      { qtype: 'ISIAN', text: 'Hasil dari 2/5 + 1/5 = ....', answer_key: '3/5', weight: 2 },
      { qtype: 'ISIAN', text: 'Hasil dari 1/2 + 1/4 = ....', answer_key: '3/4', weight: 2 },
      { qtype: 'URAIAN', text: 'Ibu memakai 2/6 kg gula untuk membuat kue dan 3/6 kg untuk membuat teh. Berapa kg gula yang dipakai Ibu? Tuliskan cara menghitungnya.', answer_key: '5/6', weight: 3, rubric: 'Benar 3: 2/6 + 3/6 ditulis dan hasilnya 5/6. Benar 2: cara benar, hasil salah. Benar 1: hanya menulis operasinya.' },
    ],
  },
  {
    mapel: 'Matematika', tingkat: 6, topik: 'Bilangan Cacah', bab: 'Operasi Hitung', subbab: 'Penjumlahan dan Pengurangan',
    ujian: 'Ulangan Harian: Operasi Hitung Bilangan Cacah',
    materi: `Penjumlahan dan Pengurangan Bilangan Cacah

Bilangan cacah adalah bilangan yang dimulai dari 0, 1, 2, 3, dan seterusnya. Bilangan
cacah tidak memuat bilangan negatif dan tidak memuat pecahan.

Setiap angka pada bilangan cacah memiliki nilai tempat. Contoh pada bilangan 4.275:
angka 4 menempati ribuan, angka 2 menempati ratusan, angka 7 menempati puluhan, dan
angka 5 menempati satuan.

Menjumlahkan bilangan cacah dapat dilakukan dengan cara bersusun. Tulis bilangan
sejajar menurut nilai tempatnya, satuan dengan satuan, puluhan dengan puluhan, lalu
jumlahkan mulai dari satuan. Contoh: 4.275 + 1.386. Satuan: 5 + 6 = 11, tulis 1 dan
simpan 1 ke puluhan. Puluhan: 7 + 8 + 1 = 16, tulis 6 dan simpan 1 ke ratusan.
Ratusan: 2 + 3 + 1 = 6. Ribuan: 4 + 1 = 5. Hasilnya 5.661.

Mengurangkan bilangan cacah juga dilakukan secara bersusun. Jika angka di atas lebih
kecil daripada angka di bawahnya, kita meminjam satu dari nilai tempat di sebelah
kirinya. Contoh: 8.500 - 2.375. Satuan: 0 - 5 tidak cukup, pinjam 1 dari puluhan
menjadi 10 - 5 = 5. Puluhan: 9 - 7 = 2. Ratusan: 4 - 3 = 1. Ribuan: 8 - 2 = 6.
Hasilnya 6.125.

Penjumlahan bersifat komutatif, artinya urutan bilangan tidak mengubah hasil:
3 + 5 sama dengan 5 + 3. Pengurangan tidak komutatif.

Soal cerita sering memakai penjumlahan dan pengurangan. Bila sesuatu bertambah,
digunakan penjumlahan. Bila sesuatu berkurang, terjual, atau diberikan, digunakan
pengurangan. Contoh: sebuah toko memiliki 2.450 buku, lalu 1.275 buku terjual.
Sisa buku adalah 2.450 - 1.275 = 1.175 buku.
`,
    soal: [
      { qtype: 'PG', text: 'Hasil dari 4.275 + 1.386 adalah ....', options: ['5.561', '5.661', '5.651', '5.761'], answer_key: 'B', weight: 1 },
      { qtype: 'PG', text: 'Hasil dari 8.500 - 2.375 adalah ....', options: ['6.125', '6.225', '6.135', '5.125'], answer_key: 'A', weight: 1 },
      { qtype: 'ISIAN', text: 'Hasil dari 3.467 + 2.958 = ....', answer_key: '6425', weight: 2 },
      { qtype: 'ISIAN', text: 'Hasil dari 7.204 - 3.869 = ....', answer_key: '3335', weight: 2 },
      { qtype: 'URAIAN', text: 'Sebuah toko buku memiliki 2.450 buku. Sebanyak 1.275 buku terjual. Berapa sisa buku di toko? Tuliskan langkah menghitungnya.', answer_key: '1.175', weight: 3, rubric: 'Benar 3: langkah pengurangan ditulis dan hasil akhir 1.175. Benar 2: langkah benar, hasil akhir salah. Benar 1: hanya menulis operasi tanpa menghitung.' },
      { qtype: 'URAIAN', text: 'Jelaskan cara menjumlahkan bilangan cacah dengan cara bersusun, lalu hitung 456 + 789.', answer_key: '1.245', weight: 3, rubric: 'Benar 3: penjelasan menyebut nilai tempat/menyimpan dan hasil akhir 1.245. Benar 2: cara benar, hasil akhir salah. Benar 1: hanya menyebut cara tanpa menghitung.' },
    ],
  },
  {
    mapel: 'Bahasa Indonesia', tingkat: 6, topik: 'Teks Laporan', bab: 'Isi Laporan', subbab: 'Menemukan Ide Pokok',
    ujian: 'Ulangan Harian: Ide Pokok Teks Laporan',
    materi: `Menemukan Ide Pokok pada Teks Laporan

Teks laporan adalah teks yang berisi hasil pengamatan atau penelitian terhadap suatu
objek. Isinya ditulis berdasarkan fakta yang benar-benar dilihat, bukan karangan.

Setiap paragraf memiliki satu ide pokok. Ide pokok adalah gagasan yang menjadi dasar
pengembangan paragraf. Ide pokok biasanya terdapat pada kalimat utama, sedangkan
kalimat lainnya disebut kalimat penjelas.

Kalimat utama sering berada di awal paragraf, tetapi dapat juga di akhir paragraf.
Cara menemukan ide pokok: bacalah seluruh paragraf, cari kalimat yang bersifat umum,
lalu tentukan gagasan yang dibahas oleh kalimat-kalimat penjelas.

Contoh paragraf: "Air sangat penting bagi makhluk hidup. Tumbuhan memerlukan air
untuk tumbuh. Hewan memerlukan air untuk minum. Manusia memerlukan air untuk minum
dan memasak." Ide pokok paragraf tersebut adalah air sangat penting bagi makhluk
hidup.
`,
    soal: [
      { qtype: 'PG', text: 'Kalimat yang memuat gagasan utama sebuah paragraf disebut ....', options: ['kalimat utama', 'kalimat penjelas', 'kalimat perintah', 'kalimat tanya'], answer_key: 'A', weight: 1 },
      { qtype: 'PG', text: 'Teks yang berisi hasil pengamatan atau penelitian disebut teks ....', options: ['fabel', 'laporan', 'puisi', 'dialog'], answer_key: 'B', weight: 1 },
      { qtype: 'ISIAN', text: 'Gagasan yang menjadi dasar pengembangan sebuah paragraf disebut ... pokok.', answer_key: 'ide', weight: 2 },
      { qtype: 'ISIAN', text: 'Sebelum menulis teks laporan, penulis melakukan ... terhadap objek yang diamati.', answer_key: 'pengamatan', weight: 2 },
      { qtype: 'URAIAN', text: 'Tuliskan satu paragraf singkat tentang pengamatanmu di kelas, lalu sebutkan ide pokok paragraf tersebut.', answer_key: 'Ada paragraf hasil pengamatan dan ide pokoknya disebutkan', weight: 3, rubric: 'Benar 3: paragraf berisi hasil pengamatan dan ide pokok tepat. Benar 2: paragraf benar, ide pokok kurang tepat. Benar 1: hanya menulis paragraf tanpa ide pokok.' },
    ],
  },
  {
    mapel: 'IPA', tingkat: 5, topik: 'Gaya dan Gerak', bab: 'Jenis Gaya', subbab: 'Gaya Gesek',
    ujian: 'Ulangan Harian: Gaya Gesek',
    materi: `Gaya Gesek

Gaya adalah tarikan atau dorongan yang dapat mengubah gerak benda. Salah satu jenis
gaya adalah gaya gesek, yaitu gaya yang timbul ketika dua permukaan bersentuhan.

Besar gaya gesek bergantung pada kasar atau licinnya permukaan. Semakin kasar
permukaan, semakin besar gaya geseknya. Semakin licin permukaan, semakin kecil gaya
geseknya.

Gaya gesek ada yang menguntungkan dan ada yang merugikan. Menguntungkan misalnya
membuat kita tidak terpeleset saat berjalan dan membuat rem sepeda bekerja. Merugikan
misalnya mengikis permukaan ban dan bagian mesin yang bergesekan.

Gaya gesek dapat diperbesar dengan membuat permukaan kasar, misalnya bintik-bintik
pada sol sepatu sepak bola. Gaya gesek dapat diperkecil dengan memberi oli, memberi
roda, atau membuat permukaan menjadi licin.
`,
    soal: [
      { qtype: 'PG', text: 'Gaya yang timbul ketika dua permukaan bersentuhan disebut gaya ....', options: ['magnet', 'gesek', 'gravitasi', 'listrik'], answer_key: 'B', weight: 1 },
      { qtype: 'PG', text: 'Permukaan yang licin membuat gaya gesek semakin ....', options: ['besar', 'kecil', 'sama', 'tetap'], answer_key: 'B', weight: 1 },
      { qtype: 'ISIAN', text: 'Gaya gesek dapat ... gerak benda, sehingga benda melambat lalu berhenti.', answer_key: 'menghambat', weight: 2 },
      { qtype: 'ISIAN', text: 'Sol sepatu sepak bola dibuat berbintik agar gaya gesek semakin ....', answer_key: 'besar', weight: 2 },
      { qtype: 'URAIAN', text: 'Jelaskan mengapa jalan licin saat hujan berbahaya, lalu sebutkan dua cara mengurangi bahayanya.', answer_key: 'Jalan licin membuat gaya gesek kecil. Bahaya dikurangi dengan berjalan pelan, memakai alas kaki bersol kasar, atau menabur pasir.', weight: 3, rubric: 'Benar 3: alasan gaya gesek kecil dan dua cara tepat. Benar 2: alasan benar, satu cara. Benar 1: hanya menyebut jalan licin.' },
    ],
  },
  {
    mapel: 'IPA', tingkat: 6, topik: 'Tata Surya', bab: 'Anggota Tata Surya', subbab: 'Planet', kertas: 'F4',
    ujian: 'Ulangan Harian: Anggota Tata Surya',
    materi: `Anggota Tata Surya

Tata Surya adalah kumpulan benda langit yang bergerak mengelilingi Matahari. Matahari
menjadi pusatnya dan merupakan bintang terdekat dengan Bumi.

Delapan planet bergerak mengelilingi Matahari. Urutannya dari yang terdekat:
Merkurius, Venus, Bumi, Mars, Jupiter, Saturnus, Uranus, dan Neptunus. Merkurius
adalah planet terdekat dengan Matahari, sedangkan Jupiter adalah planet terbesar.
Mars dikenal sebagai planet merah karena permukaannya mengandung banyak besi
berkarat.

Selain planet, Tata Surya memiliki anggota lain. Satelit adalah benda langit yang
mengelilingi planet, contohnya Bulan mengelilingi Bumi. Asteroid adalah batuan kecil
yang mengelilingi Matahari dan banyak terdapat di antara Mars dan Jupiter. Komet
adalah benda langit berekor yang tersusun dari debu dan es. Meteor adalah batuan yang
terbakar ketika memasuki atmosfer Bumi.
`,
    soal: [
      { qtype: 'PG', text: 'Planet yang paling dekat dengan Matahari adalah ....', options: ['Venus', 'Bumi', 'Merkurius', 'Mars'], answer_key: 'C', weight: 1 },
      { qtype: 'PG', text: 'Planet yang dikenal sebagai planet merah adalah ....', options: ['Mars', 'Jupiter', 'Venus', 'Saturnus'], answer_key: 'A', weight: 1 },
      { qtype: 'ISIAN', text: 'Planet terbesar di Tata Surya adalah ....', answer_key: 'Jupiter', weight: 2 },
      { qtype: 'ISIAN', text: 'Bumi menempati urutan ke-... dari Matahari.', answer_key: '3', weight: 2 },
      { qtype: 'URAIAN', text: 'Sebutkan tiga anggota Tata Surya selain planet, lalu jelaskan salah satunya.', answer_key: 'Satelit, asteroid, komet, atau meteor; dijelaskan salah satu', weight: 3, rubric: 'Benar 3: tiga anggota tepat dan satu dijelaskan benar. Benar 2: dua anggota tepat. Benar 1: menyebut anggota tanpa penjelasan.' },
    ],
  },
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const satu = async (sql, p) => (await pool.query(sql, p)).rows[0];
const baris = [];

// Ambil yang ada, buat kalau belum ada (kunci pencariannya nama induk + nama sendiri).
async function cariBuat(cariSql, cariP, buatSql, buatP, label) {
  const ada = await satu(cariSql, cariP);
  if (ada) return ada;
  baris.push(`${label}: baru`);
  return satu(buatSql, buatP);
}

(async () => {
  const inst = await satu('SELECT * FROM institutions ORDER BY id LIMIT 1');
  if (!inst) {
    console.error('Belum ada sekolah. Jalankan dulu: npm run seed');
    process.exit(1);
  }
  const guru = await satu("SELECT id FROM users WHERE institution_id=$1 ORDER BY (role='guru') DESC, id LIMIT 1", [inst.id]);
  const buat = guru?.id || null;

  if (!inst.npsn || !inst.address) {
    await pool.query('UPDATE institutions SET npsn=COALESCE(npsn,$1), address=COALESCE(address,$2) WHERE id=$3', ['20512345', 'Jl. Contoh No.1, Kec. Contoh', inst.id]);
    baris.push('sekolah: NPSN & alamat dilengkapi');
  }

  // Kop surat A4 & F4
  for (const [ukuran, nama] of [['A4', 'Kop Sekolah'], ['F4', 'Kop Sekolah F4']]) {
    const ada = await satu('SELECT id FROM letterhead_templates WHERE institution_id=$1 AND name=$2', [inst.id, nama]);
    if (ada) continue;
    await pool.query('INSERT INTO letterhead_templates(institution_id,name,paper_size,header_markdown,is_default) VALUES($1,$2,$3,$4,true)',
      [inst.id, nama, ukuran, 'PEMERINTAH KABUPATEN CONTOH\nDINAS PENDIDIKAN']);
    baris.push(`kop ${ukuran}: baru`);
  }

  // Kelas (tanpa siswa: alur cetak sekarang satu lembar per kelas)
  const kelasId = {};
  for (const k of KELAS) {
    const kelas = await cariBuat(
      'SELECT * FROM classes WHERE institution_id=$1 AND name=$2 ORDER BY id LIMIT 1', [inst.id, k.name],
      'INSERT INTO classes(institution_id,name,academic_year,jenjang,level) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [inst.id, k.name, TAHUN, k.jenjang, k.level], `kelas ${k.name}`);
    kelasId[k.level] = kelas.id;
    baris.push(`kelas ${k.name}: #${kelas.id}`);
  }

  // Materi > soal > ujian, satu paket satu putaran
  for (const p of PAKET) {
    const mapel = await cariBuat('SELECT * FROM subjects WHERE institution_id=$1 AND grade_level=$2 AND lower(name)=lower($3) ORDER BY id LIMIT 1', [inst.id, p.tingkat, p.mapel],
      'INSERT INTO subjects(institution_id,grade_level,name) VALUES($1,$2,$3) RETURNING *', [inst.id, p.tingkat, p.mapel], `mapel ${p.mapel} (t${p.tingkat})`);
    const topik = await cariBuat('SELECT * FROM topics WHERE subject_id=$1 AND lower(name)=lower($2) AND (created_by=$3 OR created_by IS NULL) ORDER BY id LIMIT 1', [mapel.id, p.topik, buat],
      'INSERT INTO topics(subject_id,created_by,name) VALUES($1,$2,$3) RETURNING *', [mapel.id, buat, p.topik], `topik ${p.topik} (t${p.tingkat})`);
    const bab = await cariBuat('SELECT * FROM chapters WHERE topic_id=$1 AND name=$2 ORDER BY id LIMIT 1', [topik.id, p.bab],
      'INSERT INTO chapters(topic_id,name) VALUES($1,$2) RETURNING *', [topik.id, p.bab], `bab ${p.bab}`);
    const sub = await cariBuat('SELECT * FROM sub_chapters WHERE chapter_id=$1 AND name=$2 ORDER BY id LIMIT 1', [bab.id, p.subbab],
      'INSERT INTO sub_chapters(chapter_id,name) VALUES($1,$2) RETURNING *', [bab.id, p.subbab], `subbab ${p.subbab} (${p.mapel} t${p.tingkat})`);

    let sumber = await satu("SELECT * FROM sources WHERE sub_chapter_id=$1 AND status='done' ORDER BY id LIMIT 1", [sub.id]);
    if (!sumber) {
      fs.mkdirSync(DIR_SUMBER, { recursive: true });
      const berkas = path.join(DIR_SUMBER, `demo-${p.mapel}-t${p.tingkat}-${p.subbab}.txt`.toLowerCase().replace(/\s+/g, '-'));
      fs.writeFileSync(berkas, p.materi);
      sumber = await satu("INSERT INTO sources(institution_id,sub_chapter_id,kind,file_path,extracted_path,status,created_by) VALUES($1,$2,'upload',$3,$3,'done',$4) RETURNING *", [inst.id, sub.id, berkas, buat]);
      baris.push(`materi ${p.mapel} t${p.tingkat} > ${p.subbab}: 1 berkas`);
    }

    const nSoal = Number((await satu('SELECT COUNT(*)::int n FROM questions WHERE sub_chapter_id=$1', [sub.id])).n);
    if (!nSoal) {
      for (const s of p.soal) {
        await pool.query(
          'INSERT INTO questions(institution_id,subject_id,topic_id,chapter_id,sub_chapter_id,qtype,text,options,answer_key,weight,rubric,source_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [inst.id, mapel.id, topik.id, bab.id, sub.id, s.qtype, s.text, s.options ? JSON.stringify(s.options) : null, s.answer_key, s.weight, s.rubric || null, sumber.id, buat]
        );
      }
      baris.push(`soal ${p.mapel} t${p.tingkat} > ${p.subbab}: ${p.soal.length} butir`);
    }

    let ujian = await satu('SELECT * FROM exams WHERE institution_id=$1 AND class_id=$2 AND title=$3 ORDER BY id LIMIT 1', [inst.id, kelasId[p.tingkat], p.ujian]);
    let ujianBaru = false;
    if (!ujian) {
      ujian = await satu('INSERT INTO exams(institution_id,subject_id,class_id,title,mode,paper_size,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [inst.id, mapel.id, kelasId[p.tingkat], p.ujian, 'SATU_LEMBAR', p.kertas || 'A4', 'draft', buat]);
      ujianBaru = true;
    }
    const nItem = Number((await satu('SELECT COUNT(*)::int n FROM exam_questions WHERE exam_id=$1', [ujian.id])).n);
    if (!nItem) {
      const daftar = (await pool.query('SELECT id FROM questions WHERE sub_chapter_id=$1 ORDER BY id', [sub.id])).rows;
      let no = 1;
      for (const q of daftar) await pool.query('INSERT INTO exam_questions(exam_id,question_id,nomor,approved) VALUES($1,$2,$3,true)', [ujian.id, q.id, no++]);
    }
    baris.push(`ujian ${ujian.title}: #${ujian.id} (${ujianBaru ? 'baru' : 'sudah ada'}, ${ujian.paper_size})`);
  }

  console.log(`SEED SELESAI — ${baris.length} baris data`);
  for (const b of baris) console.log('  - ' + b);
  console.log('\nLangkah lanjut: Ujian > Generate > Setujui soal > Cetak soal dan kunci.');
  await pool.end();
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
