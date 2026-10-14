const express = require('express');
const { auth } = require('../middleware/auth');
const { asyncH } = require('../controllers/bantuan');
const c = require('../controllers/jobs');

const r = express.Router();
r.use(auth);

r.get('/jobs/:id', asyncH(c.getJob));
r.get('/jobs', asyncH(c.listJobs));

module.exports = r;
