const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('listCreatorCampaigns queries by creator_id', async () => {
  let sql = '';
  let params = null;
  const { listCreatorCampaigns } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async (text, p) => {
        sql = text;
        params = p;
        return { rows: [{ id: 'camp-1', title: 'Mine', status: 'active' }] };
      },
    },
  });

  const rows = await listCreatorCampaigns('user-1');
  assert.match(sql, /creator_id = \$1/);
  assert.deepEqual(params, ['user-1']);
  assert.equal(rows[0].title, 'Mine');
});

test('listUserContributions includes conversion_rate', async () => {
  let contributionSql = '';
  const { listUserContributions } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async (text) => {
        if (text.includes('wallet_public_key FROM users')) {
          return { rows: [{ wallet_public_key: 'GUSER' }] };
        }
        contributionSql = text;
        return {
          rows: [
            {
              id: 'ctr-1',
              amount: '10',
              asset: 'USDC',
              conversion_rate: '0.25',
              campaign_title: 'Test',
            },
          ],
        };
      },
    },
  });

  const rows = await listUserContributions('user-1');
  assert.match(contributionSql, /conversion_rate/);
  assert.equal(rows[0].conversion_rate, '0.25');
});

test('listUserContributions returns null when user missing', async () => {
  const { listUserContributions } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async () => ({ rows: [] }),
    },
  });

  const rows = await listUserContributions('missing');
  assert.equal(rows, null);
});
