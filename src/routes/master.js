const express = require('express');
const multer = require('multer');
const path = require('path');
const { auth, roles } = require('../middleware/auth');
const { asyncH } = require('../controllers/bantuan');
const { AppError } = require('../lib/errors');
const c = require('../controllers/master');

const r = express.Router();
r.use(auth);

const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    const okExt = path.extname(f.originalname).toLowerCase() === '.xlsx';
    cb(okExt ? null : new AppError('VALIDATION_ERROR', 'Hanya berkas .xlsx.'), okExt);
  },
});

// Logo hanya PNG/JPG: SVG bisa membawa skrip dan disajikan dari origin yang sama.
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    const okType = ['image/png', 'image/jpeg'].includes(f.mimetype);
    cb(okType ? null : new AppError('VALIDATION_ERROR', 'Logo harus PNG atau JPG.'), okType);
  },
});

r.get('/institutions', asyncH(c.listInstitutions));
r.post('/institutions', roles('superadmin'), asyncH(c.createInstitution));
r.put('/institutions/me', roles('superadmin', 'admin', 'guru'), asyncH(c.updateInstitution));
r.post('/institutions/logos', roles('superadmin', 'admin', 'guru'),
  uploadLogo.fields([{ name: 'kiri', maxCount: 1 }, { name: 'kanan', maxCount: 1 }]), asyncH(c.uploadLogos));

r.get('/users', roles('superadmin', 'admin'), asyncH(c.listUsers));
r.post('/users', roles('superadmin', 'admin'), asyncH(c.createUser));
r.put('/users/:id', roles('superadmin', 'admin'), asyncH(c.updateUser));
r.put('/users/:id/password', roles('superadmin', 'admin'), asyncH(c.resetUserPassword));

r.get('/letterheads', asyncH(c.listLetterheads));
r.post('/letterheads', roles('superadmin', 'admin'), asyncH(c.createLetterhead));
r.put('/letterheads/me', roles('superadmin', 'admin', 'guru'), asyncH(c.updateLetterhead));

r.get('/classes', asyncH(c.listClasses));
r.post('/classes', roles('superadmin', 'admin', 'guru'), asyncH(c.createClass));
r.put('/classes/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.updateClass));
r.delete('/classes/:id', roles('superadmin', 'admin'), asyncH(c.deleteClass));

r.get('/students', asyncH(c.listStudents));
r.post('/students', roles('superadmin', 'admin', 'guru'), asyncH(c.createStudent));
r.put('/students/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.updateStudent));
r.delete('/students/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.deleteStudent));
r.post('/students/import', roles('superadmin', 'admin', 'guru'), asyncH(c.importStudents));
r.post('/students/import-file', roles('superadmin', 'admin', 'guru'), uploadXlsx.single('file'), asyncH(c.importStudentsFile));

r.get('/subjects', asyncH(c.listSubjects));
r.post('/subjects', roles('superadmin', 'admin', 'guru'), asyncH(c.createSubject));
r.put('/subjects/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.updateSubject));
r.delete('/subjects/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.deleteSubject));
r.get('/topics', asyncH(c.listTopics));
r.post('/topics', roles('superadmin', 'admin', 'guru'), asyncH(c.createTopic));
r.put('/topics/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.updateTopic));
r.delete('/topics/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.deleteTopic));
r.get('/chapters', asyncH(c.listChapters));
r.post('/chapters', roles('superadmin', 'admin', 'guru'), asyncH(c.createChapter));
r.put('/chapters/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.updateChapter));
r.delete('/chapters/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.deleteChapter));
r.get('/subchapters', asyncH(c.listSubchapters));
r.post('/subchapters', roles('superadmin', 'admin', 'guru'), asyncH(c.createSubchapter));
r.put('/subchapters/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.updateSubchapter));
r.delete('/subchapters/:id', roles('superadmin', 'admin', 'guru'), asyncH(c.deleteSubchapter));

r.get('/stats', asyncH(c.stats));

module.exports = r;
