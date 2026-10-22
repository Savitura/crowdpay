'use strict';

const crypto = require('crypto');

// `Buffer.from(value, 'hex')` silently stops at the first character that is
// not a hex digit, so a malformed signature would be truncated into a shorter
// (but still comparable) buffer. Every value that reaches a comparison is
// validated against this pattern first.
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * Compare two strings in constant time.
 *
 * `crypto.timingSafeEqual` walks both buffers for the same number of bytes no
 * matter where the first difference is, so an attacker cannot learn how many
 * leading characters of a secret they guessed correctly by measuring how long
 * the comparison takes. Only the *lengths* of the two values remain
 * observable, which is unavoidable for any fixed-size comparison.
 *
 * @param {unknown} a - first value
 * @param {unknown} b - second value
 * @returns {boolean} true iff both values are strings with identical bytes
 */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) return false;
  if (bufA.length === 0) return true;

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Compare two hex-encoded digests in constant time.
 *
 * Both values must be valid hex of the same length; anything else is a
 * mismatch. The digests are decoded and compared byte-for-byte, which makes
 * the comparison case-insensitive for hex (as hex digests are).
 *
 * @param {unknown} expectedHex - digest computed by the server
 * @param {unknown} providedHex - digest supplied by the client
 * @returns {boolean} true iff both digests decode to the same bytes
 */
function timingSafeEqualHex(expectedHex, providedHex) {
  if (typeof expectedHex !== 'string' || typeof providedHex !== 'string') return false;
  if (!HEX_PATTERN.test(expectedHex) || !HEX_PATTERN.test(providedHex)) return false;
  if (expectedHex.length !== providedHex.length) return false;

  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex, 'hex');

  if (expected.length === 0 || expected.length !== provided.length) return false;

  return crypto.timingSafeEqual(expected, provided);
}

/**
 * Compute the HMAC-SHA256 of `payload` under `secret` as a hex digest.
 *
 * @param {string} secret - signing secret
 * @param {string|Buffer} payload - exact bytes that are signed
 * @returns {string} lower-case hex digest
 */
function hmacSha256Hex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify a hex-encoded HMAC-SHA256 signature in constant time.
 *
 * Accepts an optional `sha256=` prefix on the signature (GitHub/Stripe style)
 * and tolerates surrounding whitespace. The expected digest is computed with
 * the server-side secret and compared byte-for-byte with
 * `crypto.timingSafeEqual`, so a partially guessed signature cannot be
 * refined by measuring the response.
 *
 * @param {string} secret - signing secret
 * @param {string|Buffer} payload - exact bytes that were signed
 * @param {unknown} signature - signature supplied by the client
 * @param {object} [options]
 * @param {string} [options.prefix] - prefix to strip before comparing
 * @returns {boolean} true iff the signature matches
 */
function verifyHmacSha256(secret, payload, signature, options = {}) {
  const { prefix = 'sha256=' } = options;

  if (typeof secret !== 'string' || !secret) return false;
  if (payload === null || payload === undefined) return false;
  if (typeof signature !== 'string') return false;

  let provided = signature.trim();
  if (prefix && provided.toLowerCase().startsWith(prefix.toLowerCase())) {
    provided = provided.slice(prefix.length).trim();
  }
  if (!provided) return false;

  return timingSafeEqualHex(hmacSha256Hex(secret, payload), provided);
}

module.exports = {
  HEX_PATTERN,
  hmacSha256Hex,
  timingSafeEqualHex,
  timingSafeEqualStrings,
  verifyHmacSha256,
};
