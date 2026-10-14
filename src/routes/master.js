const express = require('express');
const { auth, roles } = require('../middleware/auth');
const { asyncH } = require('../controllers/bantuan');
const c = require('../controllers/master');

const r = express.Router();
r.use(auth);

r.get('/institutions', asyncH(c.listInstitutions));
r.post('/institutions', roles('superadmin'), asyncH(c.createInstitution));

r.get('/users', roles('superadmin', 'admin'), asyncH(c.listUsers));
r.post('/users', roles('superadmin', 'admin'), asyncH(c.createUser));

r.get('/letterheads', asyncH(c.listLetterheads));
r.post('/letterheads', roles('superadmin', 'admin'), asyncH(c.createLetterhead));

r.get('/classes', asyncH(c.listClasses));
r.post('/classes', roles('superadmin', 'admin', 'guru'), asyncH(c.createClass));

r.get('/students', asyncH(c.listStudents));
r.post('/students', roles('superadmin', 'admin', 'guru'), asyncH(c.createStudent));
r.post('/students/import', roles('superadmin', 'admin', 'guru'), asyncH(c.importStudents));

r.get('/subjects', asyncH(c.listSubjects));
r.post('/subjects', roles('superadmin', 'admin', 'guru'), asyncH(c.createSubject));
r.get('/topics', asyncH(c.listTopics));
r.post('/topics', roles('superadmin', 'admin', 'guru'), asyncH(c.createTopic));
r.get('/chapters', asyncH(c.listChapters));
r.post('/chapters', roles('superadmin', 'admin', 'guru'), asyncH(c.createChapter));
r.get('/subchapters', asyncH(c.listSubchapters));
r.post('/subchapters', roles('superadmin', 'admin', 'guru'), asyncH(c.createSubchapter));

module.exports = r;
