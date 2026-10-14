const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['password', 'password_hash', 'token', 'apiKey', 'api_key_enc', 'nis', '*.nis', 'authorization', 'req.headers.authorization'],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
