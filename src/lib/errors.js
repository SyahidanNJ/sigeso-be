const CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  QUOTA_EXCEEDED: 429,
  SOURCE_SCRAPE_FAILED: 502,
  // Situs referensi hidup, tapi bentuk halaman/datanya berubah.
  SOURCE_CHANGED: 502,
  SOURCE_BLOCKED_SSRF: 400,
  LLM_TIMEOUT: 504,
  LLM_INVALID_JSON: 502,
  // Model membalas, tapi isinya tak bisa dibaca sebagai penilaian (mis. prosa).
  LLM_UNREADABLE: 502,
  LLM_ERROR: 502,
  QR_NOT_FOUND: 400,
  PAGES_INCOMPLETE: 400,
  PANDOC_FAILED: 500,
  EXPORT_FAILED: 500,
  // SMTP belum diisi di .env, atau pengirimannya ditolak penyedia.
  MAIL_NOT_CONFIGURED: 500,
  MAIL_FAILED: 502,
  DB_ERROR: 500,
};

class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.httpStatus = CODES[code] || 500;
  }
}

module.exports = { CODES, AppError };
