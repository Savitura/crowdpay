const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const MILESTONE_ID = '11111111-1111-1111-1111-111111111111';
const ITEM_ID = '22222222-2222-2222-2222-222222222222';

function buildApp({
  milestoneRow = { id: MILESTONE_ID, campaign_id: 'c1', status: 'pending', creator_id: 'user-1' },
  service = {},
} = {}) {
  const defaultService = {
    validateChecklistInput: input => ({ ok: true, items: input?.items ?? null }),
    replaceChecklist: async () => {},
    getChecklistWithStatus: async () => [],
    recordCompletions: async () => ({ ok: true, recorded: 0 }),
  };
  const router = proxyquire('./milestoneChecklists', {
    '../config/database': {
      query: async () => ({
        rows: milestoneRow ? [milestoneRow] : [],
        rowCount: milestoneRow ? 1 : 0,
      }),
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1', role: 'creator' };
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
    },
    '../services/milestoneChecklistService': { ...defaultService, ...service },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/milestones', router);
  return app;
}

test('GET /:id/checklist returns the checklist with status', async () => {
  const app = buildApp({
    service: {
      getChecklistWithStatus: async () => [{ id: ITEM_ID, label: 'Proof', completed: false }],
    },
  });

  const response = await request(app).get(`/api/milestones/${MILESTONE_ID}/checklist`);
  assert.equal(response.status, 200);
  assert.equal(response.body.checklist[0].label, 'Proof');
});

test('GET /:id/checklist 404s for an unknown milestone', async () => {
  const app = buildApp({ milestoneRow: null });

  const response = await request(app).get(`/api/milestones/${MILESTONE_ID}/checklist`);
  assert.equal(response.status, 404);
});

test('PUT /:id/checklist replaces the template for the owner', async () => {
  let replacedWith;
  const app = buildApp({
    service: {
      replaceChecklist: async (_id, items) => {
        replacedWith = items;
      },
      getChecklistWithStatus: async () => [{ id: ITEM_ID, label: 'Demo video' }],
    },
  });

  const response = await request(app)
    .put(`/api/milestones/${MILESTONE_ID}/checklist`)
    .send({ items: [{ label: 'Demo video', required: true }] });

  assert.equal(response.status, 200);
  assert.equal(replacedWith[0].label, 'Demo video');
});

test('PUT /:id/checklist 403s for a non-owner', async () => {
  const app = buildApp({
    milestoneRow: {
      id: MILESTONE_ID,
      campaign_id: 'c1',
      status: 'pending',
      creator_id: 'someone-else',
    },
  });

  const response = await request(app)
    .put(`/api/milestones/${MILESTONE_ID}/checklist`)
    .send({ items: [{ label: 'x' }] });

  assert.equal(response.status, 403);
});

test('PUT /:id/checklist 409s while the milestone is under review', async () => {
  const app = buildApp({
    milestoneRow: {
      id: MILESTONE_ID,
      campaign_id: 'c1',
      status: 'pending_review',
      creator_id: 'user-1',
    },
  });

  const response = await request(app)
    .put(`/api/milestones/${MILESTONE_ID}/checklist`)
    .send({ items: [{ label: 'x' }] });

  assert.equal(response.status, 409);
});

test('PUT /:id/checklist forwards validation failures with 422', async () => {
  const app = buildApp({
    service: {
      validateChecklistInput: () => ({ ok: false, status: 422, error: 'items must be an array' }),
    },
  });

  const response = await request(app)
    .put(`/api/milestones/${MILESTONE_ID}/checklist`)
    .send({ items: 'nope' });

  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'items must be an array');
});

test('POST /:id/checklist/complete records completions for the owner', async () => {
  let completedArgs;
  const app = buildApp({
    service: {
      recordCompletions: async (_id, itemIds, userId) => {
        completedArgs = { itemIds, userId };
        return { ok: true, recorded: 1 };
      },
    },
  });

  const response = await request(app)
    .post(`/api/milestones/${MILESTONE_ID}/checklist/complete`)
    .send({ completed_item_ids: [ITEM_ID] });

  assert.equal(response.status, 200);
  assert.equal(response.body.recorded, 1);
  assert.deepEqual(completedArgs.itemIds, [ITEM_ID]);
  assert.equal(completedArgs.userId, 'user-1');
});

test('POST /:id/checklist/complete rejects missing required items with 422', async () => {
  const app = buildApp({
    service: {
      recordCompletions: async () => ({
        ok: false,
        status: 422,
        error: 'required checklist items not completed: Demo video',
      }),
    },
  });

  const response = await request(app)
    .post(`/api/milestones/${MILESTONE_ID}/checklist/complete`)
    .send({ completed_item_ids: [] });

  assert.equal(response.status, 422);
  assert.match(response.body.error, /Demo video/);
});

test('POST /:id/checklist/complete 403s for a non-owner', async () => {
  const app = buildApp({
    milestoneRow: {
      id: MILESTONE_ID,
      campaign_id: 'c1',
      status: 'pending',
      creator_id: 'someone-else',
    },
  });

  const response = await request(app)
    .post(`/api/milestones/${MILESTONE_ID}/checklist/complete`)
    .send({ completed_item_ids: [ITEM_ID] });

  assert.equal(response.status, 403);
});

test('POST /:id/checklist/complete 404s for an unknown milestone', async () => {
  const app = buildApp({ milestoneRow: null });

  const response = await request(app)
    .post(`/api/milestones/${MILESTONE_ID}/checklist/complete`)
    .send({ completed_item_ids: [] });

  assert.equal(response.status, 404);
});
