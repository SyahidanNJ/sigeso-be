const express = require('express');
const { auth, roles } = require('../middleware/auth');
const { asyncH, GURU } = require('../controllers/bantuan');
const c = require('../controllers/print');

const r = express.Router();
r.use(auth);

// Satu lembar soal untuk difotokopi, plus kunci jawaban sebagai berkas terpisah.
r.post('/exams/:id/print', roles(...GURU), asyncH(c.printUjian));
r.post('/exams/:id/answer-key', roles(...GURU), asyncH(c.kunciJawaban));

module.exports = r;
