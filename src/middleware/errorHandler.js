const logger = require('../lib/logger');
const { fail } = require('../lib/respond');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.httpStatus || 500;
  const code = err.httpStatus ? err.code : 'DB_ERROR';
  logger.error({ err, requestId: res.locals.requestId, path: req.path }, err.message);
  return fail(res, status, code, status >= 500 ? 'Terjadi kesalahan server.' : err.message, null);
}

module.exports = errorHandler;
