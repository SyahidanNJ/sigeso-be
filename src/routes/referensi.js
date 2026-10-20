const express = require('express');
const { auth } = require('../middleware/auth');
const { asyncH } = require('../controllers/bantuan');
const c = require('../controllers/referensi');

const r = express.Router();
r.use(auth);

// Data referensi sekolah (sumber luar) — perlu login seperti rute lain.
r.get('/ref/sekolah', asyncH(c.cari));
r.get('/ref/sekolah/:npsn', asyncH(c.detail));

module.exports = r;
