'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  hmacSha256Hex,
  timingSafeEqualHex,
  timingSafeEqualStrings,
  verifyHmacSha256,
} = require('./constantTime');

const SECRET = 'whsec_test_secret';
const BODY = Buffer.from(JSON.stringify({ type: 'contribution.confirmed' }));
const SIGNATURE = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');

// --- timingSafeEqualStrings -------------------------------------------------

test('timingSafeEqualStrings accepts identical strings', () => {
  assert.equal(timingSafeEqualStrings('token-value', 'token-value'), true);
});

test('timingSafeEqualStrings rejects different strings of the same length', () => {
  assert.equal(timingSafeEqualStrings('token-value', 'token-valuE'), false);
});

test('timingSafeEqualStrings rejects strings of different lengths', () => {
  assert.equal(timingSafeEqualStrings('token', 'token-value'), false);
  assert.equal(timingSafeEqualStrings('token-value', 'token'), false);
});

test('timingSafeEqualStrings treats two empty strings as equal', () => {
  assert.equal(timingSafeEqualStrings('', ''), true);
});

test('timingSafeEqualStrings rejects non-string values', () => {
  assert.equal(timingSafeEqualStrings(undefined, 'token'), false);
  assert.equal(timingSafeEqualStrings('token', null), false);
  assert.equal(timingSafeEqualStrings(123, '123'), false);
});

// --- timingSafeEqualHex -----------------------------------------------------

test('timingSafeEqualHex accepts identical digests', () => {
  assert.equal(timingSafeEqualHex(SIGNATURE, SIGNATURE), true);
});

test('timingSafeEqualHex accepts an upper-case digest', () => {
  assert.equal(timingSafeEqualHex(SIGNATURE, SIGNATURE.toUpperCase()), true);
});

test('timingSafeEqualHex rejects a different digest of the same length', () => {
  const other = crypto.createHmac('sha256', 'other-secret').update(BODY).digest('hex');
  assert.equal(timingSafeEqualHex(SIGNATURE, other), false);
});

test('timingSafeEqualHex rejects digests of different lengths', () => {
  assert.equal(timingSafeEqualHex(SIGNATURE, SIGNATURE.slice(0, -2)), false);
  assert.equal(timingSafeEqualHex(SIGNATURE.slice(0, -2), SIGNATURE), false);
});

test('timingSafeEqualHex rejects malformed hex input', () => {
  assert.equal(timingSafeEqualHex(SIGNATURE, 'not-hex-zz'), false);
  assert.equal(timingSafeEqualHex('not-hex-zz', SIGNATURE), false);
  assert.equal(timingSafeEqualHex(SIGNATURE, ''), false);
  assert.equal(timingSafeEqualHex('', ''), false);
});

test('timingSafeEqualHex rejects non-string values', () => {
  assert.equal(timingSafeEqualHex(undefined, SIGNATURE), false);
  assert.equal(timingSafeEqualHex(SIGNATURE, null), false);
});

// --- hmacSha256Hex ----------------------------------------------------------

test('hmacSha256Hex matches the digest produced by node crypto', () => {
  assert.equal(hmacSha256Hex(SECRET, BODY), SIGNATURE);
  assert.equal(hmacSha256Hex(SECRET, BODY), SIGNATURE.toLowerCase());
});

// --- verifyHmacSha256 -------------------------------------------------------

test('verifyHmacSha256 accepts a matching signature', () => {
  assert.equal(verifyHmacSha256(SECRET, BODY, SIGNATURE), true);
});

test('verifyHmacSha256 tolerates a sha256= prefix and surrounding whitespace', () => {
  assert.equal(verifyHmacSha256(SECRET, BODY, `sha256=${SIGNATURE}`), true);
  assert.equal(verifyHmacSha256(SECRET, BODY, `  sha256=${SIGNATURE}  `), true);
  assert.equal(verifyHmacSha256(SECRET, BODY, `SHA256=${SIGNATURE}`), true);
});

test('verifyHmacSha256 rejects a signature computed with another secret', () => {
  const other = crypto.createHmac('sha256', 'other-secret').update(BODY).digest('hex');
  assert.equal(verifyHmacSha256(SECRET, BODY, other), false);
});

test('verifyHmacSha256 rejects a signature computed over a different body', () => {
  const other = crypto.createHmac('sha256', SECRET).update('{}').digest('hex');
  assert.equal(verifyHmacSha256(SECRET, BODY, other), false);
});

test('verifyHmacSha256 rejects malformed, empty and missing signatures', () => {
  assert.equal(verifyHmacSha256(SECRET, BODY, 'not-hex-zz'), false);
  assert.equal(verifyHmacSha256(SECRET, BODY, ''), false);
  assert.equal(verifyHmacSha256(SECRET, BODY, undefined), false);
  assert.equal(verifyHmacSha256(SECRET, BODY, null), false);
  assert.equal(verifyHmacSha256(SECRET, BODY, 12345), false);
});

test('verifyHmacSha256 rejects a missing secret or payload', () => {
  assert.equal(verifyHmacSha256('', BODY, SIGNATURE), false);
  assert.equal(verifyHmacSha256(undefined, BODY, SIGNATURE), false);
  assert.equal(verifyHmacSha256(SECRET, undefined, SIGNATURE), false);
  assert.equal(verifyHmacSha256(SECRET, null, SIGNATURE), false);
});

test('verifyHmacSha256 ignores an empty prefix-only signature', () => {
  assert.equal(verifyHmacSha256(SECRET, BODY, 'sha256='), false);
});
