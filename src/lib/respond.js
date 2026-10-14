function ok(res, data, message) {
  return res.json({ success: true, data: data ?? null, message: message || 'OK', requestId: res.locals.requestId });
}

function fail(res, httpStatus, code, message, details) {
  return res.status(httpStatus).json({
    success: false,
    error: { code, message, details: details ?? null },
    requestId: res.locals.requestId,
  });
}

module.exports = { ok, fail };
