const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const OUTSIDER_ID = '44444444-4444-4444-8444-444444444444';

const SAMPLE_DOSSIER = {
  id: '55555555-5555-4555-8555-555555555555',
  campaign_id: CAMPAIGN_ID,
  incident_name: 'Lower Niger Basin Flood Response',
  disaster_type: 'flood',
  severity_level: 'critical',
  affected_region: 'Kogi & Anambra States',
  affected_population: 25000,
  responder_organization: 'Red Crescent Field Unit',
  emergency_contact: 'ops-lead@redcrescent.example',
  verification_badge: 'Verified Rapid Response',
  evidence_items: [
    {
      id: 'nema_bulletin',
      title: 'NEMA Flood Emergency Bulletin',
      type: 'government_notice',
      url: 'https://nema.gov.example/bulletins/2026-flood-alert',
      issuer: 'NEMA',
    },
  ],
  status: 'verified',
  rapid_disbursement_enabled: true,
  submitted_at: '2026-10-23T08:00:00.000Z',
  reviewed_at: '2026-10-23T09:00:00.000Z',
  revoked_at: null,
  sla: null,
};

function defaultService(overrides = {}) {
  return {
    getDisasterReliefView: async (_campaignId, { isManager }) => ({
      disaster_relief: isManager
        ? SAMPLE_DOSSIER
        : {
            ...SAMPLE_DOSSIER,
            emergency_contact: undefined,
          },
    }),
    getDisasterReliefByCampaign: async () => null,
    createDisasterReliefDossier: async ({ campaignId, actorId, req: _req, ...rest }) => ({
      ...SAMPLE_DOSSIER,
      campaign_id: campaignId,
      created_by: actorId,
      status: 'draft',
      rapid_disbursement_enabled: false,
      ...rest,
    }),
    updateDisasterReliefDossier: async ({ campaignId, actorId: _actorId, req: _req, ...rest }) => ({
      ...SAMPLE_DOSSIER,
      campaign_id: campaignId,
      status: 'draft',
      ...rest,
    }),
    submitForRapidVerification: async () => ({
      ...SAMPLE_DOSSIER,
      status: 'pending_review',
      sla: {
        target_hours: 4,
        due_at: '2026-10-23T12:00:00.000Z',
        remaining_ms: 7200000,
        is_overdue: false,
      },
    }),
    reviewDisasterReliefDossier: async ({ decision, note, verificationBadge }) => ({
      ...SAMPLE_DOSSIER,
      status: decision,
      review_note: note || null,
      verification_badge: verificationBadge || 'Verified Rapid Response',
    }),
    revokeDisasterReliefVerification: async ({ reason }) => ({
      ...SAMPLE_DOSSIER,
      status: 'revoked',
      rapid_disbursement_enabled: false,
      revoked_reason: reason,
    }),
    listEvents: async () => [
      { id: 'evt-1', to_status: 'draft' },
      { id: 'evt-2', to_status: 'pending_review' },
    ],
    listRapidVerificationQueue: async () => [
      {
        ...SAMPLE_DOSSIER,
        status: 'pending_review',
        campaign_title: 'Flood Relief',
      },
    ],
    ...overrides,
  };
}

function buildApp({
  campaign,
  member = null,
  user = { userId: CREATOR_ID, role: 'creator' },
  service = {},
  auth = true,
} = {}) {
  const campaignRow =
    campaign === undefined
      ? { id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Flood Relief', status: 'active' }
      : campaign;

  const router = proxyquire('./disasterRelief', {
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
        req.user = auth ? user : null;
        next();
      },
    },
    '../services/disasterReliefService': defaultService(service),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  const { normalizeErrorResponse, errorHandler } = require('../middleware/errorHandler');
  app.use(normalizeErrorResponse);
  app.use(errorHandler);
  return app;
}

test('GET /:campaignId/disaster-relief returns public view for anonymous callers and 404s unknown campaigns', async () => {
  let seenIsManager = null;
  const app = buildApp({
    auth: false,
    service: {
      getDisasterReliefView: async (_id, { isManager }) => {
        seenIsManager = isManager;
        return { disaster_relief: null };
      },
    },
  });

  const ok = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`);
  assert.equal(ok.status, 200);
  assert.equal(seenIsManager, false);
  assert.deepEqual(ok.body, { disaster_relief: null });

  const missing = buildApp({ campaign: null });
  const notFound = await request(missing).get(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`);
  assert.equal(notFound.status, 404);
});

