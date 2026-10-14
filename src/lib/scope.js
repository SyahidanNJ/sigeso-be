// Helper multi-tenant: non-superadmin dikunci ke institusinya sendiri.
function tenantId(req, bodyInst) {
  if (req.user.role === 'superadmin') return bodyInst ?? req.query.institution_id ?? null;
  return req.user.institution_id;
}

function needTenant(req, res, bodyInst) {
  const id = tenantId(req, bodyInst);
  if (!id) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'institution_id wajib.' }, requestId: res.locals.requestId });
    return null;
  }
  return Number(id);
}

module.exports = { tenantId, needTenant };
