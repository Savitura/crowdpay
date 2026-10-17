const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';

const SURVEY = {
  id: '33333333-3333-4333-8333-333333333333',
  campaign_id: CAMPAIGN_ID,
  title: 'How did it go?',
  intro: null,
  questions: [{ id: 'delivery', prompt: 'Rate it', type: 'rating', required: true, options: null }],
  status: 'open',
  opens_at: '2026-10-01T00:00:00.000Z',
  closes_at: null,
  published_at: '2026-10-01T00:00:00.000Z',
  closed_at: null,
  created_at: '2026-09-30T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

function defaultService(overrides = {}) {
  return {
    getPublicSurvey: async () => ({ survey: null, response_count: 0, my_response: null }),
    getSurveyByCampaign: async () => null,
    createSurvey: async ({ campaignId, creatorId, ...rest }) => ({
      ...SURVEY,
      status: 'draft',
      campaign_id: campaignId,
      created_by: creatorId,
      ...rest,
    }),
    updateSurvey: async () => SURVEY,
    openSurvey: async () => ({ survey: SURVEY, invited: 3 }),
    closeSurvey: async () => ({ survey: { ...SURVEY, status: 'closed' }, already_closed: false }),
    submitResponse: async ({ campaignId, userId, answers }) => ({
      id: 'resp-1',
      survey_id: SURVEY.id,
      campaign_id: campaignId,
      user_id: userId,
      answers,
    }),
    getResults: async () => ({ survey: SURVEY, response_count: 4, results: [] }),
    listEvents: async () => [],
    ...overrides,
  };
}

function buildApp({
  campaign,
  member = null,
  user = { userId: USER_ID, role: 'creator' },
  service = {},
  auth = true,
} = {}) {
  const campaignRow =
    campaign === undefined
      ? { id: CAMPAIGN_ID, creator_id: USER_ID, title: 'Water', status: 'completed' }
      : campaign;

  const router = proxyquire('./outcomeSurveys', {
    '../config/database': {
      query: async sql => {
        if (String(sql).includes('FROM campaigns c')) {
          return { rows: campaignRow ? [campaignRow] : [], rowCount: campaignRow ? 1 : 0 };
        }
        if (String(sql).includes('FROM campaign_members')) {
          return { rows: member ? [member] : [], rowCount: member ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!auth) return res.status(401).json({ error: 'Unauthorized' });
        req.user = user;
        next();
      },
      optionalAuth: (req, res, next) => {
        req.user = user;
        next();
      },
    },
    '../services/outcomeSurveyService': defaultService(service),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  // Mount the real error envelope so tests observe the same wire format a
  // client sees (src/index.js does the same after the routers).
  const { normalizeErrorResponse, errorHandler } = require('../middleware/errorHandler');
  app.use(normalizeErrorResponse);
  app.use(errorHandler);
  return app;
}

// ── read ───────────────────────────────────────────────────────────────────

test('GET /:campaignId/outcome-survey is readable anonymously and 404s unknown campaigns', async () => {
  const app = buildApp();
  const ok = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { survey: null, response_count: 0, my_response: null });

  const missing = buildApp({ campaign: null });
  const res = await request(missing).get(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`);
  assert.equal(res.status, 404);
});

test('GET /:campaignId/outcome-survey passes the viewer id through to the service', async () => {
  let seenViewer = 'unset';
  const app = buildApp({
    service: {
      getPublicSurvey: async (_campaignId, viewerId) => {
        seenViewer = viewerId;
        return { survey: SURVEY, response_count: 2, my_response: null };
      },
    },
  });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`);
  assert.equal(res.status, 200);
  assert.equal(seenViewer, USER_ID);
  assert.equal(res.body.response_count, 2);
});

// ── create ─────────────────────────────────────────────────────────────────

test('POST creates a draft for the campaign creator', async () => {
  let seen;
  const app = buildApp({
    service: {
      createSurvey: async payload => {
        seen = payload;
        return { ...SURVEY, status: 'draft' };
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'How did it go?', questions: [{ prompt: 'Rate it', type: 'rating' }] });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'draft');
  assert.equal(seen.creatorId, USER_ID);
  assert.equal(seen.campaignId, CAMPAIGN_ID);
  assert.equal(seen.title, 'How did it go?');
});

test('POST 409s when a survey already exists', async () => {
  const app = buildApp({ service: { getSurveyByCampaign: async () => SURVEY } });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'Again' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'An outcome survey already exists for this campaign');
});

test('POST 403s for a contributor who is neither creator nor accepted manager', async () => {
  let called = false;
  const app = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    user: { userId: USER_ID, role: 'contributor' },
    service: {
      createSurvey: async () => {
        called = true;
        return SURVEY;
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'Nope' });

  assert.equal(res.status, 403);
  assert.match(res.body.error, /campaign creator or an accepted manager/);
  assert.equal(called, false);
});

test('POST allows an accepted manager but not a pending invite', async () => {
  const manager = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    member: { role: 'manager', accepted_at: new Date().toISOString() },
  });
  assert.equal(
    (
      await request(manager)
        .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
        .send({ title: 'ok' })
    ).status,
    201
  );

  const pending = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    member: { role: 'manager', accepted_at: null },
  });
  assert.equal(
    (
      await request(pending)
        .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
        .send({ title: 'ok' })
    ).status,
    403
  );
});

