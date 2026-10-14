# sigeso-be

Backend Sigeso (Sistem Generator Soal). Express + PostgreSQL + Typst + Pandoc.

## Jalan lokal (Windows)

1. Instal PostgreSQL 17, buat DB `sigeso_db` (atau `docker compose up db`)
2. Instal Typst + Pandoc, isi `TYPST_BIN` / `PANDOC_BIN` di `.env`
3. `copy .env.example .env` → isi `JWT_SECRET`, `LLM_API_KEY`
4. `npm install` → `npm run migrate` → `npm run seed`
5. `npm run dev` → `GET /api/v1/health`
6. Login: `POST /api/v1/auth/login` (seed: `admin@sigeso.local`)

## Endpoint ringkas (`/api/v1`)

auth, institutions, users, letterheads, classes, students(+/import),
subjects, topics, chapters, subchapters, sources(+/upload,+/url),
questions, generate, exams(+/:id/items, +/:id/print, +/:id/sheets, +/:id/export),
sheets/:id/reprint, submissions(+/upload, /:id/review, /:id/finalize),
llm/test, llm-usage, jobs, downloads, health.

Semua respons: `{success, data|error{code,message}, requestId}`.

## Produksi (Linux, 1 VPS)

`docker compose up --build -d` lalu `docker compose exec be npm run migrate`
dan `npm run seed`. Estimasi VPS 2GB ≈ Rp100-150rb/bln.
