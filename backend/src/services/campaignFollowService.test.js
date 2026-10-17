const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';

function buildService({ queryImpl, onBulkNotification = () => {} }) {
  return proxyquire('./campaignFollowService', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './notifications': {
      createNotificationsBulk: async (userIds, message) => onBulkNotification(userIds, message),
    },
  });
}

test('notifyFollowers skips users already notified through another path', async () => {
  const calls = [];
  const notified = [];
  const service = buildService({
    queryImpl: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ user_id: 'follower-1' }, { user_id: 'follower-2' }] };
    },
    onBulkNotification: userIds => notified.push(...userIds),
  });

  const count = await service.notifyFollowers(
    CAMPAIGN_ID,
    'notify_updates',
    { type: 'campaign_update', title: 'Update' },
    ['creator-1', 'contributor-1']
  );

  assert.equal(count, 2);
  assert.deepEqual(notified, ['follower-1', 'follower-2']);
  assert.deepEqual(calls[0].params, [CAMPAIGN_ID, ['creator-1', 'contributor-1']]);
  assert.match(calls[0].text, /notify_updates = TRUE/);
});

test('notifyFollowers rejects a preference column that does not exist', async () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });

  await assert.rejects(
    () => service.notifyFollowers(CAMPAIGN_ID, 'notify_everything', { type: 't', title: 'T' }),
    /Unknown follower notification preference/
  );
});

test('notifyFollowers excludes followers who muted the matching per-campaign channel (#961)', async () => {
  const calls = [];
  const notified = [];
  const service = buildService({
    queryImpl: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ user_id: 'follower-1' }] };
    },
    onBulkNotification: userIds => notified.push(...userIds),
  });

  await service.notifyFollowers(CAMPAIGN_ID, 'notify_milestones', {
    type: 'milestone_released',
    title: 'Released',
  });

  const sql = calls[0].text;
  assert.match(sql, /NOT EXISTS \(/);
  assert.match(sql, /FROM campaign_communication_preferences p/);
  assert.match(sql, /p\.campaign_id = f\.campaign_id/);
  assert.match(sql, /p\.user_id = f\.user_id/);
  assert.match(sql, /p\.milestones = FALSE/);
  assert.deepEqual(notified, ['follower-1']);
});

test('CHANNEL_FOR_PREFERENCE maps every follower preference onto a real channel', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  assert.deepEqual(service.CHANNEL_FOR_PREFERENCE, {
    notify_updates: 'updates',
    notify_milestones: 'milestones',
    notify_funding: 'funding_updates',
  });
  for (const channel of Object.values(service.CHANNEL_FOR_PREFERENCE)) {
    assert.match(
      channel,
      /^[a-z_]+$/,
      `${channel} must be a bare column name for SQL interpolation`
    );
  }
});

test('notifyFollowers passes all follower IDs to bulk notification', async () => {
  const notified = [];
  const service = buildService({
    queryImpl: async () => ({ rows: [{ user_id: 'follower-1' }, { user_id: 'follower-2' }] }),
    onBulkNotification: userIds => notified.push(...userIds),
  });

  const count = await service.notifyFollowers(CAMPAIGN_ID, 'notify_funding', {
    type: 'campaign_funding_milestone',
    title: '50%',
  });

  assert.equal(count, 2);
  assert.deepEqual(notified, ['follower-1', 'follower-2']);
});

test('highestThresholdReached picks the largest threshold crossed', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });

  assert.equal(service.highestThresholdReached(10, 100), null);
  assert.equal(service.highestThresholdReached(25, 100), 25);
  assert.equal(service.highestThresholdReached(74, 100), 50);
  assert.equal(service.highestThresholdReached(120, 100), 100);
  assert.equal(service.highestThresholdReached(50, 0), null);
});

test('announceFundingProgress notifies followers once per threshold', async () => {
  const notified = [];
  let thresholdClaimed = false;
  const service = buildService({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ title: 'Solar grid', raised_amount: '600', target_amount: '1000' }] };
      }
      if (text.includes('INSERT INTO campaign_funding_milestones')) {
        const rowCount = thresholdClaimed ? 0 : 1;
        thresholdClaimed = true;
        return { rows: [], rowCount };
      }
      return { rows: [{ user_id: 'follower-1' }] };
    },
    onBulkNotification: (userIds, message) => notified.push(message.title),
  });

  assert.equal(await service.announceFundingProgress(CAMPAIGN_ID), 50);
  assert.equal(await service.announceFundingProgress(CAMPAIGN_ID), null);
  assert.deepEqual(notified, ['Solar grid reached 50% funded']);
});

test('announceFundingProgress stays quiet below the first threshold', async () => {
  const service = buildService({
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ title: 'Solar grid', raised_amount: '10', target_amount: '1000' }] };
      }
      throw new Error('should not reach the threshold table');
    },
  });

  assert.equal(await service.announceFundingProgress(CAMPAIGN_ID), null);
});
