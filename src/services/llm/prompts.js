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
const GeneratedSet = z.object({ questions: z.array(GeneratedQ).min(1) });

function buildGeneratePrompt({ materi, count, qtypes }) {
  return [
    { role: 'system', content: 'Kamu pembuat soal kurikulum Merdeka untuk guru Indonesia. Jawab HANYA JSON valid sesuai schema, tanpa teks lain. Bahasa Indonesia. Jangan mengarang fakta di luar materi.' },
    { role: 'user', content: `Buat ${count} soal (${qtypes.join(', ')}) dari materi:\n---\n${materi.slice(0, 12000)}\n---\nFormat: {"questions":[{"qtype":"PG|ISIAN|URAIAN","text":"...","options":["A. ...","B. ..."],"answer_key":"B","weight":1,"rubric":"..."}]}. Untuk PG, answer_key = huruf opsi.` },
  ];
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

module.exports = { GeneratedSet, buildGeneratePrompt, parseJson, GradeOut, buildGradePrompt };
