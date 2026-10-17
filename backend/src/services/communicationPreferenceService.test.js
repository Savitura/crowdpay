const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Builds the service against a scripted db. `handlers` is an ordered list of
 * `[sqlSubstring, result]` pairs; `calls` records every statement so tests can
 * assert on the exact SQL the service emits.
 */
function buildService(handlers = []) {
  const calls = [];
  const queue = [...handlers];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      const match = queue.find(([fragment]) => String(sql).includes(fragment));
      if (!match) return { rows: [], rowCount: 0 };
      const result = match[1];
      return typeof result === 'function' ? result(sql, params) : result;
    },
    release() {},
  };
  const db = {
    query: async (sql, params) => client.query(sql, params),
    connect: async () => client,
  };
  const audits = [];
  const service = proxyquire('./communicationPreferenceService', {
    '../config/database': db,
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './auditService': {
      logAuditEvent: async event => {
        audits.push(event);
      },
    },
  });
  return { service, calls, audits };
}

test('CHANNELS and DEFAULTS stay in sync so a new column cannot ship half-defaulted', () => {
  const { service } = buildService();
  assert.deepEqual(
    [...service.CHANNELS],
    ['updates', 'milestones', 'funding_updates', 'messages', 'surveys']
  );
  for (const channel of service.CHANNELS) {
    assert.equal(service.DEFAULTS[channel], true, `${channel} must default to true`);
    assert.equal(typeof service.CHANNEL_DESCRIPTIONS[channel], 'string');
    assert.ok(service.CHANNEL_DESCRIPTIONS[channel].length > 0);
  }
});

test('pickChannels only accepts booleans on known channels', () => {
  const { service } = buildService();
  assert.deepEqual(
    service.pickChannels({
      updates: true,
      milestones: false,
      funding_updates: 'yes',
      messages: 0,
      surveys: false,
      evil_column: true,
    }),
    ['updates', 'milestones', 'surveys']
  );
  assert.deepEqual(service.pickChannels({}), []);
  assert.deepEqual(service.pickChannels(null), []);
});

test('getPreferences falls back to the defaults when nothing is stored', async () => {
  const { service } = buildService();
  assert.deepEqual(await service.getPreferences(CAMPAIGN_ID, USER_ID), {
    campaign_id: CAMPAIGN_ID,
    updates: true,
    milestones: true,
    funding_updates: true,
    messages: true,
    surveys: true,
  });
});

test('getPreferences returns the stored override', async () => {
  const { service } = buildService([
    [
      'FROM campaign_communication_preferences',
      {
        rows: [
          {
            campaign_id: CAMPAIGN_ID,
            updates: true,
            milestones: false,
            funding_updates: true,
            messages: false,
            surveys: true,
          },
        ],
      },
    ],
  ]);
  const prefs = await service.getPreferences(CAMPAIGN_ID, USER_ID);
  assert.equal(prefs.milestones, false);
  assert.equal(prefs.messages, false);
  assert.equal(prefs.updates, true);
});

