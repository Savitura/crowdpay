const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl }) {
  const router = proxyquire('./nftRewards', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/nft-rewards', router);
  return app;
}

test('POST /api/nft-rewards/claim prevents duplicates and retries failed mints', async () => {
  let nftRows = [];

  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id, campaign_id FROM contributions')) {
        return { rows: [{ id: params[0], campaign_id: 'camp-1' }] };
      }
      if (text.includes('SELECT id, status, token_id, tx_hash, serial_number FROM nft_rewards')) {
        return { rows: nftRows };
      }
      if (text.includes('INSERT INTO nft_rewards')) {
        const newRow = {
          id: 'nft-1',
          campaign_id: params[0],
          reward_tier_id: params[1],
          contribution_id: params[2],
          status: 'minting',
        };
        nftRows.push(newRow);
        return { rows: [newRow] };
      }
      if (text.includes('UPDATE nft_rewards')) {
        const row = nftRows.find(r => r.reward_tier_id === params[3] && r.contribution_id === params[4]);
        if (row) {
          row.status = params[0] ? 'minted' : 'failed';
          row.token_id = params[0];
          row.tx_hash = params[1];
          row.serial_number = params[2];
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const payload = {
    campaign_id: '11111111-1111-1111-1111-111111111111',
    reward_tier_id: '22222222-2222-2222-2222-222222222222',
    contribution_id: '33333333-3333-3333-3333-333333333333',
  };

  const res1 = await request(app)
    .post('/api/nft-rewards/claim')
    .send(payload);

  assert.equal(res1.status, 201);
  assert.equal(res1.body.status, 'minted');

  const res2 = await request(app)
    .post('/api/nft-rewards/claim')
    .send(payload);

  assert.equal(res2.status, 400);
  assert.match(res2.body.error, /already claimed/);
});
