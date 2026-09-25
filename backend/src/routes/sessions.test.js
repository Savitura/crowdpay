const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const USER_ID = 'user-1';

function denyAuth() {
  return (_req, res) => res.status(401).json({ error: 'Unauthorized' });
}

function buildApp({ sessionService = {}, authed = true } = {}) {
  const calls = {};

  const router = proxyquire('./sessions', {
    '../middleware/auth': {
      requireAuth: authed
        ? (req, _res, next) => {
            req.user = { userId: USER_ID };
            next();
          }
        : denyAuth(),
    },
    '../services/sessionService': {
      listUserSessions: async (userId) => {
        calls.listUserId = userId;
        return [{ id: 's1', device: 'Chrome' }];
      },
      revokeUserSession: async (sessionId, userId) => {
        calls.revokeArgs = [sessionId, userId];
        return true;
      },
      getUserLoginAlerts: async (userId, opts) => {
        calls.alertsArgs = [userId, opts];
        return { alerts: [], total: 0 };
      },
      acknowledgeLoginAlert: async (alertId, userId) => {
        calls.ackArgs = [alertId, userId];
      },
      getUserLoginAttempts: async (userId) => {
        calls.attemptsUserId = userId;
        return { attempts: [], total: 0 };
      },
      ...sessionService,
    },
  });

  const app = express();
  app.use('/api/sessions', router);

  return { app, calls };
}

test('GET /api/sessions lists sessions for the authenticated user', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/sessions/sessions');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sessions: [{ id: 's1', device: 'Chrome' }] });
  assert.equal(calls.listUserId, USER_ID);
});

test('GET /api/sessions returns 401 without auth', async () => {
  const { app } = buildApp({ authed: false });

  const res = await request(app).get('/api/sessions/sessions');

  assert.equal(res.status, 401);
});

test('DELETE /api/sessions/:id revokes the session', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).delete('/api/sessions/sessions/s1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(calls.revokeArgs, ['s1', USER_ID]);
});

test('DELETE /api/sessions/:id returns 404 when session has already been revoked', async () => {
  const { app } = buildApp({ sessionService: { revokeUserSession: async () => false } });

  const res = await request(app).delete('/api/sessions/sessions/s1');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Session not found or already revoked' });
});

test('GET /api/sessions/login-alerts filters acknowledged=true', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/sessions/login-alerts?acknowledged=true');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { alerts: [], total: 0 });
  assert.deepEqual(calls.alertsArgs, [USER_ID, { acknowledged: true }]);
});

test('GET /api/sessions/login-alerts filters acknowledged=false', async () => {
  const { app, calls } = buildApp();

  await request(app).get('/api/sessions/login-alerts?acknowledged=false');

  assert.deepEqual(calls.alertsArgs, [USER_ID, { acknowledged: false }]);
});

test('GET /api/sessions/login-alerts omits filter when flag absent', async () => {
  const { app, calls } = buildApp();

  await request(app).get('/api/sessions/login-alerts');

  assert.deepEqual(calls.alertsArgs, [USER_ID, { acknowledged: undefined }]);
});

test('POST /api/sessions/login-alerts/:id/acknowledge acknowledges the alert', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).post('/api/sessions/login-alerts/a1/acknowledge');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(calls.ackArgs, ['a1', USER_ID]);
});

test('GET /api/sessions/login-attempts lists attempts', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/sessions/login-attempts');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { attempts: [], total: 0 });
  assert.equal(calls.attemptsUserId, USER_ID);
});