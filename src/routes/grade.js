const express = require('express');
const multer = require('multer');
const path = require('path');
const { auth, roles } = require('../middleware/auth');
const { asyncH, GURU } = require('../controllers/bantuan');
const { AppError } = require('../lib/errors');
const c = require('../controllers/grade');

const r = express.Router();
r.use(auth);

const upload = multer({
  dest: c.DIR,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, f, cb) => {
    const okExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(f.originalname).toLowerCase());
    cb(okExt ? null : new AppError('VALIDATION_ERROR', 'Hanya JPG/PNG/WebP.'), okExt);
  },
});

r.post('/submissions/upload', roles(...GURU), upload.array('foto', 5), asyncH(c.uploadJawaban));
r.get('/submissions', asyncH(c.listSubmissions));
r.patch('/submissions/:id/review', roles(...GURU), asyncH(c.reviewSubmission));
r.post('/submissions/:id/finalize', roles(...GURU), asyncH(c.finalizeSubmission));

module.exports = r;
