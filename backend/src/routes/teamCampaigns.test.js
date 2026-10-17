const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const PARENT_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_ID = '33333333-3333-3333-3333-333333333333';

function buildApp({
  campaignRow = { id: PARENT_ID, creator_id: 'user-1', title: 'Parent' },
  service = {},
} = {}) {
  const defaultService = {
    getTeamPage: async () => ({ members: [], totals: { member_count: 0 } }),
    addTeamMember: async () => ({ ok: true, member: { id: 'row-1' } }),
    removeTeamMember: async () => true,
  };
  const router = proxyquire('./teamCampaigns', {
    '../config/database': {
      query: async () => ({
        rows: campaignRow ? [campaignRow] : [],
        rowCount: campaignRow ? 1 : 0,
      }),
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1', role: 'creator' };
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
    },
    '../services/teamCampaignService': { ...defaultService, ...service },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

test('GET /:id/team returns the aggregated team page', async () => {
  const app = buildApp({
    service: {
      getTeamPage: async () => ({
        members: [{ id: MEMBER_ID, title: 'Team A', progress_percent: 40 }],
        totals: { member_count: 1, target_amount: 100, raised_amount: 40 },
      }),
    },
  });

  const response = await request(app).get(`/api/campaigns/${PARENT_ID}/team`);
  assert.equal(response.status, 200);
  assert.equal(response.body.totals.member_count, 1);
  assert.equal(response.body.members[0].id, MEMBER_ID);
});

test('GET /:id/team 404s when the parent campaign does not exist', async () => {
  const app = buildApp({ campaignRow: null });

  const response = await request(app).get(`/api/campaigns/${PARENT_ID}/team`);
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'Campaign not found');
});

test('GET /:id/team rejects non-uuid ids with 422', async () => {
  const app = buildApp();

  const response = await request(app).get('/api/campaigns/not-a-uuid/team');
  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'Validation failed');
});

test('POST /:id/team/members adds a member for the owner', async () => {
  let addedArgs;
  const app = buildApp({
    service: {
      addTeamMember: async (parentId, memberId, input) => {
        addedArgs = { parentId, memberId, input };
        return { ok: true, member: { id: 'row-1' } };
      },
    },
  });

  const response = await request(app)
    .post(`/api/campaigns/${PARENT_ID}/team/members`)
    .send({ member_campaign_id: MEMBER_ID });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'row-1');
  assert.equal(addedArgs.parentId, PARENT_ID);
  assert.equal(addedArgs.memberId, MEMBER_ID);
  assert.equal(addedArgs.input.invited_by, 'user-1');
});

test('POST /:id/team/members 403s when the caller is not the owner', async () => {
  const app = buildApp({
    campaignRow: { id: PARENT_ID, creator_id: 'someone-else', title: 'Parent' },
  });

  const response = await request(app)
    .post(`/api/campaigns/${PARENT_ID}/team/members`)
    .send({ member_campaign_id: MEMBER_ID });

  assert.equal(response.status, 403);
});

test('POST /:id/team/members forwards service 422 rejections', async () => {
  const app = buildApp({
    service: {
      addTeamMember: async () => ({
        ok: false,
        status: 422,
        error: 'A campaign cannot be a member of itself',
      }),
    },
  });

  const response = await request(app)
    .post(`/api/campaigns/${PARENT_ID}/team/members`)
    .send({ member_campaign_id: PARENT_ID });

  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'A campaign cannot be a member of itself');
});

test('POST /:id/team/members rejects an invalid body with 422', async () => {
  const app = buildApp();

  const response = await request(app)
    .post(`/api/campaigns/${PARENT_ID}/team/members`)
    .send({ member_campaign_id: 'not-a-uuid' });

  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'Validation failed');
});

test('DELETE /:id/team/members/:memberId removes a membership for the owner', async () => {
  let removedArgs;
  const app = buildApp({
    service: {
      removeTeamMember: async (parentId, memberId) => {
        removedArgs = { parentId, memberId };
        return true;
      },
    },
  });

  const response = await request(app).delete(
    `/api/campaigns/${PARENT_ID}/team/members/${MEMBER_ID}`
  );
  assert.equal(response.status, 204);
  assert.equal(removedArgs.parentId, PARENT_ID);
  assert.equal(removedArgs.memberId, MEMBER_ID);
});

test('DELETE /:id/team/members/:memberId 404s for unknown membership', async () => {
  const app = buildApp({ service: { removeTeamMember: async () => false } });

  const response = await request(app).delete(
    `/api/campaigns/${PARENT_ID}/team/members/${OTHER_ID}`
  );
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'Team member not found');
});

test('DELETE 403s when the caller does not own the parent', async () => {
  const app = buildApp({
    campaignRow: { id: PARENT_ID, creator_id: 'someone-else', title: 'Parent' },
  });

  const response = await request(app).delete(
    `/api/campaigns/${PARENT_ID}/team/members/${MEMBER_ID}`
  );
  assert.equal(response.status, 403);
});
