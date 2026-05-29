const logger = require('../config/logger');

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const duration_ms = Math.round(elapsedMs * 100) / 100;

    const path = req.originalUrl || req.url;
    const method = req.method;
    const status = res.statusCode;

    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]('request', { method, path, status, duration_ms });
  });

  next();
}

module.exports = { requestLogger };

