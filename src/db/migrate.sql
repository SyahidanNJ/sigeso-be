CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS institutions(id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT, npsn VARCHAR(20), logo_path TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS letterhead_templates(id SERIAL PRIMARY KEY, institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL, paper_size TEXT NOT NULL CHECK(paper_size IN ('A4','F4')), header_markdown TEXT NOT NULL,
  reference_docx_path TEXT, is_default BOOLEAN DEFAULT false);
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, institution_id INT REFERENCES institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email CITEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('superadmin','admin','guru')), monthly_token_quota INT DEFAULT 500000, is_active BOOLEAN DEFAULT true);
CREATE TABLE IF NOT EXISTS classes(id SERIAL PRIMARY KEY, institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL, academic_year TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS students(id SERIAL PRIMARY KEY, class_id INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL, nis VARCHAR(30) NOT NULL, is_active BOOLEAN DEFAULT true, UNIQUE(class_id, nis));
CREATE TABLE IF NOT EXISTS subjects(id SERIAL PRIMARY KEY, institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS topics(id SERIAL PRIMARY KEY, subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE, grade_level INT NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chapters(id SERIAL PRIMARY KEY, topic_id INT NOT NULL REFERENCES topics(id) ON DELETE CASCADE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sub_chapters(id SERIAL PRIMARY KEY, chapter_id INT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id SERIAL PRIMARY KEY, institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  sub_chapter_id INT REFERENCES sub_chapters(id), kind TEXT CHECK(kind IN ('upload','url')),
  original_url TEXT, file_path TEXT, extracted_path TEXT, status TEXT DEFAULT 'pending', error TEXT, created_by INT REFERENCES users(id));
CREATE TABLE IF NOT EXISTS questions(id SERIAL PRIMARY KEY, institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  subject_id INT REFERENCES subjects(id), topic_id INT REFERENCES topics(id), chapter_id INT REFERENCES chapters(id), sub_chapter_id INT REFERENCES sub_chapters(id),
  qtype TEXT CHECK(qtype IN ('PG','ISIAN','URAIAN')), text TEXT NOT NULL, options JSONB, answer_key TEXT NOT NULL,
  weight NUMERIC DEFAULT 1, rubric TEXT, source_id INT REFERENCES sources(id), created_by INT REFERENCES users(id), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS exams(id SERIAL PRIMARY KEY, institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  subject_id INT REFERENCES subjects(id), class_id INT NOT NULL REFERENCES classes(id),
  title TEXT NOT NULL, mode TEXT CHECK(mode IN ('SATU_LEMBAR','TERPISAH','HEMAT')) DEFAULT 'SATU_LEMBAR',
  paper_size TEXT CHECK(paper_size IN ('A4','F4')) DEFAULT 'A4', status TEXT DEFAULT 'draft', created_by INT REFERENCES users(id));
CREATE TABLE IF NOT EXISTS exam_questions(exam_id INT REFERENCES exams(id) ON DELETE CASCADE, question_id INT REFERENCES questions(id),
  nomor INT NOT NULL, weight_override NUMERIC, PRIMARY KEY(exam_id, question_id));
CREATE TABLE IF NOT EXISTS exam_sheets(id SERIAL PRIMARY KEY, exam_id INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE, qr_base TEXT UNIQUE NOT NULL, pdf_path TEXT, UNIQUE(exam_id, student_id));
CREATE TABLE IF NOT EXISTS exam_sheet_pages(id SERIAL PRIMARY KEY, sheet_id INT NOT NULL REFERENCES exam_sheets(id) ON DELETE CASCADE,
  page_no INT NOT NULL, qr_code TEXT UNIQUE NOT NULL, UNIQUE(sheet_id, page_no));
CREATE TABLE IF NOT EXISTS submissions(id SERIAL PRIMARY KEY, sheet_id INT UNIQUE NOT NULL REFERENCES exam_sheets(id) ON DELETE CASCADE,
  status TEXT CHECK(status IN ('needs_review','final')) DEFAULT 'needs_review',
  pg_score NUMERIC, essay_suggested JSONB, final_score NUMERIC, feedback TEXT, graded_by INT REFERENCES users(id), finalized_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS submission_images(id SERIAL PRIMARY KEY, submission_id INT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  page_no INT, file_path TEXT NOT NULL, qr_detected TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS llm_providers(id SERIAL PRIMARY KEY, institution_id INT REFERENCES institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL, ptype TEXT CHECK(ptype IN ('anthropic','openai_compatible')) NOT NULL,
  base_url TEXT, api_key_enc TEXT NOT NULL, models JSONB NOT NULL, purpose TEXT DEFAULT 'both', is_active BOOLEAN DEFAULT true);
CREATE TABLE IF NOT EXISTS llm_usage_logs(id SERIAL PRIMARY KEY, request_id TEXT NOT NULL, user_id INT REFERENCES users(id),
  institution_id INT REFERENCES institutions(id), feature TEXT, provider_id INT REFERENCES llm_providers(id),
  model TEXT, in_tokens INT, out_tokens INT, cost_usd NUMERIC, duration_ms INT, status TEXT, error_code TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS app_jobs(id SERIAL PRIMARY KEY, request_id TEXT NOT NULL, job_type TEXT NOT NULL, status TEXT DEFAULT 'pending',
  progress INT DEFAULT 0, payload JSONB, result JSONB, error TEXT, attempts INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs(id SERIAL PRIMARY KEY, request_id TEXT, user_id INT REFERENCES users(id),
  institution_id INT REFERENCES institutions(id), action TEXT NOT NULL, entity TEXT, entity_id INT, meta JSONB, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_qr_pages ON exam_sheet_pages(qr_code);
CREATE INDEX IF NOT EXISTS idx_sub_img ON submission_images(submission_id);
CREATE INDEX IF NOT EXISTS idx_llm_req ON llm_usage_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_q_bank ON questions(institution_id, subject_id, topic_id);
-- Hitungan cetak tak dipakai
ALTER TABLE exam_sheets DROP COLUMN IF EXISTS print_count;
-- Tingkat kesulitan dibuang: tak pernah ditampilkan atau dipakai di layar mana pun.
ALTER TABLE questions DROP COLUMN IF EXISTS difficulty;
-- Jenjang + tingkat kelas: SD/MI 1-6, SMP 7-9, SMA 10-12.
ALTER TABLE classes ADD COLUMN IF NOT EXISTS jenjang TEXT CHECK(jenjang IN ('SD','SMP','SMA'));
ALTER TABLE classes ADD COLUMN IF NOT EXISTS level INT;
-- Nama asli berkas materi; multer menyimpan nama acak tanpa ekstensi.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS original_name TEXT;
-- Berkas hasil cetak/ekspor dicatat supaya bisa ikut terhapus bersama ujiannya
-- (sebelumnya hanya ditulis ke disk, tak ada yang tahu pemiliknya).
CREATE TABLE IF NOT EXISTS generated_files(
  id SERIAL PRIMARY KEY,
  institution_id INT REFERENCES institutions(id) ON DELETE CASCADE,
  exam_id INT REFERENCES exams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_generated_exam ON generated_files(exam_id);
-- Kelas lama (tanpa jenjang) dibuang; siswa & ujiannya ikut terhapus.
DELETE FROM exams WHERE class_id IN (SELECT id FROM classes WHERE jenjang IS NULL);
DELETE FROM classes WHERE jenjang IS NULL;
