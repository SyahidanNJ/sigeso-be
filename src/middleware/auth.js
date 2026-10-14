const jwt = require('jsonwebtoken');
const { fail } = require('../lib/respond');

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), process.env.JWT_SECRET || 'dev');
    next();
  } catch {
    return fail(res, 401, 'UNAUTHORIZED', 'Token tidak valid atau kedaluwarsa.');
  }
}

function roles(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) return fail(res, 403, 'FORBIDDEN', 'Akses ditolak untuk peran Anda.');
    next();
  };
}

module.exports = { auth, roles };
