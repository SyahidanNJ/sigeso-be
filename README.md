# sigeso-be

Backend **Sigeso** (Sistem Generator Soal): REST API untuk bank soal per topik,
pembuatan soal dari materi, ujian, dan cetak lembar soal/kunci. Express +
PostgreSQL, dengan Typst dan Pandoc untuk berkas cetak.

Antarmuka penggunanya ada di repo terpisah:
**[sigeso-fe](https://github.com/SyahidanNJ/sigeso-fe)**.

## Yang ditangani

- Autentikasi JWT (login, registrasi guru, reset kata sandi lewat email).
- Master data: sekolah, kop surat, kelas, mapel, topik, materi, pengguna.
- Sumber materi: unggah PDF/DOCX/TXT atau tautan (dengan pemeriksaan SSRF).
- Bank soal: pilihan ganda, isian, uraian; pembuatan soal lewat LLM dan
  penyuntingan manual.
- Ujian: pilih soal per jenis, setujui per butir, hanya soal disetujui yang
  dicetak.
- Cetak: soal dan kunci jawaban (Typst) dalam A4/F4, kop sekolah otomatis.
- Unduhan: berkas hasil cetak dan materi lewat token, bukan URL publik.
- Log satu baris per request (method, path, status, pengguna, requestId).

## Endpoint utama

| Grup | Contoh |
| --- | --- |
| `GET /api/v1/health` | status server, database, Typst, Pandoc |
| `/api/v1/auth/*` | login, daftar, lupa/reset kata sandi |
| `/api/v1/classes`, `/subjects`, `/topics` | master data & pemilih topik |
| `/api/v1/sources/*` | unggah/tautkan materi, baca ulang isinya |
| `/api/v1/questions`, `/generate` | bank soal, buat soal (LLM) |
| `/api/v1/exams/*` | ujian dan butir soalnya |
| `/api/v1/exams/:id/print`, `/answer-key` | render soal/kunci ke PDF (Typst) |
| `/api/v1/jobs/*` | status pekerjaan LLM/cetak yang berjalan lama |
| `/api/v1/downloads/*` | unduh berkas hasil cetak |
