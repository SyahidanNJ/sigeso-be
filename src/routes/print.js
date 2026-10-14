const express = require('express');
const { auth, roles } = require('../middleware/auth');
const { asyncH, GURU } = require('../controllers/bantuan');
const c = require('../controllers/print');

const r = express.Router();
r.use(auth);

r.post('/exams/:id/print', roles(...GURU), asyncH(c.printUjian));
r.get('/exams/:id/sheets', asyncH(c.listSheets));
r.post('/sheets/:id/reprint', roles(...GURU), asyncH(c.reprintSheet));

module.exports = r;
