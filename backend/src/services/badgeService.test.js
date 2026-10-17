const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService({ queryImpl, onNotification = () => {} }) {
  return proxyquire('./badgeService', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './notifications': {
      createNotification: async (userId, message) => onNotification(userId, message),
    },
  });
}

const NO_BADGES = {
  campaigns_backed: 0,
  contribution_count: 0,
  total_contributed: 0,
  largest_contribution: 0,
  early_backings: 0,
  campaigns_completed: 0,
  campaigns_with_released_milestone: 0,
};

function statsQuery(overrides = {}) {
  const stats = { ...NO_BADGES, ...overrides };
  return async text => {
    if (text.includes('my_contributions')) {
      return {
        rows: [
          {
            campaigns_backed: stats.campaigns_backed,
            contribution_count: stats.contribution_count,
            total_contributed: String(stats.total_contributed),
            largest_contribution: String(stats.largest_contribution),
            early_backings: stats.early_backings,
          },
        ],
      };
    }
    if (text.includes('campaigns_with_released_milestone')) {
      return {
        rows: [
          {
            campaigns_completed: stats.campaigns_completed,
            campaigns_with_released_milestone: stats.campaigns_with_released_milestone,
          },
        ],
      };
    }
    if (text.includes('FROM contributor_badges')) return { rows: [] };
    if (text.includes('INSERT INTO contributor_badges')) {
      return { rows: [{ earned_at: '2026-07-28T00:00:00.000Z' }] };
    }
    return { rows: [] };
  };
}

function earnedIds(badges) {
  return badges.filter(badge => badge.earned).map(badge => badge.id);
}

test('computeBadges awards nothing to a contributor with no history', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });

  assert.deepEqual(earnedIds(service.computeBadges(NO_BADGES)), []);
});

test('computeBadges covers the new achievement types', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });

  assert.deepEqual(earnedIds(service.computeBadges({ ...NO_BADGES, early_backings: 1 })), [
    'early_backer',
  ]);
  assert.deepEqual(earnedIds(service.computeBadges({ ...NO_BADGES, largest_contribution: 500 })), [
    'high_value_backer',
  ]);
  assert.deepEqual(
    earnedIds(service.computeBadges({ ...NO_BADGES, campaigns_with_released_milestone: 2 })),
    ['milestone_witness']
  );
});

test('computeBadges keeps the original contribution-count badges', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });

  const badges = service.computeBadges({
    ...NO_BADGES,
    campaigns_backed: 10,
    total_contributed: 1000,
    campaigns_completed: 1,
  });

  assert.deepEqual(earnedIds(badges), [
    'first_contribution',
    'backed_5_campaigns',
    'backed_10_campaigns',
    'contributed_1000',
    'backed_completed_campaign',
  ]);
});

test('getContributorBadgeStats returns numeric totals', async () => {
  const service = buildService({
    queryImpl: statsQuery({
      campaigns_backed: 3,
      contribution_count: 4,
      total_contributed: 1250.5,
      largest_contribution: 600,
      early_backings: 2,
      campaigns_completed: 1,
      campaigns_with_released_milestone: 1,
    }),
  });

  const stats = await service.getContributorBadgeStats('user-1');

  assert.equal(stats.total_contributed, 1250.5);
  assert.equal(stats.largest_contribution, 600);
  assert.equal(stats.early_backings, 2);
  assert.equal(stats.campaigns_with_released_milestone, 1);
});

test('evaluateBadges records and announces each newly earned badge once', async () => {
  const notifications = [];
  const inserted = [];
  const stats = statsQuery({ campaigns_backed: 1, largest_contribution: 500 });
  let alreadyEarned = [];

  const service = buildService({
    queryImpl: async (text, params) => {
      if (text.includes('FROM contributor_badges')) {
        return { rows: alreadyEarned.map(id => ({ badge_id: id, earned_at: 'earlier' })) };
      }
      if (text.includes('INSERT INTO contributor_badges')) {
        inserted.push(params[1]);
        return { rows: [{ earned_at: '2026-07-28T00:00:00.000Z' }] };
      }
      return stats(text, params);
    },
    onNotification: (userId, message) => notifications.push(message.title),
  });

  const badges = await service.evaluateBadges('user-1');

  assert.deepEqual(earnedIds(badges), ['first_contribution', 'high_value_backer']);
  assert.deepEqual(inserted, ['first_contribution', 'high_value_backer']);
  assert.deepEqual(notifications, [
    'Badge earned: First contribution',
    'Badge earned: High-value backer',
  ]);

  // A second pass over the same history announces nothing new.
  alreadyEarned = ['first_contribution', 'high_value_backer'];
  inserted.length = 0;
  notifications.length = 0;
  await service.evaluateBadges('user-1');

  assert.deepEqual(inserted, []);
  assert.deepEqual(notifications, []);
});

test('syncBadgesForContributor swallows database failures', async () => {
  const service = buildService({
    queryImpl: async () => {
      throw new Error('database is down');
    },
  });

  assert.deepEqual(await service.syncBadgesForContributor('user-1'), []);
});

test('getLeaderboard ranks contributors and caps the page size', async () => {
  let limitParam = null;
  const service = buildService({
    queryImpl: async (text, params) => {
      limitParam = params[0];
      return {
        rows: [
          {
            id: 'user-1',
            name: 'Ada',
            total_contributed: '900',
            campaigns_backed: 4,
            badge_count: 3,
          },
          {
            id: 'user-2',
            name: 'Grace',
            total_contributed: '400',
            campaigns_backed: 2,
            badge_count: 1,
          },
        ],
      };
    },
  });

  const leaderboard = await service.getLeaderboard({ limit: 500 });

  assert.equal(limitParam, 100);
  assert.deepEqual(leaderboard[0], {
    rank: 1,
    user_id: 'user-1',
    name: 'Ada',
    total_contributed: 900,
    campaigns_backed: 4,
    badge_count: 3,
  });
  assert.equal(leaderboard[1].rank, 2);
});

test('getLeaderboard defaults to 20 entries', async () => {
  let limitParam = null;
  const service = buildService({
    queryImpl: async (_text, params) => {
      limitParam = params[0];
      return { rows: [] };
    },
  });

  await service.getLeaderboard();

  assert.equal(limitParam, 20);
});
