'use strict';

/**
 * Unit tests for contribution dedications & memorial messages — issue #955
 *
 * Pattern: proxyquire + buildApp (same as contributions.test.js).
 * All external I/O (DB, audit, notifications) is stubbed so tests run without
 * a real database and complete in milliseconds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

// Minimal env so modules that reference these at load time don't throw.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-dedication-secret-32chars';
process.env.USDC_ISSUER =
  process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const CONTRIB_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CAMPAIGN_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID = 'cccccccc-0000-0000-0000-000000000003';
const CREATOR_ID = 'dddddddd-0000-0000-0000-000000000004';
const DEDICATION_ID = 'eeeeeeee-0000-0000-0000-000000000005';

const CONTRIBUTION_ROW = {
  id: CONTRIB_ID,
  campaign_id: CAMPAIGN_ID,
  user_id: USER_ID,
  campaign_title: 'Save the Reef',
  campaign_creator_id: CREATOR_ID,
};

const CAMPAIGN_ROW = { id: CAMPAIGN_ID, creator_id: CREATOR_ID };

const DEDICATION_ROW = {
  id: DEDICATION_ID,
  contribution_id: CONTRIB_ID,
  campaign_id: CAMPAIGN_ID,
  user_id: USER_ID,
  honoree_name: 'Jane Doe',
  message: 'In loving memory',
  dedication_type: 'in_memory_of',
  is_public: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// buildApp helper
// ---------------------------------------------------------------------------
/**
 * Build a minimal Express app with the contributionDedications router wired up,
 * using proxyquire to replace every external dependency with a controllable stub.
 *
 * @param {object} opts
 * @param {Function}  opts.queryImpl         – async (sql, params) => { rows: [] }
 * @param {object}    [opts.user]            – injected as req.user by requireAuth stub
 * @param {boolean}   [opts.skipAuth]        – if true, requireAuth passes unauthenticated
 * @param {Function}  [opts.auditImpl]       – stub for logAuditEvent
 * @param {Function}  [opts.notifyImpl]      – stub for createNotification
 */
function buildApp({
  queryImpl,
  user = { userId: USER_ID, role: 'contributor' },
  skipAuth = false,
  auditImpl = async () => {},
  notifyImpl = async () => {},
} = {}) {
  // requireAuth either injects req.user or returns 401
  const requireAuthStub = (req, res, next) => {
    if (skipAuth) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  };

  // authenticate (optional-auth) always succeeds and sets req.user
  const authenticateStub = async req => {
    req.user = user;
  };

  const router = proxyquire('./contributionDedications', {
    '../config/database': {
      query: queryImpl,
    },
    '../middleware/auth': {
      requireAuth: requireAuthStub,
      authenticate: authenticateStub,
    },
    '../middleware/validation': {
      dedicationValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
    '../services/auditService': { logAuditEvent: auditImpl },
    '../services/notifications': { createNotification: notifyImpl },
    '../utils/pagination': {
      parsePagination: (_q, _d) => ({ limit: 20, offset: 0 }),
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
    },
  });

  const app = express();
  app.use(express.json());
  // Mount under both prefixes, mirroring index.js
  app.use('/api/contributions', router);
  app.use('/api/campaigns', router);
  return app;
}

// ---------------------------------------------------------------------------
// POST /:contributionId/dedication — create
// ---------------------------------------------------------------------------
test('POST /dedication — 201 creates a new dedication', async () => {
  let insertCalled = false;

  const app = buildApp({
    queryImpl: async (sql) => {
      // resolveContribution: stellar_transactions JOIN campaigns
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      // fetchDedication check (no existing)
      if (sql.includes('FROM contribution_dedications') && sql.includes('contribution_id = $1') && !sql.includes('INSERT'))
        return { rows: [] };
      // INSERT
      if (sql.includes('INSERT INTO contribution_dedications')) {
        insertCalled = true;
        return { rows: [DEDICATION_ROW] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'Jane Doe', message: 'In loving memory', dedication_type: 'in_memory_of' });

  assert.equal(res.status, 201);
  assert.equal(res.body.id, DEDICATION_ID);
  assert.equal(res.body.honoree_name, 'Jane Doe');
  assert.ok(insertCalled, 'INSERT should have been called');
});

test('POST /dedication — 404 when contribution does not exist', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [] };
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'Jane Doe' });

  assert.equal(res.status, 404);
});

test('POST /dedication — 403 when user does not own the contribution', async () => {
  const app = buildApp({
    user: { userId: 'other-user-id', role: 'contributor' },
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'Jane Doe' });

  assert.equal(res.status, 403);
});

test('POST /dedication — 409 when dedication already exists', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [DEDICATION_ROW] };
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'Jane Doe' });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'DEDICATION_ALREADY_EXISTS');
});

test('POST /dedication — 401 when not authenticated', async () => {
  const app = buildApp({
    skipAuth: true,
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .post(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'Jane Doe' });

  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// GET /:contributionId/dedication — fetch
// ---------------------------------------------------------------------------
test('GET /dedication — 200 returns public dedication', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [DEDICATION_ROW] };
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/contributions/${CONTRIB_ID}/dedication`);

  assert.equal(res.status, 200);
  assert.equal(res.body.honoree_name, 'Jane Doe');
});

test('GET /dedication — 404 when no dedication exists', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [] };
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/contributions/${CONTRIB_ID}/dedication`);

  assert.equal(res.status, 404);
});

