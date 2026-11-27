const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function loadCron({ campaigns, statsFor, updateError, queryError } = {}) {
  const updates = [];
  const fetches = [];
  const errors = [];

  const service = proxyquire('./githubStatsCron', {
    '../config/database': {
      query: async (text, params) => {
        if (queryError) throw queryError;
        if (text.includes('UPDATE campaigns')) {
          if (updateError && params[1] === updateError) throw new Error('update failed');
          updates.push({ stats: JSON.parse(params[0]), id: params[1] });
          return { rows: [] };
        }
        return { rows: campaigns || [] };
      },
    },
    '../config/logger': {
      info: () => {},
      error: (message, meta) => errors.push({ message, meta }),
      warn: () => {},
    },
    './githubService': {
      fetchGithubRepoStats: async url => {
        fetches.push(url);
        return statsFor ? statsFor(url) : null;
      },
    },
  });

  return { service, updates, fetches, errors };
}

test('refreshGithubStats stores stats and skips repositories that return no stats', async () => {
  const { service, updates, fetches } = loadCron({
    campaigns: [
      { id: 'camp-1', github_repo_url: 'https://github.com/Savitura/crowdpay' },
      { id: 'camp-2', github_repo_url: 'https://github.com/Savitura/missing' },
    ],
    statsFor: url =>
      url.includes('missing') ? null : { stars: 4, forks: 1, top_contributors: [] },
  });

  await service.refreshGithubStats();

  assert.deepEqual(fetches, [
    'https://github.com/Savitura/crowdpay',
    'https://github.com/Savitura/missing',
  ]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'camp-1');
  assert.equal(updates[0].stats.stars, 4);
});

test('refreshGithubStats finishes when there are no campaigns', async () => {
  const { service, updates } = loadCron({ campaigns: [] });
  await service.refreshGithubStats();
  assert.equal(updates.length, 0);
});

test('refreshGithubStats logs and swallows a database failure', async () => {
  const { service, errors } = loadCron({ queryError: new Error('db down') });
  await service.refreshGithubStats();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.error, 'db down');
});

test('refreshGithubStats stops updating after a write failure and does not throw', async () => {
  const { service, updates, errors } = loadCron({
    campaigns: [
      { id: 'camp-1', github_repo_url: 'https://github.com/a/one' },
      { id: 'camp-2', github_repo_url: 'https://github.com/a/two' },
    ],
    statsFor: () => ({ stars: 1 }),
    updateError: 'camp-1',
  });

  await service.refreshGithubStats();
  assert.equal(updates.length, 0);
  assert.equal(errors[0].meta.error, 'update failed');
});
