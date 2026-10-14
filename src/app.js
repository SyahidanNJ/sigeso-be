require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(requestId);
app.use(pinoHttp({ logger, customProps: (req, res) => ({ requestId: res.locals.requestId }) }));

app.use('/api/v1/health', require('./routes/health'));
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/llm', require('./routes/llm'));
app.use('/api/v1', require('./routes/master'));
app.use('/api/v1', require('./routes/sources'));
app.use('/api/v1', require('./routes/bank'));

app.use((req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Rute tidak ada.' }, requestId: res.locals.requestId }));
app.use(errorHandler);

module.exports = app;
