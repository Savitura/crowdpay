process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123456789012345678901234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const USER_ID = 'creator-uuid-1';

function buildApp({ queryImpl = async () => ({ rows: [] }), user = { userId: USER_ID, role: 'creator' } } = {}) {
  const calls = [];

  const service = proxyquire('../services/bulkCampaignService', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        return queryImpl(text, params);
      },
      connect: async () => ({
        query: async (text, params) => {
          calls.push({ text, params });
          return queryImpl(text, params);
        },
        release: () => {},
      }),
    },
    './stellarService': {
      getSupportedAssetCodes: () => ['USDC', 'XLM'],
    },
  });

  const router = proxyquire('./bulkCampaigns', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        return queryImpl(text, params);
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = user;
        next();
      },
      requireRole: () => (req, _res, next) => next(),
    },
    '../services/bulkCampaignService': service,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);

  return { app, service, calls };
}

test('GET /api/campaigns/bulk/template returns CSV template with content-disposition header', async () => {
  const { app } = buildApp();
  const res = await request(app).get('/api/campaigns/bulk/template');

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'], /campaigns_bulk_template\.csv/);
  assert.match(res.text, /title,description,target_amount/);
});

test('POST /api/campaigns/bulk/validate validates fully valid CSV', async () => {
  const { app } = buildApp();
  const csv = `title,description,target_amount,asset_type,deadline,category,cover_image_url
"Valid Campaign 1","Desc 1",1000,USDC,2028-01-01T00:00:00Z,community,"https://example.com/img.png"
"Valid Campaign 2","Desc 2",2500,XLM,,tech,`;

  const res = await request(app)
    .post('/api/campaigns/bulk/validate')
    .send({ csv });

  assert.equal(res.status, 200);
  assert.equal(res.body.valid, true);
  assert.equal(res.body.total_rows, 2);
  assert.equal(res.body.valid_rows, 2);
  assert.equal(res.body.invalid_rows, 0);
  assert.equal(res.body.errors.length, 0);
});

test('POST /api/campaigns/bulk/validate reports per-row validation errors for invalid rows', async () => {
  const { app } = buildApp();
  const csv = `title,description,target_amount,asset_type,deadline,category,cover_image_url,milestones
"","Missing title",1000,USDC,,,,""
"Invalid Asset","Desc",-50,INVALID_COIN,,,,""
"Bad Milestone","Desc",500,USDC,,,,"[{""title"":""P1"",""release_percentage"":50}]"`;

  const res = await request(app)
    .post('/api/campaigns/bulk/validate')
    .send({ csv });

  assert.equal(res.status, 200);
  assert.equal(res.body.valid, false);
  assert.equal(res.body.total_rows, 3);
  assert.equal(res.body.invalid_rows, 3);
  assert.ok(res.body.errors.some((e) => e.row === 1 && e.field === 'title'));
  assert.ok(res.body.errors.some((e) => e.row === 2 && e.field === 'target_amount'));
  assert.ok(res.body.errors.some((e) => e.row === 2 && e.field === 'asset_type'));
  assert.ok(res.body.errors.some((e) => e.row === 3 && e.field === 'milestones'));
});

test('POST /api/campaigns/bulk/import creates import job and is idempotent with idempotency key or content hash', async () => {
  const csv = `title,description,target_amount,asset_type
"Campaign One","First desc",1000,USDC`;

  let existingJob = null;
  const { app } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT * FROM bulk_campaign_imports WHERE idempotency_key = $1')) {
        if (existingJob) return { rows: [existingJob] };
        return { rows: [] };
      }
      if (text.includes('SELECT * FROM bulk_campaign_imports WHERE content_hash = $1')) {
        if (existingJob) return { rows: [existingJob] };
        return { rows: [] };
      }
      if (text.includes('INSERT INTO bulk_campaign_imports')) {
        existingJob = {
          id: 'job-999',
          user_id: USER_ID,
          idempotency_key: params[1],
          content_hash: params[2],
          total_rows: params[3],
          processed_rows: 0,
          status: 'processing',
          created_at: new Date().toISOString(),
        };
        return { rows: [existingJob] };
      }
      return { rows: [] };
    },
  });

  // First upload
  const res1 = await request(app)
    .post('/api/campaigns/bulk/import')
    .set('idempotency-key', 'bulk-key-1')
    .send({ csv });

  assert.equal(res1.status, 202);
  assert.equal(res1.body.job_id, 'job-999');
  assert.equal(res1.body.status, 'processing');

  // Second duplicate upload with same idempotency key
  const res2 = await request(app)
    .post('/api/campaigns/bulk/import')
    .set('idempotency-key', 'bulk-key-1')
    .send({ csv });

  assert.equal(res2.status, 202);
  assert.equal(res2.body.job_id, 'job-999');
});

test('bulkCampaignService.executeImportJob executes atomically per row', async () => {
  const rows = [
    { title: 'Valid 1', target_amount: '1000', asset_type: 'USDC' },
    { title: '', target_amount: '2000', asset_type: 'USDC' }, // Invalid row
    { title: 'Valid 2', target_amount: '3000', asset_type: 'USDC' },
  ];

  let completedJob = null;
  const { service } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('INSERT INTO campaigns')) {
        return {
          rows: [{
            id: 'camp-' + Math.random().toString(36).slice(2, 7),
            title: params[1],
            target_amount: params[3],
            asset_type: params[4],
            status: 'draft',
            created_at: new Date().toISOString(),
          }],
        };
      }
      if (text.includes('UPDATE bulk_campaign_imports')) {
        completedJob = {
          processed_rows: params[0],
          successful_rows: params[1],
          failed_rows: params[2],
          results: JSON.parse(params[3]),
        };
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  await service.executeImportJob('job-123', USER_ID, rows);

  assert.ok(completedJob);
  assert.equal(completedJob.processed_rows, 3);
  assert.equal(completedJob.successful_rows, 2);
  assert.equal(completedJob.failed_rows, 1);
  assert.equal(completedJob.results.length, 3);
  assert.equal(completedJob.results[0].success, true);
  assert.equal(completedJob.results[1].success, false);
  assert.equal(completedJob.results[2].success, true);
});