test('setPreferences rejects a body with no recognised channel', async () => {
  const { service, calls } = buildService();
  const result = await service.setPreferences(CAMPAIGN_ID, USER_ID, { nope: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.error, /at least one boolean preference/);
  assert.equal(calls.length, 0, 'must not touch the database for an invalid body');
});

test('setPreferences writes only the channels present in the patch', async () => {
  const { service, calls } = buildService([
    [
      'INSERT INTO campaign_communication_preferences',
      {
        rows: [
          {
            campaign_id: CAMPAIGN_ID,
            updates: true,
            milestones: true,
            funding_updates: true,
            messages: true,
            surveys: true,
          },
        ],
      },
    ],
  ]);

  const result = await service.setPreferences(CAMPAIGN_ID, USER_ID, { surveys: false });
  assert.equal(result.ok, true);

  const insert = calls[0];
  assert.match(
    insert.sql,
    /INSERT INTO campaign_communication_preferences \(campaign_id, user_id, surveys\)/
  );
  assert.match(
    insert.sql,
    /ON CONFLICT \(campaign_id, user_id\) DO UPDATE SET surveys = EXCLUDED\.surveys/
  );
  assert.deepEqual(insert.params, [CAMPAIGN_ID, USER_ID, false]);
});

test('setPreferences coerces every provided channel to a real boolean', async () => {
  const { service, calls } = buildService([
    ['INSERT INTO campaign_communication_preferences', { rows: [{ campaign_id: CAMPAIGN_ID }] }],
  ]);
  await service.setPreferences(CAMPAIGN_ID, USER_ID, { updates: false, milestones: true });
  assert.deepEqual(calls[0].params, [CAMPAIGN_ID, USER_ID, false, true]);
});

test('resetPreferences deletes the row and returns the defaults', async () => {
  const { service, calls } = buildService();
  const prefs = await service.resetPreferences(CAMPAIGN_ID, USER_ID);
  assert.equal(
    calls[0].sql,
    'DELETE FROM campaign_communication_preferences WHERE campaign_id = $1 AND user_id = $2'
  );
  assert.deepEqual(calls[0].params, [CAMPAIGN_ID, USER_ID]);
  assert.equal(prefs.updates, true);
  assert.equal(prefs.surveys, true);
});

test('resetAllForUser reports how many rows it removed', async () => {
  const { service } = buildService([
    ['DELETE FROM campaign_communication_preferences WHERE user_id', { rows: [], rowCount: 4 }],
  ]);
  assert.equal(await service.resetAllForUser(USER_ID), 4);
});

test('listForUser joins the campaign title and skips soft-deleted campaigns', async () => {
  const { service, calls } = buildService([
    [
      'FROM campaign_communication_preferences p',
      { rows: [{ campaign_id: CAMPAIGN_ID, title: 'Water', surveys: false }] },
    ],
  ]);
  const rows = await service.listForUser(USER_ID);
  assert.equal(rows[0].title, 'Water');
  assert.match(calls[0].sql, /JOIN campaigns c ON c\.id = p\.campaign_id/);
  assert.match(calls[0].sql, /c\.deleted_at IS NULL/);
  assert.match(calls[0].sql, /ORDER BY p\.updated_at DESC/);
});

test('isChannelEnabled is true when no override row exists', async () => {
  const { service } = buildService();
  assert.equal(await service.isChannelEnabled(CAMPAIGN_ID, USER_ID, 'surveys'), true);
});

test('isChannelEnabled reads the stored flag', async () => {
  const { service, calls } = buildService([
    ['FROM campaign_communication_preferences', { rows: [{ enabled: false }] }],
  ]);
  assert.equal(await service.isChannelEnabled(CAMPAIGN_ID, USER_ID, 'surveys'), false);
  assert.match(calls[0].sql, /SELECT surveys AS enabled/);
});

test('isChannelEnabled refuses a channel that is not a real column', async () => {
  const { service } = buildService();
  await assert.rejects(
    () => service.isChannelEnabled(CAMPAIGN_ID, USER_ID, 'password; DROP'),
    /Unknown communication channel/
  );
});

test('filterEnabledUsers drops only the users who muted the channel', async () => {
  const muted = '33333333-3333-4333-8333-333333333333';
  const a = '44444444-4444-4444-8444-444444444444';
  const b = '55555555-5555-4555-8555-555555555555';
  const { service, calls } = buildService([
    ['FROM campaign_communication_preferences', { rows: [{ user_id: muted }, { user_id: a }] }],
  ]);

  const kept = await service.filterEnabledUsers(CAMPAIGN_ID, 'surveys', [muted, a, b, b, null]);
  assert.deepEqual(kept, [b]);
  assert.match(calls[0].sql, /AND surveys = FALSE/);
  assert.deepEqual(calls[0].params[1], [muted, a, b]);
});

test('filterEnabledUsers short-circuits an empty recipient list', async () => {
  const { service, calls } = buildService();
  assert.deepEqual(await service.filterEnabledUsers(CAMPAIGN_ID, 'updates', []), []);
  assert.equal(calls.length, 0);
});

test('filterEnabledUsers refuses an unknown channel', async () => {
  const { service } = buildService();
  await assert.rejects(() => filterWithUnknownChannel(service), /Unknown communication channel/);
});

async function filterWithUnknownChannel(service) {
  return service.filterEnabledUsers(CAMPAIGN_ID, 'not_a_channel', [USER_ID]);
}

test('auditPreferenceChange never lets an audit failure escape', async () => {
  const service = proxyquire('./communicationPreferenceService', {
    '../config/database': { query: async () => ({ rows: [] }) },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './auditService': {
      logAuditEvent: async () => {
        throw new Error('audit table missing');
      },
    },
  });

  await service.auditPreferenceChange({
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    channels: ['updates'],
    values: { updates: false },
    action: 'campaign_communication_preferences_updated',
  });
});

test('auditPreferenceChange writes the campaign as the audit resource', async () => {
  const { service, audits } = buildService();
  await service.auditPreferenceChange({
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    channels: ['surveys', 'messages'],
    values: { surveys: false, messages: false },
    action: 'campaign_communication_preferences_updated',
  });

  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorId, USER_ID);
  assert.equal(audits[0].action, 'campaign_communication_preferences_updated');
  assert.equal(audits[0].resourceType, 'campaign_communication_preference');
  assert.equal(audits[0].resourceId, CAMPAIGN_ID);
  assert.deepEqual(audits[0].metadata, {
    channels: ['surveys', 'messages'],
    values: { surveys: false, messages: false },
  });
});
