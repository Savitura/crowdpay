/**
 * Shared input-sanitization helpers.
 *
 * Centralising these avoids the implementations drifting apart between
 * call sites (e.g. validation middleware and route handlers): a fix or
 * hardening applied here takes effect everywhere at once.
 */

const sanitizeHtml = require('sanitize-html');

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
  return sanitizeHtml(String(value), {
    allowedTags: [],
    allowedAttributes: {}
  }).trim();
}

/**
 * Sanitize rich text/markdown input, allowing safe HTML tags.
 * 
 * @param {*} value - the markdown or HTML string to sanitize
 * @returns {string} safely sanitized string
 */
function sanitizeRichText(value = '') {
  return sanitizeHtml(String(value), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'width', 'height']
    },
    allowedSchemes: ['http', 'https', 'mailto']
  }).trim();
}

module.exports = { stripHtml, sanitizeRichText };