test('POST allows a viewer role to read but not to manage', async () => {
  const app = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    member: { role: 'viewer', accepted_at: new Date().toISOString() },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'ok' });
  assert.equal(res.status, 403);
});

test('POST allows an admin regardless of membership', async () => {
  const app = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    user: { userId: USER_ID, role: 'admin' },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'ok' });
  assert.equal(res.status, 201);
});

test('POST requires authentication', async () => {
  const app = buildApp({ auth: false });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'ok' });
  assert.equal(res.status, 401);
});

test('POST surfaces the service 409 through the shared error envelope', async () => {
  const app = buildApp({
    service: {
      createSurvey: async () => {
        const error = new Error(
          'Outcome surveys can only be created once the campaign has finished funding (current status: "active")'
        );
        error.status = 409;
        throw error;
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'ok' });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /finished funding/);
});

test('POST surfaces a service 422 (invalid questions) with the field list intact', async () => {
  const app = buildApp({
    service: {
      createSurvey: async () => {
        const error = new Error('single_choice questions need at least two options');
        error.status = 422;
        error.fields = [{ field: 'questions[0].options', message: 'needs two options' }];
        throw error;
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'ok', questions: [{ prompt: 'q', type: 'single_choice' }] });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(res.body.error.fields, [
    { field: 'questions[0].options', message: 'needs two options' },
  ]);
});

test('POST /respond surfaces a duplicate-submission 409', async () => {
  const app = buildApp({
    service: {
      submitResponse: async () => {
        const error = new Error('You have already responded to this outcome survey');
        error.status = 409;
        throw error;
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/respond`)
    .send({ answers: { delivery: 5 } });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /already responded/);
});

test('POST /respond surfaces a non-contributor 403', async () => {
  const app = buildApp({
    service: {
      submitResponse: async () => {
        const error = new Error('Only contributors to this campaign can respond');
        error.status = 403;
        throw error;
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/respond`)
    .send({ answers: {} });
  assert.equal(res.status, 403);
});

// ── update ─────────────────────────────────────────────────────────────────

test('PUT forwards the draft edit to the service', async () => {
  let seen;
  const app = buildApp({
    service: {
      updateSurvey: async payload => {
        seen = payload;
        return { ...SURVEY, title: 'Updated' };
      },
    },
  });
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'Updated', questions: [] });

  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Updated');
  assert.equal(seen.actorId, USER_ID);
});

test('PUT 403s for a non-manager', async () => {
  const app = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    user: { userId: USER_ID, role: 'contributor' },
  });
  const res = await request(app)
    .put(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey`)
    .send({ title: 'x', questions: [] });
  assert.equal(res.status, 403);
});

// ── open / close ───────────────────────────────────────────────────────────

test('POST /open reports how many backers were invited', async () => {
  let seen;
  const app = buildApp({
    service: {
      openSurvey: async payload => {
        seen = payload;
        return { survey: { ...SURVEY, status: 'open' }, invited: 7 };
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/open`)
    .send({ closes_at: '2026-12-01T00:00:00.000Z' });

  assert.equal(res.status, 200);
  assert.equal(res.body.invited, 7);
  assert.equal(seen.closesAt, '2026-12-01T00:00:00.000Z');
  assert.equal(seen.actorId, USER_ID);
});

test('POST /open defaults closes_at to null when the body omits it', async () => {
  let seen;
  const app = buildApp({
    service: {
      openSurvey: async payload => {
        seen = payload;
        return { survey: SURVEY, invited: 0 };
      },
    },
  });
  await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/open`).send({});
  assert.equal(seen.closesAt, null);
});

test('POST /close is reported as idempotent when the survey was already closed', async () => {
  const app = buildApp({
    service: {
      closeSurvey: async () => ({ survey: { ...SURVEY, status: 'closed' }, already_closed: true }),
    },
  });
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/close`);
  assert.equal(res.status, 200);
  assert.equal(res.body.already_closed, true);
});

test('POST /close 403s for a non-manager', async () => {
  const app = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    user: { userId: USER_ID, role: 'contributor' },
  });
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/close`);
  assert.equal(res.status, 403);
});

// ── respond ────────────────────────────────────────────────────────────────

test('POST /respond records a submission and returns 201', async () => {
  let seen;
  const app = buildApp({
    user: { userId: USER_ID, role: 'contributor' },
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    service: {
      submitResponse: async payload => {
        seen = payload;
        return { id: 'resp-1', ...payload };
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/respond`)
    .send({ answers: { delivery: 5 } });

  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'resp-1');
  assert.deepEqual(seen, {
    campaignId: CAMPAIGN_ID,
    userId: USER_ID,
    answers: { delivery: 5 },
  });
});

