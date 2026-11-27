'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { errorHandler } = require('../middleware/errorHandler');

const CONTRIBUTOR_ID = 'contributor-1';
const ADMIN_ID = 'admin-1';

function domainError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function serviceCall(calls, key) {
  const call = calls.find(entry => entry && entry[key]);
  assert.ok(call, `expected a ${key} service call`);
  return call[key];
}

function buildApp({
  count = 0,
  user = { userId: CONTRIBUTOR_ID, role: 'contributor' },
  service = {},
} = {}) {
  const calls = [];
  const createRequest = async payload => {
    calls.push(payload);
    return { id: 'request-1', status: 'pending' };
  };

  const defaultService = {
    createRequest,
    listRequests: async (...args) => {
      calls.push({ listRequests: args });
      return [{ id: 'request-1', status: 'approved' }];
    },
    getRequest: async (...args) => {
      calls.push({ getRequest: args });
      return { id: 'request-1', status: 'pending', events: [] };
    },
    reviewRequest: async (...args) => {
      calls.push({ reviewRequest: args });
      return { id: args[0], status: args[1].approve ? 'approved' : 'rejected' };
    },
    payRequest: async (...args) => {
      calls.push({ payRequest: args });
      return { id: 'request-1', status: 'paid' };
    },
  };

  const router = proxyquire('./refundRequests', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: [{ count }] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        req.user = user;
        next();
      },
    },
    '../services/refundRequestService': { ...defaultService, ...service },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/refund-requests', router);
  app.use(errorHandler);
  return { app, calls };
}

function buildAppWithRealService({ count = 0 } = {}) {
  const service = proxyquire('../services/refundRequestService', {
    '../config/database': {
      query: async () => ({ rows: [] }),
      connect: async () => {
        throw new Error('database must not be reached for invalid input');
      },
    },
    './notifications': { createNotification: async () => {} },
    './auditService': { logAuditEvent: async () => {} },
    './refundService': { processRefund: async () => {} },
  });

  const router = proxyquire('./refundRequests', {
    '../config/database': { query: async () => ({ rows: [{ count }] }) },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: CONTRIBUTOR_ID, role: 'contributor' };
        next();
      },
    },
    '../services/refundRequestService': service,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/refund-requests', router);
  app.use(errorHandler);
  return app;
}

