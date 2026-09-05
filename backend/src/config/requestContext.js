const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function getRequestContext() {
  return als.getStore() || {};
}

// Express middleware that establishes a per-request context store.
function requestContextMiddleware(req, _res, next) {
  const ctx = { requestId: req.id || req.headers['x-request-id'] || undefined };
  als.run(ctx, () => next());
}

function runWithContext(context, fn) {
  return als.run(context, fn);
}

module.exports = requestContextMiddleware;
module.exports.getRequestContext = getRequestContext;
module.exports.runWithContext = runWithContext;
