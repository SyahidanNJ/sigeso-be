const express = require('express');
const multer = require('multer');
const path = require('path');
const { auth, roles } = require('../middleware/auth');
const { asyncH } = require('../controllers/bantuan');
const { AppError } = require('../lib/errors');
const c = require('../controllers/sources');

const r = express.Router();
r.use(auth);

const upload = multer({
  dest: c.DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    const okExt = ['.pdf', '.docx', '.txt'].includes(path.extname(f.originalname).toLowerCase());
    cb(okExt ? null : new AppError('VALIDATION_ERROR', 'Hanya PDF, DOCX, TXT.'), okExt);
  },
});

r.post('/sources/upload', roles('superadmin', 'admin', 'guru'), upload.single('file'), asyncH(c.uploadSource));
r.post('/sources/url', roles('superadmin', 'admin', 'guru'), asyncH(c.scrapeUrl));
r.get('/sources', asyncH(c.listSources));
r.get('/sources/:id/file', asyncH(c.downloadSource));
r.delete('/sources/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.deleteSource));

module.exports = r;
