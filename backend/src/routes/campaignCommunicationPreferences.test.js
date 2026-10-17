const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const ALL_ON = {
  campaign_id: CAMPAIGN_ID,
  updates: true,
  milestones: true,
  funding_updates: true,
  messages: true,
  surveys: true,
};

function buildApp({ campaignExists = true, service = {}, auth = true } = {}) {
  const defaults = {
    getPreferences: async () => ALL_ON,
    setPreferences: async (_campaignId, _userId, patch) => ({
      ok: true,
      preferences: { ...ALL_ON, ...patch },
    }),
    resetPreferences: async () => ALL_ON,
    pickChannels: input =>
      ['updates', 'milestones', 'funding_updates', 'messages', 'surveys'].filter(
        channel => typeof input?.[channel] === 'boolean'
      ),
    auditPreferenceChange: async () => {},
  };
  const audits = [];
  const router = proxyquire('./campaignCommunicationPreferences', {
    '../config/database': {
      query: async () => ({
        rows: campaignExists ? [{ id: CAMPAIGN_ID }] : [],
        rowCount: campaignExists ? 1 : 0,
      }),
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!auth) return res.status(401).json({ error: 'Unauthorized' });
        req.user = { userId: USER_ID, role: 'contributor' };
        next();
      },
    },
    '../services/communicationPreferenceService': {
      ...defaults,
      ...service,
      CHANNELS: ['updates', 'milestones', 'funding_updates', 'messages', 'surveys'],
      CHANNEL_DESCRIPTIONS: {
        updates: 'Campaign updates and progress notes',
        milestones: 'Milestone progress, submissions, and releases',
        funding_updates: 'Funding progress milestones',
        messages: 'Replies to your comments and thank-you messages',
        surveys: 'Outcome surveys and other research from this campaign',
      },
      pickChannels: defaults.pickChannels,
      auditPreferenceChange: async event => {
        audits.push(event);
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return { app, audits };
}

test('GET /:campaignId/communication-preferences returns the effective preferences', async () => {
  const { app } = buildApp();
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ALL_ON);
});

test('GET /:campaignId/communication-preferences 404s for an unknown campaign', async () => {
  const { app } = buildApp({ campaignExists: false });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`);

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Campaign not found');
});

test('GET /:campaignId/communication-preferences requires authentication', async () => {
  const { app } = buildApp({ auth: false });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`);

  assert.equal(res.status, 401);
});

test('PUT stores a partial patch and audits the change', async () => {
  const writes = [];
  const { app, audits } = buildApp({
    service: {
      setPreferences: async (campaignId, userId, patch) => {
        writes.push({ campaignId, userId, patch });
        return { ok: true, preferences: { ...ALL_ON, ...patch } };
      },
    },
  });

  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`)
    .send({ surveys: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.surveys, false);
  assert.equal(res.body.updates, true, 'untouched channels are preserved');
  assert.deepEqual(writes, [
    { campaignId: CAMPAIGN_ID, userId: USER_ID, patch: { surveys: false } },
  ]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'campaign_communication_preferences_updated');
  assert.deepEqual(audits[0].channels, ['surveys']);
  assert.deepEqual(audits[0].values, { surveys: false });
  assert.equal(audits[0].campaignId, CAMPAIGN_ID);
  assert.equal(audits[0].userId, USER_ID);
  assert.ok(audits[0].req, 'the raw request is forwarded so the audit row records ip + user-agent');
});

test('PATCH behaves like PUT', async () => {
  const { app } = buildApp();
  const res = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`)
    .send({ messages: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.messages, false);
});

test('PUT forwards a 422 from the service when no channel is recognised', async () => {
  const { app, audits } = buildApp({
    service: {
      setPreferences: async () => ({
        ok: false,
        status: 422,
        error: 'Provide at least one boolean preference: updates, milestones',
      }),
    },
  });

  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`)
    .send({ nonsense: true });

  assert.equal(res.status, 422);
  assert.match(res.body.error, /at least one boolean preference/);
  assert.equal(audits.length, 0, 'a rejected write must not be audited as a change');
});

test('PUT 404s before writing when the campaign does not exist', async () => {
  let called = false;
  const { app } = buildApp({
    campaignExists: false,
    service: {
      setPreferences: async () => {
        called = true;
        return { ok: true, preferences: ALL_ON };
      },
    },
  });

  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`)
    .send({ surveys: false });

  assert.equal(res.status, 404);
  assert.equal(called, false);
});

test('DELETE resets to the defaults and records a reset audit event', async () => {
  let deleted = false;
  const { app, audits } = buildApp({
    service: {
      resetPreferences: async (campaignId, userId) => {
        deleted = campaignId === CAMPAIGN_ID && userId === USER_ID;
        return ALL_ON;
      },
    },
  });

  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ALL_ON);
  assert.equal(deleted, true);
  assert.equal(audits[0].action, 'campaign_communication_preferences_reset');
});

test('DELETE is idempotent for a contributor who never overrode anything', async () => {
  const { app } = buildApp();
  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/communication-preferences`);
  assert.equal(res.status, 200);
  assert.equal(res.body.milestones, true);
});

test('GET /communication-preferences/channels documents the supported channels', async () => {
  const { app } = buildApp();
  const res = await request(app).get('/api/campaigns/communication-preferences/channels');

  assert.equal(res.status, 200);
  assert.equal(res.body.channels.length, 5);
  assert.deepEqual(
    res.body.channels.map(c => c.id),
    ['updates', 'milestones', 'funding_updates', 'messages', 'surveys']
  );
  assert.equal(res.body.channels[0].description, 'Campaign updates and progress notes');
});

test('the literal channels route is not shadowed by the parameterised route', async () => {
  const { app } = buildApp();
  // `/communication-preferences/channels` has two segments, so it must not be
  // swallowed by `/:campaignId/communication-preferences`.
  const res = await request(app).get('/api/campaigns/communication-preferences/channels');
  assert.equal(res.status, 200);
  assert.ok(res.body.channels);
});
