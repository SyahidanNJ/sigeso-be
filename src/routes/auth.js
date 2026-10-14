const express = require('express');
const c = require('../controllers/auth');

const router = express.Router();
router.get('/institutions', c.institutionsPublic);
router.post('/register', c.throttle, c.register);
router.post('/login', c.login);
router.get('/me', c.me);

module.exports = router;
