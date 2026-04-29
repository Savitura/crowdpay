const logger = require('../config/logger');

function normalizeErrorResponse(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function json(body) {
    if (res.statusCode >= 400) {
      if (body && typeof body.error === 'string') {
        body = { error: { code: 'ERROR', message: body.error, fields: undefined } };
      } else if (body && body.error && typeof body.error === 'object' && !body.error.code) {
        body = {
          ...body,
          error: {
            code: 'ERROR',
            message: body.error.message || JSON.stringify(body.error),
            fields: body.error.fields,
          },
        };
      }
    }
    return originalJson(body);
  };

  next();
}

function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  const isServerError = status >= 500;
  const message = isServerError && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Unexpected error';
  const payload = {
    code: err.code || (status === 422 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR'),
    message,
  };

  if (err.fields) {
    payload.fields = err.fields;
  }

  logger.error('Unhandled request error', {
    error: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    status,
  });

  res.status(status).json({ error: payload });
}

module.exports = { normalizeErrorResponse, errorHandler };
