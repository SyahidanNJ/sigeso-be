require('dotenv').config();
const app = require('./app');
const logger = require('./lib/logger');

const port = process.env.PORT || 3001;
const server = app.listen(port, () => logger.info(`sigeso-be jalan di :${port}`));

process.on('unhandledRejection', (e) => logger.error({ err: e }, 'unhandledRejection'));
process.on('uncaughtException', (e) => logger.error({ err: e }, 'uncaughtException'));

module.exports = server;
