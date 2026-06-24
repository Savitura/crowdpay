const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

const originalSecret = process.env.PERSONA_WEBHOOK_SECRET;
const originalEnv = process.env.NODE_ENV;
const originalProvider = process.env.KYC_PROVIDER;

beforeEach(() => {
  process.env.PERSONA_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.NODE_ENV = 'production';
  delete process.env.KYC_PROVIDER;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.PERSONA_WEBHOOK_SECRET;
  else process.env.PERSONA_WEBHOOK_SECRET = originalSecret;
  process.env.NODE_ENV = originalEnv;
  if (originalProvider === undefined) delete process.env.KYC_PROVIDER;
  else process.env.KYC_PROVIDER = originalProvider;
});

function loadProvider() {
  return proxyquire('./kycProvider', {});
}

test('verifyPersonaWebhookSignature accepts valid Persona signature', () => {
  const { verifyPersonaWebhookSignature } = loadProvider();
  const rawBody = JSON.stringify({ data: { id: 'inq_123' } });
  const timestamp = '1700000000';
  const signature = crypto
    .createHmac('sha256', 'test-webhook-secret')
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  assert.strictEqual(
    verifyPersonaWebhookSignature(rawBody, `t=${timestamp},v1=${signature}`),
    true
  );
});

test('verifyPersonaWebhookSignature rejects invalid signature', () => {
  const { verifyPersonaWebhookSignature } = loadProvider();
  const rawBody = JSON.stringify({ data: { id: 'inq_123' } });
  assert.strictEqual(
    verifyPersonaWebhookSignature(rawBody, 't=1700000000,v1=deadbeef'),
    false
  );
});

test('verifyPersonaWebhookSignature allows unsigned webhooks in test mode without secret', () => {
  delete process.env.PERSONA_WEBHOOK_SECRET;
  process.env.NODE_ENV = 'test';
  const { verifyPersonaWebhookSignature } = loadProvider();
  assert.strictEqual(verifyPersonaWebhookSignature('{}', null), true);
});

test('extractWebhookResult maps approved inquiry to verified', () => {
  const { extractWebhookResult } = loadProvider();
  const result = extractWebhookResult({
    data: {
      id: 'evt_1',
      attributes: {
        name: 'inquiry.approved',
        payload: {
          data: {
            id: 'inq_abc',
            attributes: {
              status: 'approved',
              'reference-id': 'user-1',
            },
          },
        },
      },
    },
  });

  assert.strictEqual(result.kycStatus, 'verified');
  assert.strictEqual(result.providerReference, 'inq_abc');
  assert.strictEqual(result.userId, 'user-1');
});

test('extractWebhookResult maps declined inquiry to rejected with reason', () => {
  const { extractWebhookResult } = loadProvider();
  const result = extractWebhookResult({
    data: {
      attributes: {
        name: 'inquiry.declined',
        payload: {
          data: {
            id: 'inq_declined',
            attributes: {
              status: 'declined',
              'decline-reason': 'Document unreadable',
            },
          },
        },
      },
    },
  });

  assert.strictEqual(result.kycStatus, 'rejected');
  assert.strictEqual(result.reason, 'Document unreadable');
});
