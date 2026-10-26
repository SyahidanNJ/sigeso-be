require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(requestId);
if (process.env.REQUEST_LOG === 'json') {
  app.use(pinoHttp({ logger, customProps: (req, res) => ({ requestId: res.locals.requestId }) }));
} else {
  app.use(require('./middleware/ringkas'));
}

app.use('/api/v1/health', require('./routes/health'));
app.use('/api/v1/auth', require('./routes/auth'));
// Logo kop tanpa auth supaya bisa dipakai <img src>. Hanya folder logo yang
// terbuka; isi uploads lain (foto jawaban) tetap lewat rute unduhan ber-token.
app.use('/api/v1/logos', express.static(path.join(__dirname, '..', 'uploads', 'logo'), { maxAge: '7d', immutable: true }));
app.use('/api/v1/llm', require('./routes/llm'));
app.use('/api/v1', require('./routes/master'));
app.use('/api/v1', require('./routes/sources'));
app.use('/api/v1', require('./routes/bank'));
app.use('/api/v1', require('./routes/print'));
app.use('/api/v1', require('./routes/download'));
app.use('/api/v1', require('./routes/jobs'));
app.use('/api/v1', require('./routes/referensi'));

app.use((req, res) => res.status(404).json({ status: false, error: true, code: 'NOT_FOUND', message: 'Rute tidak ada.', details: null, data: null, requestId: res.locals.requestId }));
app.use(errorHandler);

module.exports = app;
