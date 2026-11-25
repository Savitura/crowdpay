const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { fetchGithubRepoStats, parseGithubUrl } = require('./githubService');

function jsonResponse(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok,
    status,
    statusText,
    json: async () => body,
  };
}

describe('githubService', { concurrency: 1 }, () => {
  test('parseGithubUrl extracts owner and repo and rejects other hosts', () => {
    assert.deepEqual(parseGithubUrl('https://github.com/Savitura/crowdpay'), {
      owner: 'Savitura',
      repo: 'crowdpay',
    });
    assert.deepEqual(parseGithubUrl('https://github.com/Savitura/crowdpay/pull/12'), {
      owner: 'Savitura',
      repo: 'crowdpay',
    });
    assert.equal(parseGithubUrl('https://example.com/Savitura/crowdpay'), null);
    assert.equal(parseGithubUrl('https://github.com/Savitura'), null);
    assert.equal(parseGithubUrl('not a url'), null);
  });

  test('fetchGithubRepoStats returns repo stats and the top contributors', async () => {
    const original = global.fetch;
    const urls = [];
    global.fetch = async url => {
      urls.push(url);
      if (String(url).includes('/contributors')) {
        return jsonResponse([
          {
            login: 'ada',
            avatar_url: 'https://img/ada',
            html_url: 'https://github.com/ada',
            extra: 1,
          },
        ]);
      }
      return jsonResponse({
        stargazers_count: 12,
        forks_count: 3,
        open_issues_count: 4,
        pushed_at: '2026-06-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
        license: { spdx_id: 'MIT' },
      });
    };
    try {
      const stats = await fetchGithubRepoStats('https://github.com/Savitura/crowdpay');
      assert.equal(stats.stars, 12);
      assert.equal(stats.forks, 3);
      assert.equal(stats.open_issues, 4);
      assert.equal(stats.last_commit_date, '2026-06-01T00:00:00Z');
      assert.equal(stats.license, 'MIT');
      assert.deepEqual(stats.top_contributors, [
        { login: 'ada', avatar_url: 'https://img/ada', html_url: 'https://github.com/ada' },
      ]);
      assert.match(urls[0], /\/repos\/Savitura\/crowdpay$/);
      assert.match(urls[1], /contributors\?per_page=5/);
    } finally {
      global.fetch = original;
    }
  });

  test('falls back to updated_at and an empty license when those fields are missing', async () => {
    const original = global.fetch;
    global.fetch = async url => {
      if (String(url).includes('/contributors')) return jsonResponse({ message: 'not a list' });
      return jsonResponse({
        stargazers_count: 1,
        forks_count: 0,
        open_issues_count: 0,
        pushed_at: null,
        updated_at: '2026-04-01T00:00:00Z',
        license: null,
      });
    };
    try {
      const stats = await fetchGithubRepoStats('https://github.com/Savitura/crowdpay');
      assert.equal(stats.last_commit_date, '2026-04-01T00:00:00Z');
      assert.equal(stats.license, null);
      assert.deepEqual(stats.top_contributors, []);
    } finally {
      global.fetch = original;
    }
  });

  test('returns null for a missing repository', async () => {
    const original = global.fetch;
    global.fetch = async () =>
      jsonResponse({}, { ok: false, status: 404, statusText: 'Not Found' });
    try {
      assert.equal(await fetchGithubRepoStats('https://github.com/Savitura/missing'), null);
    } finally {
      global.fetch = original;
    }
  });

  test('returns null when GitHub rate limits the repository request', async () => {
    const original = global.fetch;
    global.fetch = async () =>
      jsonResponse({}, { ok: false, status: 429, statusText: 'Too Many Requests' });
    try {
      assert.equal(await fetchGithubRepoStats('https://github.com/Savitura/crowdpay'), null);
    } finally {
      global.fetch = original;
    }
  });

  test('returns null when the request times out', async () => {
    const original = global.fetch;
    global.fetch = async () => {
      throw new Error('The operation was aborted due to timeout');
    };
    try {
      assert.equal(await fetchGithubRepoStats('https://github.com/Savitura/crowdpay'), null);
    } finally {
      global.fetch = original;
    }
  });

  test('keeps repository stats when the contributor request is rate limited', async () => {
    const original = global.fetch;
    global.fetch = async url => {
      if (String(url).includes('/contributors')) {
        return jsonResponse({}, { ok: false, status: 403, statusText: 'rate limit exceeded' });
      }
      return jsonResponse({
        stargazers_count: 9,
        forks_count: 1,
        open_issues_count: 2,
        pushed_at: '2026-06-02T00:00:00Z',
        license: { spdx_id: 'Apache-2.0' },
      });
    };
    try {
      const stats = await fetchGithubRepoStats('https://github.com/Savitura/crowdpay');
      assert.equal(stats.stars, 9);
      assert.equal(stats.license, 'Apache-2.0');
      assert.deepEqual(stats.top_contributors, []);
    } finally {
      global.fetch = original;
    }
  });

  test('returns null for a URL that is not a GitHub repository', async () => {
    const original = global.fetch;
    let called = false;
    global.fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    try {
      assert.equal(await fetchGithubRepoStats('https://example.com/not/github'), null);
      assert.equal(called, false);
    } finally {
      global.fetch = original;
    }
  });
});
