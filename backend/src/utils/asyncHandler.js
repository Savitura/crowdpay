/**
 * Wraps an async Express route handler so that any rejected promise is forwarded
 * to Express's next() error pipeline, where it will be caught by errorHandler.
 *
 * Usage:
 *   router.get('/path', asyncHandler(async (req, res) => {
 *     const { rows } = await db.query(...);
 *     res.json(rows);
 *   }));
 *
 * Without this wrapper, an uncaught async rejection in Express 4 causes the
 * client to receive an empty/hung response because Express never calls next(err).
 */
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
