const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const proxyquire = require('proxyquire').noCallThru();

function buildWebhookApp() {
  process.env.PERSONA_WEBHOOK_SECRET = 'whsec_test';
  let updatedStatus = null;

  const handler = proxyquire('../routes/kycWebhook', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('UPDATE users')) {
          updatedStatus = params[0];
          return {
            rows: [{
              id: 'user-1',
              email: 'user@test.com',
              name: 'User',
              kyc_status: params[0],
              kyc_completed_at: params[0] === 'verified' ? new Date().toISOString() : null,
            }],
          };
        }
        return { rows: [] };
      },
    },
    '../services/emailService': {
      sendKycApprovedEmail: async () => {},
      sendKycRejectedEmail: async () => {},
    },
    '../config/logger': { error: () => {} },
  });

  const app = express();
  app.post('/api/webhooks/kyc', express.raw({ type: 'application/json' }), handler);
  return { app, getUpdatedStatus: () => updatedStatus };
}

test('POST /api/webhooks/kyc updates user when Persona signature is valid', async () => {
  const { app, getUpdatedStatus } = buildWebhookApp();
  const server = app.listen(0);
  const { port } = server.address();

  const payload = {
    data: {
      attributes: {
        name: 'inquiry.approved',
        payload: {
          data: {
            id: 'inq_123',
            attributes: {
              status: 'approved',
              'reference-id': 'user-1',
            },
          },
        },
      },
    },
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = '1700000000';
  const signature = crypto
    .createHmac('sha256', 'whsec_test')
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/kyc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Persona-Signature': `t=${timestamp},v1=${signature}`,
      },
      body: rawBody,
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.kyc_status, 'verified');
    assert.strictEqual(getUpdatedStatus(), 'verified');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/webhooks/kyc rejects invalid Persona signature', async () => {
  const { app } = buildWebhookApp();
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/kyc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Persona-Signature': 't=1,v1=bad',
      },
      body: JSON.stringify({ data: { id: 'inq_123' } }),
    });

    assert.strictEqual(res.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
