'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ count = 0 } = {}) {
  const calls = [];
  const createRequest = async payload => {
    calls.push(payload);
    return { id: 'request-1', status: 'pending' };
  };

  const router = proxyquire('./refundRequests', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: [{ count }] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'contributor-1', role: 'contributor' };
        next();
      },
    },
    '../services/refundRequestService': {
      createRequest,
      listRequests: async () => [],
      getRequest: async () => ({}),
      reviewRequest: async () => ({}),
      payRequest: async () => ({}),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/refund-requests', router);
  return { app, calls };
}

test('POST /api/refund-requests creates a request below the velocity limit', async () => {
  const { app } = buildApp({ count: 1 });

  const res = await request(app)
    .post('/api/refund-requests')
    .send({ campaignId: 'campaign-1', contributionId: 'contribution-1', amount: 10, reason: 'x' });

  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'request-1');
});

test('POST /api/refund-requests returns 429 when the refund velocity limit is reached', async () => {
  const { app, calls } = buildApp({ count: 10 });

  const res = await request(app)
    .post('/api/refund-requests')
    .send({ campaignId: 'campaign-1', contributionId: 'contribution-1', amount: 10, reason: 'x' });

  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '3600');
  assert.equal(res.body.code, 'VELOCITY_LIMIT_EXCEEDED');
  assert.match(res.body.message, /Refund velocity/);
  // The request must not reach the service when the limit blocks it.
  assert.ok(!calls.some(call => call && call.campaignId === 'campaign-1'));
});
