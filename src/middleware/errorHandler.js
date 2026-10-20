const logger = require('../lib/logger');
const { fail } = require('../lib/respond');

const LABEL = {
  name: 'Nama', academic_year: 'Tahun ajaran', nis: 'NIS',
  title: 'Judul', text: 'Soal', answer_key: 'Kunci jawaban', options: 'Pilihan',
  weight: 'Bobot', rubric: 'Rubrik',
  email: 'Email', password: 'Kata sandi', url: 'URL', qr_code: 'Kode QR',
  final_score: 'Nilai', feedback: 'Masukan', question_ids: 'Soal',
  class_id: 'Kelas', subject_id: 'Mapel', topic_id: 'Topik',
  chapter_id: 'Bab', sub_chapter_id: 'Subbab', grade_level: 'Tingkat kelas',
  paper_size: 'Ukuran kertas', mode: 'Mode', institution_id: 'Institusi',
  header_markdown: 'Kop surat', count: 'Jumlah', qtypes: 'Tipe soal',
  exam_type: 'Jenis ujian',
  rows: 'Baris', file: 'Berkas', foto: 'Foto',
};

function ramah(issue) {
  const field = (issue.path || [])[0];
  const label = LABEL[field] || (field ? String(field) : 'Isian');
  if (issue.code === 'too_small') return `${label} wajib diisi.`;
  if (issue.code === 'too_big') return `${label} kebanyakan/kepanjangan.`;
  if (issue.validation === 'email') return 'Email tak valid, contoh: nama@sekolah.id.';
  if (issue.code === 'invalid_type') return `${label} belum benar.`;
  if (issue.code === 'invalid_enum_value') return `${label} pilihannya tidak dikenal.`;
  return `${label} belum benar.`;
}

function pesanZod(err) {
  try {
    return err.issues.slice(0, 3).map(ramah).join(' ');
  } catch {
    return 'Isian belum benar, periksa lagi.';
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // ZodError.message adalah getter (tak bisa dioverwrite) → balas langsung.
  if (err && err.name === 'ZodError') {
    logger.warn({ requestId: res.locals.requestId, path: req.path }, 'validasi gagal');
    return fail(res, 400, 'VALIDATION_ERROR', pesanZod(err), null);
  }
  // MulterError tak punya httpStatus, jadi tanpa ini unggahan kebesaran
  // dilaporkan sebagai "Terjadi kesalahan server."
  if (err && err.name === 'MulterError') {
    const pesan = err.code === 'LIMIT_FILE_SIZE' ? 'Berkas terlalu besar.' : 'Berkas tidak bisa diunggah.';
    return fail(res, 400, 'VALIDATION_ERROR', pesan, null);
  }
  const status = err.httpStatus || 500;
  const code = err.httpStatus ? err.code : 'DB_ERROR';
  logger.error({ err, requestId: res.locals.requestId, path: req.path }, err.message);
  return fail(res, status, code, status >= 500 ? 'Terjadi kesalahan server.' : err.message, null);
}

module.exports = errorHandler;
