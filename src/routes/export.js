const express = require('express');
const { auth, roles } = require('../middleware/auth');
const { asyncH } = require('../controllers/bantuan');
const c = require('../controllers/export');

const r = express.Router();
r.use(auth);

r.get('/exams/:id/export', roles('superadmin', 'admin', 'guru'), asyncH(c.exportNilai));
r.get('/exams/:id/dokumen', roles('superadmin', 'admin', 'guru'), asyncH(c.exportDokumen));

module.exports = r;
