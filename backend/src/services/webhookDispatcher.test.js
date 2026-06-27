const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

function loadDispatcher() {
  return proxyquire('./webhookDispatcher', {
    '../config/database': { query: async () => ({ rows: [] }) },
    '../config/logger': { error: () => {} },
    './emailService': { sendEmail: async () => {} },
  });
}

test('HMAC-SHA256 signature matches Node crypto verify pattern', () => {
  const { hmacSignature } = loadDispatcher();
  const secret = 'whsec_testsecret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = hmacSignature(secret, body);
  const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(sig, expected);
});

test('backoffMs uses the requested exponential schedule', () => {
  const { backoffMs } = loadDispatcher();
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 300_000);
  assert.equal(backoffMs(3), 1_800_000);
  assert.equal(backoffMs(4), 7_200_000);
  assert.equal(backoffMs(5), 86_400_000);
  assert.equal(backoffMs(6), 86_400_000);
});
