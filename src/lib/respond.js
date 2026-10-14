function ok(res, data, message, code) {
  return res.json({
    status: true,
    error: false,
    code: code || 'success',
    message: message || 'Success',
    data: data ?? null,
    requestId: res.locals.requestId,
  });
}

function fail(res, httpStatus, code, message, details) {
  return res.status(httpStatus).json({
    status: false,
    error: true,
    code,
    message,
    details: details ?? null,
    data: null,
    requestId: res.locals.requestId,
  });
}

module.exports = { ok, fail };