test('GET /:campaignId/disaster-relief grants manager view to creator, accepted manager, and admin', async () => {
  const seenRoles = [];
  const svc = {
    getDisasterReliefView: async (_id, { isManager }) => {
      seenRoles.push(isManager);
      return { disaster_relief: SAMPLE_DOSSIER };
    },
  };

  // Creator
  const creatorApp = buildApp({ service: svc });
  await request(creatorApp).get(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`);

  // Accepted campaign manager
  const managerApp = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER_ID, title: 'Flood', status: 'active' },
    member: { role: 'manager', accepted_at: '2026-10-01T00:00:00.000Z' },
    user: { userId: CREATOR_ID, role: 'contributor' },
    service: svc,
  });
  await request(managerApp).get(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`);

  // Unaccepted invitee -> not a manager
  const unacceptedApp = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER_ID, title: 'Flood', status: 'active' },
    member: { role: 'manager', accepted_at: null },
    user: { userId: CREATOR_ID, role: 'contributor' },
    service: svc,
  });
  await request(unacceptedApp).get(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`);

  assert.deepEqual(seenRoles, [true, true, false]);
});

test('POST /:campaignId/disaster-relief creates a draft dossier for managers and blocks outsiders or duplicates', async () => {
  const app = buildApp();
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`).send({
    incident_name: 'Lower Niger Basin Flood Response',
    disaster_type: 'flood',
    severity_level: 'critical',
    affected_region: 'Kogi & Anambra States',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.disaster_relief.status, 'draft');

  // Duplicate dossier returns 409
  const dupApp = buildApp({
    service: {
      getDisasterReliefByCampaign: async () => SAMPLE_DOSSIER,
    },
  });
  const dupRes = await request(dupApp).post(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`).send({
    incident_name: 'Flood',
  });
  assert.equal(dupRes.status, 409);

  // Outsider returns 403
  const outsiderApp = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER_ID, title: 'Flood', status: 'active' },
    user: { userId: CREATOR_ID, role: 'contributor' },
  });
  const forbidden = await request(outsiderApp)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`)
    .send({ incident_name: 'Flood' });
  assert.equal(forbidden.status, 403);
});

test('PUT /:campaignId/disaster-relief and POST /submit manage draft updates and rapid verification submission', async () => {
  const app = buildApp();
  const updated = await request(app).put(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief`).send({
    incident_name: 'Updated Incident Name',
    disaster_type: 'flood',
    severity_level: 'urgent',
    affected_region: 'Lagos',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.disaster_relief.incident_name, 'Updated Incident Name');

  const submitted = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief/submit`)
    .send({});
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.disaster_relief.status, 'pending_review');
  assert.equal(submitted.body.disaster_relief.sla.target_hours, 4);
});

test('POST /review and POST /revoke enforce admin-only authorization', async () => {
  // Creator (non-admin) cannot review their own disaster-relief dossier
  const creatorApp = buildApp({ user: { userId: CREATOR_ID, role: 'creator' } });
  const creatorReview = await request(creatorApp)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief/review`)
    .send({ decision: 'verified' });
  assert.equal(creatorReview.status, 403);

  const creatorRevoke = await request(creatorApp)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief/revoke`)
    .send({ reason: 'Test' });
  assert.equal(creatorRevoke.status, 403);

  // Admin can review and revoke
  const adminApp = buildApp({ user: { userId: ADMIN_ID, role: 'admin' } });
  const adminReview = await request(adminApp)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief/review`)
    .send({
      decision: 'verified',
      note: 'Verified with NEMA emergency desk',
      verification_badge: 'Verified Rapid Response',
      rapid_disbursement_enabled: true,
    });
  assert.equal(adminReview.status, 200);
  assert.equal(adminReview.body.disaster_relief.status, 'verified');

  const adminRevoke = await request(adminApp)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief/revoke`)
    .send({ reason: 'Emergency declaration lifted' });
  assert.equal(adminRevoke.status, 200);
  assert.equal(adminRevoke.body.disaster_relief.status, 'revoked');
});

test('GET /disaster-relief/queue is restricted to admins and returns prioritized queue', async () => {
  const nonAdminApp = buildApp({ user: { userId: CREATOR_ID, role: 'creator' } });
  const forbidden = await request(nonAdminApp).get('/api/campaigns/disaster-relief/queue');
  assert.equal(forbidden.status, 403);

  const adminApp = buildApp({ user: { userId: ADMIN_ID, role: 'admin' } });
  const ok = await request(adminApp).get(
    '/api/campaigns/disaster-relief/queue?status=pending_review'
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.queue.length, 1);
  assert.equal(ok.body.queue[0].status, 'pending_review');
});

test('GET /:campaignId/disaster-relief/events returns audit trail to managers and 403s outsiders', async () => {
  const managerApp = buildApp();
  const ok = await request(managerApp).get(`/api/campaigns/${CAMPAIGN_ID}/disaster-relief/events`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.events.length, 2);

  const outsiderApp = buildApp({
    campaign: { id: CAMPAIGN_ID, creator_id: OUTSIDER_ID, title: 'Flood', status: 'active' },
    user: { userId: CREATOR_ID, role: 'contributor' },
  });
  const forbidden = await request(outsiderApp).get(
    `/api/campaigns/${CAMPAIGN_ID}/disaster-relief/events`
  );
  assert.equal(forbidden.status, 403);
});