test('POST /respond lets a contributor respond even though they cannot manage', async () => {
  let called = false;
  const app = buildApp({
    user: { userId: USER_ID, role: 'contributor' },
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    service: {
      submitResponse: async () => {
        called = true;
        return { id: 'resp-1' };
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/respond`)
    .send({ answers: {} });
  assert.equal(res.status, 201);
  assert.equal(called, true);
});

test('POST /respond passes a missing answers body through as undefined', async () => {
  let seen = 'unset';
  const app = buildApp({
    service: {
      submitResponse: async payload => {
        seen = payload.answers;
        return { id: 'resp-1' };
      },
    },
  });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/respond`)
    .send({});
  assert.equal(res.status, 201);
  assert.equal(seen, undefined, 'the service owns the 422 for a malformed answers payload');
});

test('POST /respond requires authentication', async () => {
  const app = buildApp({ auth: false });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/respond`)
    .send({ answers: {} });
  assert.equal(res.status, 401);
});

// ── results / events ───────────────────────────────────────────────────────

test('GET /results returns aggregates to the creator', async () => {
  const app = buildApp({
    service: {
      getResults: async () => ({
        survey: SURVEY,
        response_count: 2,
        results: [{ question_id: 'delivery', average_rating: 4.5, answered: 2 }],
      }),
    },
  });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/results`);

  assert.equal(res.status, 200);
  assert.equal(res.body.response_count, 2);
  assert.equal(res.body.results[0].average_rating, 4.5);
});

test('GET /results 403s for a contributor so backers cannot deanonymise each other', async () => {
  const app = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    user: { userId: USER_ID, role: 'contributor' },
  });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/results`);
  assert.equal(res.status, 403);
});

test('GET /results 404s for an unknown campaign', async () => {
  const app = buildApp({ campaign: null });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/results`);
  assert.equal(res.status, 404);
});

test('GET /events returns the ordered lifecycle trail to the creator', async () => {
  const app = buildApp({
    service: { listEvents: async () => [{ to_status: 'draft' }, { to_status: 'open' }] },
  });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/events`);

  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 2);
});

test('GET /events 403s for a non-manager', async () => {
  const app = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER, title: 'Water', status: 'completed' },
    user: { userId: USER_ID, role: 'contributor' },
  });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/outcome-survey/events`);
  assert.equal(res.status, 403);
});
