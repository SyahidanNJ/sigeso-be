const logger = require('../lib/logger');
const { fail } = require('../lib/respond');

function pesanZod(err) {
  try {
    return 'Input tak valid: ' + err.issues.map((i) => `${(i.path || []).join('.') || 'form'} (${i.message})`).join('; ');
  } catch {
    return 'Input tak valid.';
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // ZodError.message adalah getter (tak bisa dioverwrite) → balas langsung.
  if (err && err.name === 'ZodError') {
    logger.warn({ requestId: res.locals.requestId, path: req.path }, 'validasi gagal');
    return fail(res, 400, 'VALIDATION_ERROR', pesanZod(err), null);
  }
  const status = err.httpStatus || 500;
  const code = err.httpStatus ? err.code : 'DB_ERROR';
  logger.error({ err, requestId: res.locals.requestId, path: req.path }, err.message);
  return fail(res, status, code, status >= 500 ? 'Terjadi kesalahan server.' : err.message, null);
}

module.exports = errorHandler;
