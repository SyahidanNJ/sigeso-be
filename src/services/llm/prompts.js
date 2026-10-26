const { z } = require('zod');

const GeneratedQ = z.object({
  qtype: z.enum(['PG', 'ISIAN', 'URAIAN']),
  text: z.string().min(10),
  options: z.array(z.string()).optional(),
  answer_key: z.string().min(1),
  weight: z.number().positive().default(1),
  rubric: z.string().optional(),
}).superRefine((q, ctx) => {
  if (q.qtype === 'PG') {
    if (!q.options || q.options.length < 2) ctx.addIssue({ code: 'custom', message: 'PG wajib ≥2 opsi' });
    else if (!/^[A-Z]$/.test(q.answer_key) || q.answer_key.charCodeAt(0) - 65 >= q.options.length) {
      ctx.addIssue({ code: 'custom', message: 'answer_key PG harus huruf dalam rentang opsi' });
    }
  }
});

// Materi hanya konteks tambahan. Tanpa materi, soal disusun dari mapel, topik,
// dan tingkat supaya guru tetap bisa membuat soal tanpa mengunggah berkas.
function buildGeneratePrompt({ mapel, topik, tingkat, materi, count, qtypes }) {
  const sumber = materi && materi.trim()
    ? `Gunakan materi berikut sebagai acuan utama:\n---\n${materi.slice(0, 12000)}\n---`
    : 'Tidak ada berkas materi. Susun soal dari topik di atas sesuai kurikulum Merdeka untuk tingkat tersebut.';
  return [
    { role: 'system', content: 'Kamu pembuat soal kurikulum Merdeka untuk guru Indonesia. Jawab HANYA JSON valid sesuai schema, tanpa teks lain. Bahasa Indonesia. Jangan mengarang fakta di luar materi.' },
    { role: 'user', content: `Buat tepat ${count} soal (${qtypes.join(', ')}) untuk:\nMata pelajaran: ${mapel}\nTingkat: kelas ${tingkat}\nTopik: ${topik}\n\n${sumber}\n\nFormat: {"questions":[{"qtype":"PG|ISIAN|URAIAN","text":"...","options":["...","..."],"answer_key":"B","weight":1,"rubric":"..."}]}. Untuk PG tulis 4 pilihan tanpa huruf di depan (bukan "A. ..."), answer_key satu huruf besar. Semua tipe wajib punya answer_key terisi; untuk URAIAN isi jawaban intinya, bukan rubrik penilaian.` },
  ];
}

// Model kadang tetap menulis "A. Jakarta" atau "B. 784" walau sudah diminta
// tanpa huruf. Rapikan dulu supaya penilaian Zod tidak menolak seluruh set.
function rapikanHasil(mentah) {
  const daftar = Array.isArray(mentah?.questions) ? mentah.questions : [];
  return {
    ...mentah,
    questions: daftar.map((q) => {
      const qtype = ['PG', 'ISIAN', 'URAIAN'].includes(q?.qtype) ? q.qtype : 'PG';
      const options = Array.isArray(q?.options)
        ? q.options.map((o) => String(o).replace(/^\s*[A-Za-z][.)]\s*/, '').trim()).filter(Boolean)
        : undefined;
      const kunci = String(q?.answer_key ?? '').trim();
      const awal = (kunci.match(/^[A-Za-z]/) || [''])[0].toUpperCase();
      return {
        ...q,
        qtype,
        text: String(q?.text ?? '').trim(),
        options: qtype === 'PG' ? options : undefined,
        answer_key: qtype === 'PG' ? awal : kunci,
        weight: Number(q?.weight) > 0 ? Number(q.weight) : 1,
        rubric: q?.rubric ? String(q.rubric) : undefined,
      };
    }),
  };
}

// Model kadang mengembalikan satu soal cacat (mis. kunci URAIAN kosong). Soal
// cacat dibuang satu per satu supaya soal lain di set yang sama tetap terpakai.
function saringSoal(bersih) {
  const daftar = Array.isArray(bersih?.questions) ? bersih.questions : [];
  return daftar.flatMap((q) => {
    const v = GeneratedQ.safeParse(q);
    return v.success ? [v.data] : [];
  });
}

function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM tidak mengembalikan JSON');
  return JSON.parse(m[0]);
}

const GradeOut = z.object({
  pg: z.array(z.object({ nomor: z.coerce.number().int(), terbaca: z.string().default(''), benar: z.boolean() })).default([]),
  uraian: z.array(z.object({ nomor: z.coerce.number().int(), saran: z.coerce.number().default(0), maks: z.coerce.number().default(0), alasan: z.string().default(''), readable: z.boolean().default(true) })).default([]),
  feedback: z.string().default(''),
});

function buildGradePrompt(kunci) {
  return `Lihat foto lembar jawaban. Kunci: ${kunci}. Huruf opsi tercetak kecil (a-d), jadi bandingkan tanpa peduli huruf besar/kecil. Untuk PG baca huruf jawaban tiap nomor, bandingkan dengan kunci. Uraian hanya saran skor 0-maks + alasan. Bila tulisan tak terbaca, readable:false dan jangan menebak. Jawab HANYA JSON: {"pg":[{"nomor":1,"terbaca":"B","benar":true}],"uraian":[{"nomor":11,"saran":7,"maks":10,"alasan":"...","readable":true}],"feedback":"..."}`;
}

module.exports = { buildGeneratePrompt, rapikanHasil, saringSoal, parseJson, GradeOut, buildGradePrompt };
