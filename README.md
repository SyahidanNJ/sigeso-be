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

## Jalan lokal (Windows)

1. Instal PostgreSQL 17, buat DB `sigeso_db` (atau `docker compose up -d db`).
2. Instal Typst + Pandoc, isi `TYPST_BIN` / `PANDOC_BIN` di `.env`.
3. `copy .env.example .env` → isi `JWT_SECRET`, `LLM_API_KEY`.
4. `npm install` → `npm run migrate` → `npm run seed` → `npm run seed:demo`.
5. `npm run dev` → cek `GET /api/v1/health` (database, pandoc, typst).
6. Login: `POST /api/v1/auth/login` (seed: `admin@sigeso.local` /
   `ganti-password-ini`).

`seed` membuat sekolah + akun superadmin; `seed:demo` menambahkan 3 kelas,
6 mapel, materi beserta soal, dan 6 ujian siap cetak. Keduanya aman dijalankan
berulang.

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

## Docker

`docker compose up` menjalankan `db` (Postgres 17) dan `be` (Dockerfile di repo
ini, sudah termasuk Typst + Pandoc), lalu membuka `http://localhost:3001`.

## Struktur

```
src/
  routes/        titik masuk per grup endpoint (tipis)
  controllers/   logika tiap grup (auth, master, bank, sources, print, ...)
  db/            migrasi, seed, seed demo
  middleware/    auth, validasi, log ringkas, error handler
  services/      LLM, render Typst/Pandoc, ekstraksi materi
```
