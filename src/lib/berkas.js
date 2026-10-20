const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');

const UPLOAD = path.join(__dirname, '..', '..', 'uploads');

// Path absolut → path relatif terhadap uploads (disimpan dengan garis miring "/").
function relDiUploads(abs) {
  const f = path.resolve(abs);
  if (!f.startsWith(path.resolve(UPLOAD) + path.sep)) return null;
  return path.relative(UPLOAD, f).split(path.sep).join('/');
}

function absolut(rel) {
  const f = path.resolve(UPLOAD, rel);
  return f.startsWith(path.resolve(UPLOAD) + path.sep) ? f : null;
}

// Job cetak/ekspor menaruh beberapa berkas dalam satu folder: exam-*, reprint-*,
// dokumen-*, nilai-*. Folder bersama (print/export/sources/jawaban) tak boleh dibuang.
const FOLDER_JOB = /^(exam|reprint|dokumen|nilai)-/;

// Catat hasil cetak/ekspor. Gagal mencatat tak boleh membatalkan unduhan yang sudah jadi.
async function catatBerkas({ institution_id, exam_id, kind, rel }) {
  if (!rel) return;
  try {
    await pool.query('INSERT INTO generated_files(institution_id,exam_id,kind,rel_path) VALUES($1,$2,$3,$4)',
      [institution_id || null, exam_id || null, kind, rel]);
  } catch { /* pembersih tetap bisa menyusul */ }
}

// Hapus berkas yang tercatat, sekaligus foldernya kalau itu folder job.
function hapusBerkasRel(daftar) {
  for (const rel of daftar) {
    const f = rel && absolut(rel);
    if (!f) continue;
    try { fs.rmSync(f, { force: true }); } catch { /* sudah tak ada */ }
    const induk = path.dirname(f);
    if (FOLDER_JOB.test(path.basename(induk))) {
      try { fs.rmSync(induk, { recursive: true, force: true }); } catch { /* biarkan */ }
    }
  }
}

module.exports = { UPLOAD, relDiUploads, absolut, catatBerkas, hapusBerkasRel, FOLDER_JOB };
