const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp(queryImpl) {
  const router = proxyquire('./notifications', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1', role: 'contributor' };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/notifications', router);
  return app;
}

test('GET /channel-settings returns null defaults when none are stored', async () => {
  const app = buildApp(async () => ({ rows: [] }));

  const res = await request(app).get('/api/notifications/channel-settings');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    push_token: null,
    slack_webhook_url: null,
    discord_webhook_url: null,
    sms_phone_number: null,
    quiet_hours_start: null,
    quiet_hours_end: null,
  });
});

test('PUT /channel-settings upserts and echoes stored destinations', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    return {
      rows: [{
        push_token: 'tok-1',
        slack_webhook_url: 'https://hooks.slack.com/abc',
        discord_webhook_url: null,
        sms_phone_number: null,
        quiet_hours_start: 22,
        quiet_hours_end: 7,
      }],
    };
  });

  const res = await request(app)
    .put('/api/notifications/channel-settings')
    .send({
      push_token: 'tok-1',
      slack_webhook_url: 'https://hooks.slack.com/abc',
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.push_token, 'tok-1');
  assert.equal(res.body.quiet_hours_start, 22);
  const upsert = calls.find((c) => c.text.includes('INSERT INTO notification_channel_settings'));
  assert.ok(upsert);
  assert.equal(upsert.params[0], 'user-1');
});

test('PUT /channel-settings rejects out-of-range quiet hours', async () => {
  const app = buildApp(async () => ({ rows: [] }));

  const res = await request(app)
    .put('/api/notifications/channel-settings')
    .send({ quiet_hours_start: 25 });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /quiet_hours/);
});

test('PUT /preferences stores a per-event channel override', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    return { rows: [] };
  });

  const res = await request(app)
    .put('/api/notifications/preferences')
    .send({ event_type: 'campaign_update', channel: 'slack', enabled: false });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const insert = calls.find((c) => c.text.includes('INSERT INTO notification_preferences'));
  assert.ok(insert);
  assert.deepEqual(insert.params, ['user-1', 'campaign_update', 'slack', false]);
});

test('PUT /preferences rejects an unknown channel', async () => {
  const app = buildApp(async () => ({ rows: [] }));

  const res = await request(app)
    .put('/api/notifications/preferences')
    .send({ event_type: 'campaign_update', channel: 'carrier_pigeon', enabled: true });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /channel/);
});

test('PUT /preferences rejects a non-boolean enabled flag', async () => {
  const app = buildApp(async () => ({ rows: [] }));

  const res = await request(app)
    .put('/api/notifications/preferences')
    .send({ event_type: 'campaign_update', channel: 'slack', enabled: 'yes' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /enabled/);
});
