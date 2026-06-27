/**
 * Shared input-sanitization helpers.
 *
 * Centralising these avoids the implementations drifting apart between
 * call sites (e.g. validation middleware and route handlers): a fix or
 * hardening applied here takes effect everywhere at once.
 */

/**
 * Remove HTML tags from a value and trim surrounding whitespace.
 *
 * Coerces non-string input to a string first, so it is safe to use as an
 * express-validator `customSanitizer` and on arbitrary user-supplied values.
 *
 * @param {*} value - the value to sanitize; defaults to an empty string
 * @returns {string} the value with HTML tags stripped and ends trimmed
 */
function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, '').trim();
}

module.exports = { stripHtml };
