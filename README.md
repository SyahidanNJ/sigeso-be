# sigeso-be

Backend Sigeso (Sistem Generator Soal). Express + PostgreSQL + pg-boss.

## Jalan lokal (Windows)

1. Instal PostgreSQL 17, buat DB `sigeso_db`
2. `copy .env.example .env` lalu isi `JWT_SECRET`, `LLM_API_KEY`
3. `npm install`
4. `npm run migrate`
5. `npm run dev` → `GET /api/v1/health`
