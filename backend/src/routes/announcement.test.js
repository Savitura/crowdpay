process.env.USDC_ISSUER =
  process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';
process.env.PLATFORM_SECRET_KEY =
  process.env.PLATFORM_SECRET_KEY || 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const ANNOUNCEMENT_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_ID = 'admin-1';

function buildApp({ queryImpl, user = { userId: ADMIN_ID, role: 'admin' } } = {}) {
  const calls = [];
  const router = proxyquire('./announcement', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        if (queryImpl) return queryImpl(text, params);
        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        if (user) req.user = user;
        next();
      },
      requireRole:
        (...roles) =>
        (req, res, next) => {
          if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient role for this action' });
          }
          next();
        },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return { app, calls };
}

test('GET /api/announcements/active returns active platform announcements', async () => {
  const activeAnnouncements = [
    {
      id: ANNOUNCEMENT_ID,
      message: 'Scheduled maintenance tonight',
      severity: 'warning',
      details_url: 'https://status.example.com',
    },
  ];
  const { app, calls } = buildApp({
    queryImpl: async () => ({ rows: activeAnnouncements }),
  });

  const res = await request(app).get('/api/announcements/active');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, activeAnnouncements);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM platform_announcements/);
  assert.match(calls[0].text, /active_from <= NOW\(\)/);
  assert.match(calls[0].text, /deactivated_at IS NULL/);
  assert.match(calls[0].text, /active_until > NOW\(\)/);
  assert.match(calls[0].text, /ORDER BY active_from DESC/);
});

test('POST /api/announcements/create inserts an admin announcement', async () => {
  const created = {
    id: ANNOUNCEMENT_ID,
    message: 'Payments are temporarily delayed',
    severity: 'critical',
    details_url: 'https://status.example.com/incidents/1',
    active_from: '2026-07-25T10:00:00.000Z',
    active_until: '2026-07-25T12:00:00.000Z',
    created_by: ADMIN_ID,
  };
  const { app, calls } = buildApp({
    queryImpl: async () => ({ rows: [created] }),
  });

  const payload = {
    message: created.message,
    severity: created.severity,
    details_url: created.details_url,
    active_from: created.active_from,
    active_until: created.active_until,
  };
  const res = await request(app).post('/api/announcements/create').send(payload);

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, created);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO platform_announcements/);
  assert.deepEqual(calls[0].params, [
    payload.message,
    payload.severity,
    payload.details_url,
    payload.active_from,
    payload.active_until,
    ADMIN_ID,
  ]);
});

test('POST /api/announcements/create rejects non-admin users', async () => {
  const { app, calls } = buildApp({
    user: { id: 'user-1', role: 'contributor' },
  });

  const res = await request(app).post('/api/announcements/create').send({ message: 'Hello' });

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Insufficient role for this action' });
  assert.equal(calls.length, 0);
});

test('POST /api/announcements/create rejects invalid announcement payloads', async () => {
  const { app, calls } = buildApp();

  const missingMessage = await request(app)
    .post('/api/announcements/create')
    .send({ severity: 'info' });
  assert.equal(missingMessage.status, 400);
  assert.equal(missingMessage.body.error.code, 'VALIDATION_ERROR');
  assert.match(missingMessage.body.error.message, /message/i);

  const badSeverity = await request(app)
    .post('/api/announcements/create')
    .send({ message: 'Hello', severity: 'urgent' });
  assert.equal(badSeverity.status, 400);
  assert.match(badSeverity.body.error.message, /severity/);

  const badDateRange = await request(app).post('/api/announcements/create').send({
    message: 'Hello',
    active_from: '2026-07-25T12:00:00.000Z',
    active_until: '2026-07-25T11:00:00.000Z',
  });
  assert.equal(badDateRange.status, 400);
  assert.match(badDateRange.body.error.message, /active_until/);
  assert.equal(calls.length, 0);
});

test('POST /api/announcements/create treats blank optional fields as defaults', async () => {
  const created = {
    id: ANNOUNCEMENT_ID,
    message: 'Maintenance window',
    severity: 'info',
    details_url: null,
    active_from: '2026-07-25T10:00:00.000Z',
    active_until: null,
    created_by: ADMIN_ID,
  };
  const { app, calls } = buildApp({
    queryImpl: async () => ({ rows: [created] }),
  });

  const res = await request(app).post('/api/announcements/create').send({
    message: 'Maintenance window',
    severity: '',
    details_url: '',
    active_from: '',
    active_until: '',
  });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, created);
  assert.deepEqual(calls[0].params, ['Maintenance window', null, null, null, null, ADMIN_ID]);
});

test('POST /api/announcements/create rejects active_until in the past when active_from is omitted', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).post('/api/announcements/create').send({
    message: 'Expired announcement',
    active_until: '2000-01-01T00:00:00.000Z',
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.match(res.body.error.message, /active_until must be in the future/);
  assert.equal(calls.length, 0);
});

test('PATCH /api/announcements/:id/deactivate deactivates an active announcement', async () => {
  const deactivated = {
    id: ANNOUNCEMENT_ID,
    message: 'Resolved incident',
    deactivated_at: '2026-07-25T11:00:00.000Z',
  };
  const { app, calls } = buildApp({
    queryImpl: async () => ({ rows: [deactivated] }),
  });

  const res = await request(app).patch(`/api/announcements/${ANNOUNCEMENT_ID}/deactivate`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, deactivated);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /UPDATE platform_announcements/);
  assert.match(calls[0].text, /deactivated_at = NOW\(\)/);
  assert.deepEqual(calls[0].params, [ANNOUNCEMENT_ID]);
});

test('PATCH /api/announcements/:id/deactivate returns 404 when no announcement is updated', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app).patch(`/api/announcements/${ANNOUNCEMENT_ID}/deactivate`);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, {
    error: 'Announcement not found or already deactivated',
  });
});

test('PATCH /api/announcements/:id/deactivate rejects invalid ids', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).patch('/api/announcements/not-a-uuid/deactivate');

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.match(res.body.error.message, /id must be a valid UUID/);
  assert.equal(calls.length, 0);
});
