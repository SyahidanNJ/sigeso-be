const express = require('express');
const { auth } = require('../middleware/auth');
const { asyncH } = require('../controllers/bantuan');
const c = require('../controllers/auth');

const router = express.Router();
router.get('/institutions', c.institutionsPublic);
router.post('/register', c.throttle, c.register);
router.post('/login', c.login);
router.get('/me', asyncH(c.me));
router.put('/profile', auth, asyncH(c.updateProfile));
router.put('/password', auth, asyncH(c.changePassword));

module.exports = router;
