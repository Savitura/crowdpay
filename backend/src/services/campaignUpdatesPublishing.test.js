const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const MUTED = '33333333-3333-4333-8333-333333333333';
const KEPT = '44444444-4444-4444-8444-444444444444';

const UPDATE = {
  id: 'update-1',
  title: 'Progress report',
  body: 'We hit 50% today and shipped the first prototype.',
};

const CONTRIBUTORS = [
  { id: MUTED, email: 'muted@example.com', name: 'Muted' },
  { id: KEPT, email: 'kept@example.com', name: 'Kept' },
];

/**
 * @param enabledIds the ids `filterEnabledUsers` should keep; `null` makes it throw.
 */
function buildService({ enabledIds = CONTRIBUTORS.map(c => c.id), filterThrows = false } = {}) {
  const notifications = [];
  const emails = [];
  const followerCalls = [];
  const logged = [];

  const service = proxyquire('./campaignUpdatesPublishing', {
    '../config/database': {
      query: async sql => {
        if (String(sql).includes('FROM contributions c')) {
          return { rows: CONTRIBUTORS };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    },
    '../config/logger': {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: (...args) => logged.push(args),
    },
    './emailService': {
      sendCampaignUpdatePostedEmail: async payload => {
        emails.push(payload);
      },
    },
    './notifications': {
      createNotification: async (userId, message) => {
        notifications.push({ userId, type: message.type });
      },
    },
    './campaignFollowService': {
      notifyFollowers: async (campaignId, preference, message, exclude) => {
        followerCalls.push({ campaignId, preference, exclude });
        return 0;
      },
    },
    './communicationPreferenceService': {
      filterEnabledUsers: async (_campaignId, channel, userIds) => {
        logged.push(['filter', channel, userIds]);
        if (filterThrows) throw new Error('preference table unreachable');
        return userIds.filter(id => enabledIds.includes(id));
      },
    },
  });
  return { service, notifications, emails, followerCalls, logged };
}

test('contributors who muted the updates channel get no notification and no email', async () => {
  const { service, notifications, emails, followerCalls, logged } = buildService({
    enabledIds: [KEPT],
  });

  await service.sendCampaignUpdateNotifications({
    campaignId: CAMPAIGN_ID,
    campaignTitle: 'Water',
    update: UPDATE,
    authorId: 'creator-1',
  });

  assert.deepEqual(logged[0], ['filter', 'updates', [MUTED, KEPT]]);
  assert.deepEqual(notifications, [{ userId: KEPT, type: 'campaign_update' }]);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'kept@example.com');
  // The follower fan-out excludes the same people the contributor path
  // already contacted, so nobody is pinged twice.
  assert.deepEqual(followerCalls[0].exclude, ['creator-1', KEPT]);
});

test('a follower fan-out failure does not stop contributor email delivery', async () => {
  const { service, emails } = buildService();
  const failing = proxyquire('./campaignUpdatesPublishing', {
    '../config/database': {
      query: async sql =>
        String(sql).includes('FROM contributions c') ? { rows: CONTRIBUTORS } : { rows: [] },
    },
    '../config/logger': { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    './emailService': { sendCampaignUpdatePostedEmail: async payload => emails.push(payload) },
    './notifications': { createNotification: async () => {} },
    './campaignFollowService': {
      notifyFollowers: async () => {
        throw new Error('follower fan-out down');
      },
    },
    './communicationPreferenceService': {
      filterEnabledUsers: async (_c, _ch, userIds) => userIds,
    },
  });

  await failing.sendCampaignUpdateNotifications({
    campaignId: CAMPAIGN_ID,
    campaignTitle: 'Water',
    update: UPDATE,
    authorId: 'creator-1',
  });

  assert.equal(emails.length, 2);
});

test('a preference lookup failure fails open so nobody silently misses an update', async () => {
  const { service, notifications, emails, logged } = buildService({ filterThrows: true });

  await service.sendCampaignUpdateNotifications({
    campaignId: CAMPAIGN_ID,
    campaignTitle: 'Water',
    update: UPDATE,
    authorId: 'creator-1',
  });

  assert.equal(notifications.length, 2, 'every contributor is still notified');
  assert.equal(emails.length, 2);
  assert.ok(
    logged.some(
      args => Array.isArray(args) && args[0] === 'Failed to apply per-campaign update preferences'
    ),
    'the failure is logged'
  );
});

test('a database failure is contained and never escapes the publish path', async () => {
  const service = proxyquire('./campaignUpdatesPublishing', {
    '../config/database': {
      query: async () => {
        throw new Error('connection reset');
      },
    },
    '../config/logger': { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    './emailService': { sendCampaignUpdatePostedEmail: async () => {} },
    './notifications': { createNotification: async () => {} },
    './campaignFollowService': { notifyFollowers: async () => 0 },
    './communicationPreferenceService': { filterEnabledUsers: async () => [] },
  });

  await service.sendCampaignUpdateNotifications({
    campaignId: CAMPAIGN_ID,
    campaignTitle: 'Water',
    update: UPDATE,
    authorId: 'creator-1',
  });
});

test('publishDueCampaignUpdates still returns published rows', async () => {
  const { service } = buildService();
  const publishing = proxyquire('./campaignUpdatesPublishing', {
    '../config/database': {
      query: async sql => {
        if (String(sql).includes("status = 'scheduled' AND cu.scheduled_for <= NOW()")) {
          return {
            rows: [
              {
                id: 'update-1',
                campaign_id: CAMPAIGN_ID,
                author_id: 'creator-1',
                title: 'Progress',
                body: 'Body',
                campaign_title: 'Water',
              },
            ],
          };
        }
        if (String(sql).includes("SET status = 'published'")) {
          return {
            rows: [{ id: 'update-1', status: 'published', body: 'Body', title: 'Progress' }],
          };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    './emailService': { sendCampaignUpdatePostedEmail: async () => {} },
    './notifications': { createNotification: async () => {} },
    './campaignFollowService': { notifyFollowers: async () => 0 },
    './communicationPreferenceService': { filterEnabledUsers: async () => [] },
  });

  const published = await publishing.publishDueCampaignUpdates();
  assert.equal(published.length, 1);
  assert.equal(published[0].id, 'update-1');
});
