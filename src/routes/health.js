const express = require('express');
const { asyncH } = require('../controllers/bantuan');
const c = require('../controllers/health');

const router = express.Router();
router.get('/', asyncH(c.check));

module.exports = router;
