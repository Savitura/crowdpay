const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp(queryImpl) {
  const router = proxyquire('./embed', {
    '../config/database': { query: queryImpl },
    '../utils/asyncHandler': (fn) => (req, res, next) => fn(req, res, next).catch(next),
    '../middleware/rateLimiter': {
      embedStatsLimiter: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/embed', router);
  return app;
}

test('GET /api/embed/:campaignId/stats returns safe public campaign stats', async () => {
  const queryImpl = async (sql, params) => {
    if (sql.includes('FROM campaigns')) {
      return {
        rows: [{
          id: 'c-1',
          title: 'Clean Water Initiative',
          description: 'Build wells',
          target_amount: '10000',
          raised_amount: '5000',
          asset_type: 'USDC',
          status: 'active',
          deadline: new Date(Date.now() + 86400000 * 5).toISOString(),
          backer_count: 15,
          contribution_url: 'https://crowdpay.com/campaigns/c-1',
        }],
      };
    }
    if (sql.includes('FROM contributions')) {
      return {
        rows: [{ id: 'b-1', amount: '100', created_at: new Date().toISOString(), contributor_name: 'Alice' }],
      };
    }
    if (sql.includes('FROM milestones')) {
      return {
        rows: [{ id: 'm-1', title: 'Phase 1', release_percentage: '100', status: 'pending', sort_order: 0 }],
      };
    }
    return { rows: [] };
  };

  const app = buildApp(queryImpl);
  const res = await request(app).get('/api/embed/c-1/stats');

  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Clean Water Initiative');
  assert.equal(res.body.raised_amount, '5000');
  assert.equal(res.body.target_amount, '10000');
  assert.equal(res.body.progress_percentage, 50);
  assert.equal(res.body.backer_count, 15);
  assert.equal(res.body.recent_backers.length, 1);
  assert.equal(res.body.recent_backers[0].name, 'Alice');
});

test('GET /api/embed/:campaignId/stats returns 404 if campaign missing', async () => {
  const queryImpl = async () => ({ rows: [] });
  const app = buildApp(queryImpl);
  const res = await request(app).get('/api/embed/missing-id/stats');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Campaign not found' });
});