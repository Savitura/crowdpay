process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123456789012345678901234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const proxyquire = require('proxyquire').noCallThru();
const {
  issueStepUpToken,
  verifyStepUpToken,
  getStepUpTtlSeconds,
} = require('../services/stepUpService');

const USER_ID = 'creator-1';
const OWN_WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const NEW_DESTINATION = 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK';

function buildApp({ walletPublicKey = OWN_WALLET, auth = { kind: 'jwt' } } = {}) {
  const events = [];
  const queries = [];
  const { requirePayoutDestinationStepUp } = proxyquire('./stepUp', {
    '../config/database': {
      query: async (text, params) => {
        queries.push({ text, params });
        return { rows: walletPublicKey ? [{ wallet_public_key: walletPublicKey }] : [] };
      },
    },
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
    '../services/totpService': {
      logAuditEvent: async (userId, eventType, _req, metadata) => {
        events.push({ userId, eventType, metadata });
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: USER_ID, role: 'creator' };
    req.auth = auth;
    next();
  });
  app.post('/payout', requirePayoutDestinationStepUp({ action: 'test_action' }), (req, res) => {
    res.json({ ok: true, stepUp: req.stepUp || null });
  });
  return { app, events, queries };
}

function tokenFor(destinationKey = NEW_DESTINATION, userId = USER_ID) {
  return issueStepUpToken({ userId, purpose: 'payout_destination', destinationKey }).token;
}

test('allows payouts to the caller own wallet without step-up', async () => {
  const { app, events } = buildApp();
  const res = await request(app).post('/payout').send({ destination_key: OWN_WALLET });
  assert.equal(res.status, 200);
  assert.equal(res.body.stepUp, null);
  assert.equal(events.length, 0);
});

test('requires step-up for a destination other than the caller wallet', async () => {
  const { app, events } = buildApp();
  const res = await request(app).post('/payout').send({ destination_key: NEW_DESTINATION });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'STEP_UP_REQUIRED');
  assert.equal(res.body.purpose, 'payout_destination');
  assert.equal(events[0].eventType, 'step_up_rejected');
  assert.equal(events[0].metadata.reason, 'missing');
  assert.equal(events[0].metadata.action, 'test_action');
});

test('requires step-up when the caller has no wallet on file', async () => {
  const { app } = buildApp({ walletPublicKey: null });
  const res = await request(app).post('/payout').send({ destination_key: NEW_DESTINATION });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'STEP_UP_REQUIRED');
});

test('accepts a valid step-up token bound to the user and destination', async () => {
  const { app, events } = buildApp();
  const res = await request(app)
    .post('/payout')
    .set('X-Step-Up-Token', tokenFor())
    .send({ destination_key: NEW_DESTINATION });
  assert.equal(res.status, 200);
  assert.ok(res.body.stepUp.tokenId);
  assert.equal(res.body.stepUp.purpose, 'payout_destination');
  assert.equal(events[0].eventType, 'step_up_consumed');
});

test('rejects an expired step-up token', async () => {
  const { app } = buildApp();
  const token = tokenFor();
  const realNow = Date.now;
  Date.now = () => realNow() + (getStepUpTtlSeconds() + 60) * 1000;
  try {
    const res = await request(app)
      .post('/payout')
      .set('X-Step-Up-Token', token)
      .send({ destination_key: NEW_DESTINATION });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'STEP_UP_EXPIRED');
  } finally {
    Date.now = realNow;
  }
});

test('rejects a step-up token issued for a different destination', async () => {
  const { app, events } = buildApp();
  const res = await request(app)
    .post('/payout')
    .set('X-Step-Up-Token', tokenFor(OWN_WALLET))
    .send({ destination_key: NEW_DESTINATION });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'STEP_UP_INVALID');
  assert.equal(events[0].metadata.reason, 'mismatch');
});

test('rejects a step-up token issued to another user', async () => {
  const { app } = buildApp();
  const res = await request(app)
    .post('/payout')
    .set('X-Step-Up-Token', tokenFor(NEW_DESTINATION, 'someone-else'))
    .send({ destination_key: NEW_DESTINATION });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'STEP_UP_INVALID');
});

test('rejects a regular access token presented as a step-up token', async () => {
  const { app } = buildApp();
  const accessToken = jwt.sign(
    {
      sub: USER_ID,
      iss: 'https://crowdpay.io',
      aud: 'crowdpay-api',
      userId: USER_ID,
      purpose: 'payout_destination',
      destination_key: NEW_DESTINATION,
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  const res = await request(app)
    .post('/payout')
    .set('X-Step-Up-Token', accessToken)
    .send({ destination_key: NEW_DESTINATION });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'STEP_UP_INVALID');
});

test('rejects payout destination changes during impersonation even with a token', async () => {
  const { app, queries } = buildApp({ auth: { kind: 'jwt', impersonated: true } });
  const res = await request(app)
    .post('/payout')
    .set('X-Step-Up-Token', tokenFor())
    .send({ destination_key: NEW_DESTINATION });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'STEP_UP_REQUIRED');
  assert.equal(queries.length, 0);
});

test('defers malformed destinations to route validation', async () => {
  const { app, queries } = buildApp();
  const res = await request(app).post('/payout').send({ destination_key: 'not-a-key' });
  assert.equal(res.status, 200);
  assert.equal(queries.length, 0);
});

test('verifyStepUpToken rejects tampered tokens', () => {
  const token = tokenFor();
  const tampered = `${token.slice(0, -2)}xx`;
  const result = verifyStepUpToken(tampered, {
    userId: USER_ID,
    purpose: 'payout_destination',
    destinationKey: NEW_DESTINATION,
  });
  assert.deepEqual(result, { valid: false, reason: 'invalid' });
});

test('STEP_UP_TTL_SECONDS is clamped to a safe window', () => {
  const prev = process.env.STEP_UP_TTL_SECONDS;
  try {
    process.env.STEP_UP_TTL_SECONDS = '86400';
    assert.equal(getStepUpTtlSeconds(), 900);
    process.env.STEP_UP_TTL_SECONDS = '1';
    assert.equal(getStepUpTtlSeconds(), 30);
    delete process.env.STEP_UP_TTL_SECONDS;
    assert.equal(getStepUpTtlSeconds(), 300);
  } finally {
    if (prev === undefined) delete process.env.STEP_UP_TTL_SECONDS;
    else process.env.STEP_UP_TTL_SECONDS = prev;
  }
});
