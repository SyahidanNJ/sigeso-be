const express = require('express');
const { auth } = require('../middleware/auth');
const { asyncH } = require('../controllers/bantuan');
const c = require('../controllers/download');

const r = express.Router();
r.use(auth);

r.get('/downloads/*', asyncH(c.download));

module.exports = r;
