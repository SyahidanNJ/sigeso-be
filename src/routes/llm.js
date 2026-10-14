const express = require('express');
const { asyncH } = require('../controllers/bantuan');
const c = require('../controllers/llm');

const router = express.Router();
router.post('/test', asyncH(c.testLlm));
router.post('/client-errors', c.clientError);

module.exports = router;
