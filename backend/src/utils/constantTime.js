const crypto = require('crypto');

function equalFixedLength(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function equalSha256Hex(provided, expected) {
  // Buffer.from(hex) silently truncates invalid suffixes; validate before decoding.
  if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/i.test(provided)) return false;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return equalFixedLength(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = { equalFixedLength, equalSha256Hex };
