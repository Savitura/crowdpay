// Proves the #960/#961 endpoints are actually published in the generated
// OpenAPI document. A route without an @openapi block is invisible to
// /api/docs, so this guard keeps the documentation honest.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const swaggerJsdoc = require('swagger-jsdoc');

// Mirrors the swaggerJsdoc call in src/index.js.
const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'CrowdPay API', version: '1.0.0' },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  },
  apis: [path.join(__dirname, '*.js').replace(/\\/g, '/')],
});

test('the outcome survey and communication preference routes are documented (#960, #961)', () => {
  const expected = [
    '/api/campaigns/{campaignId}/communication-preferences',
    '/api/campaigns/communication-preferences/channels',
    '/api/campaigns/{campaignId}/outcome-survey',
    '/api/campaigns/{campaignId}/outcome-survey/open',
    '/api/campaigns/{campaignId}/outcome-survey/close',
    '/api/campaigns/{campaignId}/outcome-survey/respond',
    '/api/campaigns/{campaignId}/outcome-survey/results',
    '/api/campaigns/{campaignId}/outcome-survey/events',
  ];
  for (const route of expected) {
    assert.ok(spec.paths[route], `${route} is missing from the OpenAPI document`);
  }
});

test('the outcome survey document describes its full lifecycle', () => {
  const survey = spec.paths['/api/campaigns/{campaignId}/outcome-survey'];
  assert.deepEqual(Object.keys(survey).sort(), ['get', 'post', 'put']);

  // Duplicate-create, wrong-state and not-a-contributor behaviour is part of
  // the contract, not an implementation detail.
  assert.ok(survey.post.responses['409'], 'POST documents the duplicate/not-eligible 409');
  assert.ok(survey.post.responses['422'], 'POST documents the validation 422');
  assert.deepEqual(
    survey.post.responses['403'].description,
    'Creator, accepted manager, or admin only'
  );
});

test('the respond endpoint documents every deterministic failure mode', () => {
  const respond = spec.paths['/api/campaigns/{campaignId}/outcome-survey/respond'].post;
  for (const status of ['201', '401', '403', '404', '409', '422', '429']) {
    assert.ok(respond.responses[status], `respond is missing the ${status} response`);
  }
  assert.match(respond.responses['409'].description, /already answered/);
});

test('the results endpoint is documented as aggregated-only', () => {
  const results = spec.paths['/api/campaigns/{campaignId}/outcome-survey/results'].get;
  assert.match(results.description, /Per-question aggregates only/);
  assert.match(results.description, /deanonymise/);
});

test('the communication preference document exposes the shared schemas', () => {
  const components = spec.components.schemas;
  assert.ok(components.CampaignCommunicationPreferences);
  assert.ok(components.CampaignCommunicationPreferencePatch);
  assert.deepEqual(Object.keys(components.CampaignCommunicationPreferencePatch.properties).sort(), [
    'funding_updates',
    'messages',
    'milestones',
    'surveys',
    'updates',
  ]);

  const prefs = spec.paths['/api/campaigns/{campaignId}/communication-preferences'];
  assert.deepEqual(Object.keys(prefs).sort(), ['delete', 'get', 'patch', 'put']);
  assert.equal(
    prefs.put.responses['422'].description,
    'No recognised boolean channel was supplied'
  );
  assert.equal(prefs.get.responses['404'].description, 'Campaign not found');
});