test('POST /api/refund-requests creates a request below the velocity limit', async () => {
  const { app, calls } = buildApp({ count: 1 });

  const res = await request(app)
    .post('/api/refund-requests')
    .send({ campaignId: 'campaign-1', contributionId: 'contribution-1', amount: 10, reason: 'x' });

  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'request-1');
  assert.deepEqual(calls.find(entry => entry && entry.campaignId === 'campaign-1'), {
    campaignId: 'campaign-1',
    contributionId: 'contribution-1',
    amount: 10,
    reason: 'x',
    contributorId: CONTRIBUTOR_ID,
  });
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

test('POST /api/refund-requests requires authentication', async () => {
  const { app, calls } = buildApp({ user: null });

  const res = await request(app)
    .post('/api/refund-requests')
    .send({ campaignId: 'campaign-1', contributionId: 'contribution-1', amount: 10, reason: 'x' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Unauthorized');
  assert.ok(!calls.some(call => call && call.campaignId === 'campaign-1'));
});

test('POST /api/refund-requests/:id/review requires authentication', async () => {
  const { app, calls } = buildApp({ user: null });

  const res = await request(app)
    .post('/api/refund-requests/request-1/review')
    .send({ approve: true });

  assert.equal(res.status, 401);
  assert.ok(!calls.some(call => call && call.reviewRequest));
});

test('POST /api/refund-requests rejects a non-positive amount with 400', async () => {
  const app = buildAppWithRealService();

  const res = await request(app)
    .post('/api/refund-requests')
    .send({
      campaignId: 'campaign-1',
      contributionId: 'contribution-1',
      amount: 0,
      reason: 'changed my mind',
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.message, 'Refund amount must be positive');
});

test('POST /api/refund-requests rejects a blank reason with 400', async () => {
  const app = buildAppWithRealService();

  const res = await request(app)
    .post('/api/refund-requests')
    .send({
      campaignId: 'campaign-1',
      contributionId: 'contribution-1',
      amount: 10,
      reason: '   ',
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.message, 'Refund reason is required');
});

test('GET /api/refund-requests/campaign/:campaignId passes viewer identity and admin visibility', async () => {
  const contributor = buildApp();
  const contributorRes = await request(contributor.app).get(
    '/api/refund-requests/campaign/campaign-1'
  );

  assert.equal(contributorRes.status, 200);
  assert.deepEqual(contributorRes.body, [{ id: 'request-1', status: 'approved' }]);
  assert.deepEqual(serviceCall(contributor.calls, 'listRequests'), [
    'campaign-1',
    CONTRIBUTOR_ID,
    false,
  ]);

  const admin = buildApp({ user: { userId: ADMIN_ID, role: 'admin' } });
  const adminRes = await request(admin.app).get('/api/refund-requests/campaign/campaign-1');

  assert.equal(adminRes.status, 200);
  assert.deepEqual(serviceCall(admin.calls, 'listRequests'), ['campaign-1', ADMIN_ID, true]);
});

test('GET /api/refund-requests/:id returns the request for its viewer', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/refund-requests/request-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.deepEqual(serviceCall(calls, 'getRequest'), ['request-1', CONTRIBUTOR_ID, false]);
});

test('GET /api/refund-requests/:id lets an admin view any request', async () => {
  const { app, calls } = buildApp({ user: { userId: ADMIN_ID, role: 'admin' } });

  const res = await request(app).get('/api/refund-requests/request-1');

  assert.equal(res.status, 200);
  assert.deepEqual(serviceCall(calls, 'getRequest'), ['request-1', ADMIN_ID, true]);
});

test('GET /api/refund-requests/:id returns 403 for an unauthorized viewer', async () => {
  const { app } = buildApp({
    service: {
      getRequest: async () => {
        throw domainError('Not authorized to view this request', 403);
      },
    },
  });

  const res = await request(app).get('/api/refund-requests/request-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.error.message, 'Not authorized to view this request');
});

test('POST /api/refund-requests/:id/review approves a pending request', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/refund-requests/request-1/review')
    .send({ approve: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.deepEqual(serviceCall(calls, 'reviewRequest'), [
    'request-1',
    { reviewerId: CONTRIBUTOR_ID, approve: true, rejectionReason: undefined, isAdmin: false },
  ]);
});

test('POST /api/refund-requests/:id/review rejects a pending request with a reason', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/refund-requests/request-1/review')
    .send({ approve: false, rejectionReason: 'Not eligible' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'rejected');
  assert.deepEqual(serviceCall(calls, 'reviewRequest'), [
    'request-1',
    { reviewerId: CONTRIBUTOR_ID, approve: false, rejectionReason: 'Not eligible', isAdmin: false },
  ]);
});

test('POST /api/refund-requests/:id/review passes admin status from the session role', async () => {
  const { app, calls } = buildApp({ user: { userId: ADMIN_ID, role: 'admin' } });

  const res = await request(app)
    .post('/api/refund-requests/request-1/review')
    .send({ approve: true });

  assert.equal(res.status, 200);
  assert.equal(serviceCall(calls, 'reviewRequest')[1].isAdmin, true);
  assert.equal(serviceCall(calls, 'reviewRequest')[1].reviewerId, ADMIN_ID);
});

test('POST /api/refund-requests/:id/review only treats a boolean true as approval', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/refund-requests/request-1/review')
    .send({ approve: 'true', rejectionReason: 'Not eligible' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'rejected');
  assert.equal(serviceCall(calls, 'reviewRequest')[1].approve, false);
});

test('POST /api/refund-requests/:id/review returns 403 for an unauthorized reviewer', async () => {
  const { app } = buildApp({
    service: {
      reviewRequest: async () => {
        throw domainError('Not authorized to review this request', 403);
      },
    },
  });

  const res = await request(app)
    .post('/api/refund-requests/request-1/review')
    .send({ approve: true });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.message, 'Not authorized to review this request');
});

test('POST /api/refund-requests/:id/review propagates a missing rejection reason', async () => {
  const { app } = buildApp({
    service: {
      reviewRequest: async () => {
        throw domainError('Rejection reason is required');
      },
    },
  });

  const res = await request(app)
    .post('/api/refund-requests/request-1/review')
    .send({ approve: false });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.message, 'Rejection reason is required');
});

test('POST /api/refund-requests/:id/pay settles an approved request', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).post('/api/refund-requests/request-1/pay');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'paid');
  assert.deepEqual(serviceCall(calls, 'payRequest'), ['request-1', { actorId: CONTRIBUTOR_ID }]);
});

test('POST /api/refund-requests/:id/pay returns 403 for an unauthorized actor', async () => {
  const { app } = buildApp({
    service: {
      payRequest: async () => {
        throw domainError('Not authorized to settle this request', 403);
      },
    },
  });

  const res = await request(app).post('/api/refund-requests/request-1/pay');

  assert.equal(res.status, 403);
  assert.equal(res.body.error.message, 'Not authorized to settle this request');
});

test('POST /api/refund-requests/:id/pay returns 409 when the request is not payable', async () => {
  const { app } = buildApp({
    service: {
      payRequest: async () => {
        throw domainError('Refund request is not approved or is already being settled', 409);
      },
    },
  });

  const res = await request(app).post('/api/refund-requests/request-1/pay');

  assert.equal(res.status, 409);
  assert.equal(res.body.error.message, 'Refund request is not approved or is already being settled');
});
