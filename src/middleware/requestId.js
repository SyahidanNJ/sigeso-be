const { randomUUID } = require('crypto');

function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || `req-${randomUUID().slice(0, 8)}`;
  res.locals.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}

module.exports = requestId;
