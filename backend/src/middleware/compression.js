'use strict';

/**
 * compression.js — response compression middleware
 *
 * Applies gzip/deflate/br compression to all API responses via the `compression`
 * npm package (wraps Node's built-in zlib).
 *
 * Configuration (via environment variables):
 *
 *   COMPRESSION_THRESHOLD   Minimum response body size in bytes before
 *                           compression is applied. Default: 1024 (1 KB).
 *                           Responses smaller than this pass through unchanged.
 *                           Must be a non-negative integer.
 *
 *   COMPRESSION_LEVEL       zlib compression level, -1 (zlib default) to 9 (best).
 *                           Default: -1.
 *                           Valid values: -1, 1, 2, 3, 4, 5, 6, 7, 8, 9.
 *
 * Responses that are never compressed:
 *   - Responses below COMPRESSION_THRESHOLD bytes
 *   - Server-Sent Event streams  (text/event-stream)
 *   - Responses that already carry a Content-Encoding header
 *   - The `Cache-Control: no-transform` directive (respected automatically)
 *
 * Usage (in index.js):
 *   const compressionMiddleware = require('./middleware/compression');
 *   app.use(compressionMiddleware);
 */

const compression = require('compression');

/**
 * Parses and validates a non-negative integer environment variable.
 * @param {string} name - Environment variable name
 * @param {string} value - Raw value from process.env
 * @param {number} defaultValue - Default value if unset
 * @returns {number} Validated integer
 * @throws {Error} If value is set but invalid
 */
function parseNonNegativeInt(name, value, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  // Reject non-integer strings (e.g., "100.5", "abc", "-100")
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer (received: ${JSON.stringify(value)})`);
  }
  const parsed = Number.parseInt(value, 10);
  return parsed;
}

/**
 * Parses and validates COMPRESSION_LEVEL environment variable.
 * Valid range: -1 (zlib default) through 9 (best compression).
 * @param {string} value - Raw value from process.env
 * @returns {number} Validated compression level
 * @throws {Error} If value is set but invalid
 */
function parseCompressionLevel(value) {
  if (value === undefined || value === '') {
    return -1; // zlib default
  }
  // Reject non-integer strings (e.g., "6.5", "high", "-2", "10")
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`COMPRESSION_LEVEL must be an integer between -1 and 9 (received: ${JSON.stringify(value)})`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < -1 || parsed > 9) {
    throw new Error(`COMPRESSION_LEVEL must be an integer between -1 and 9 (received: ${JSON.stringify(value)})`);
  }
  return parsed;
}

/** Minimum bytes before compression kicks in — validated at startup */
const THRESHOLD = parseNonNegativeInt('COMPRESSION_THRESHOLD', process.env.COMPRESSION_THRESHOLD, 1024);

/** zlib level: -1 = library default, range 1–9; also accepts -1 — validated at startup */
const LEVEL = parseCompressionLevel(process.env.COMPRESSION_LEVEL);

/**
 * Custom filter — SSE streams must never be compressed because the chunked
 * encoding breaks the event-stream framing.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
function shouldCompress(req, res) {
  // Never compress Server-Sent Event streams
  if (res.getHeader('Content-Type') === 'text/event-stream') {
    return false;
  }
  // Fall back to the library's default filter for everything else
  return compression.filter(req, res);
}

const compressionMiddleware = compression({
  filter: shouldCompress,
  threshold: THRESHOLD,
  level: LEVEL,
});

module.exports = compressionMiddleware;