test('GET /dedication — 403 when dedication is private and caller is not the owner', async () => {
  const privateDedication = { ...DEDICATION_ROW, is_public: false, user_id: 'someone-else' };

  const app = buildApp({
    user: { userId: 'random-user', role: 'contributor' },
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [privateDedication] };
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/contributions/${CONTRIB_ID}/dedication`);

  assert.equal(res.status, 403);
});

test('GET /dedication — 200 allows owner to see private dedication', async () => {
  const privateDedication = { ...DEDICATION_ROW, is_public: false };

  const app = buildApp({
    user: { userId: USER_ID, role: 'contributor' },
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [privateDedication] };
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/contributions/${CONTRIB_ID}/dedication`);

  assert.equal(res.status, 200);
});

test('GET /dedication — 200 allows admin to see private dedication', async () => {
  const privateDedication = { ...DEDICATION_ROW, is_public: false, user_id: 'someone-else' };

  const app = buildApp({
    user: { userId: 'admin-user', role: 'admin' },
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [privateDedication] };
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/contributions/${CONTRIB_ID}/dedication`);

  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// PATCH /:contributionId/dedication — update
// ---------------------------------------------------------------------------
test('PATCH /dedication — 200 updates existing dedication', async () => {
  const updated = { ...DEDICATION_ROW, honoree_name: 'John Doe', updated_at: new Date().toISOString() };

  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('SELECT') && sql.includes('contribution_dedications')) return { rows: [DEDICATION_ROW] };
      if (sql.includes('UPDATE contribution_dedications')) return { rows: [updated] };
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'John Doe' });

  assert.equal(res.status, 200);
  assert.equal(res.body.honoree_name, 'John Doe');
});

test('PATCH /dedication — 404 when no dedication exists', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [] };
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'John Doe' });

  assert.equal(res.status, 404);
});

test('PATCH /dedication — 403 when user does not own the dedication', async () => {
  const othersDedication = { ...DEDICATION_ROW, user_id: 'someone-else' };

  const app = buildApp({
    user: { userId: USER_ID, role: 'contributor' },
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [othersDedication] };
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'John Doe' });

  // resolveContribution requireOwner checks contribution ownership (passes because
  // USER_ID owns the contribution), then the dedication ownership check fires.
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// DELETE /:contributionId/dedication — remove
// ---------------------------------------------------------------------------
test('DELETE /dedication — 204 removes dedication', async () => {
  let deleteCalled = false;

  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('DELETE FROM contribution_dedications')) {
        deleteCalled = true;
        return { rows: [] };
      }
      if (sql.includes('FROM contribution_dedications')) return { rows: [DEDICATION_ROW] };
      return { rows: [] };
    },
  });

  const res = await request(app).delete(`/api/contributions/${CONTRIB_ID}/dedication`);

  assert.equal(res.status, 204);
  assert.ok(deleteCalled, 'DELETE query should have been called');
});

test('DELETE /dedication — 404 when no dedication exists', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [] };
      return { rows: [] };
    },
  });

  const res = await request(app).delete(`/api/contributions/${CONTRIB_ID}/dedication`);

  assert.equal(res.status, 404);
});

test('DELETE /dedication — 401 when not authenticated', async () => {
  const app = buildApp({
    skipAuth: true,
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app).delete(`/api/contributions/${CONTRIB_ID}/dedication`);

  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// GET /campaigns/:campaignId/dedications — campaign list
// ---------------------------------------------------------------------------
test('GET /campaigns/:id/dedications — 200 returns paginated public dedications', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('FROM campaigns')) return { rows: [CAMPAIGN_ROW] };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '1' }] };
      if (sql.includes('FROM contribution_dedications')) return { rows: [{ ...DEDICATION_ROW, contributor_name: 'Alice' }] };
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/dedications`);

  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.data[0].honoree_name, 'Jane Doe');
});

test('GET /campaigns/:id/dedications — 404 when campaign not found', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('FROM campaigns')) return { rows: [] };
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/dedications`);

  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Audit side-effect — ensure logAuditEvent is called on create
// ---------------------------------------------------------------------------
test('POST /dedication — calls logAuditEvent with correct resource type', async () => {
  let auditPayload = null;

  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('stellar_transactions')) return { rows: [CONTRIBUTION_ROW] };
      if (sql.includes('FROM contribution_dedications') && !sql.includes('INSERT')) return { rows: [] };
      if (sql.includes('INSERT INTO contribution_dedications')) return { rows: [DEDICATION_ROW] };
      return { rows: [] };
    },
    auditImpl: async (payload) => { auditPayload = payload; },
  });

  await request(app)
    .post(`/api/contributions/${CONTRIB_ID}/dedication`)
    .send({ honoree_name: 'Jane Doe', dedication_type: 'in_memory_of' });

  // Give setImmediate/async a tick to resolve
  await new Promise(r => setImmediate(r));

  assert.ok(auditPayload, 'logAuditEvent should have been called');
  assert.equal(auditPayload.action, 'dedication_created');
  assert.equal(auditPayload.resourceType, 'contribution_dedication');
});
