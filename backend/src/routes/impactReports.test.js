const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const express = require('express');
const request = require('supertest');

const CAMPAIGN_UUID = '11111111-1111-4111-8111-111111111111';

const mockLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

function buildService(db) {
  return proxyquire('../services/impactReportService', {
    '../config/database': db,
    '../config/logger': mockLogger,
    './notifications': { createNotification: async () => {} },
  });
}

function buildApp(db) {
  const router = proxyquire('../routes/impactReports', {
    '../config/database': db,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'test-user-id', role: 'creator' };
        next();
      },
    },
    '../config/logger': mockLogger,
    '../services/impactReportService': buildService(db),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

function queryLog(db) {
  return db._queries || [];
}

// Shared mock db factory. `handlers` is a list of [predicate, result] checked in order.
function makeDb(handlers) {
  const queries = [];
  const db = {
    _queries: queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      for (const [predicate, result] of handlers) {
        const matched = typeof predicate === 'function' ? predicate(sql) : predicate.test(sql);
        if (matched) return typeof result === 'function' ? result(sql, params) : result;
      }
      return { rows: [] };
    },
  };
  return db;
}

const defaultHandlers = [
  [
    /FROM campaigns/,
    {
      rows: [
        {
          id: CAMPAIGN_UUID,
          creator_id: 'test-user-id',
          status: 'completed',
          title: 'Test Campaign',
        },
      ],
    },
  ],
  [/campaign_members/, { rows: [] }],
  [/INSERT INTO campaign_impact_reports/, { rows: [{ id: 'report-id' }] }],
  [/INSERT INTO creator_impact_badges/, { rows: [] }],
  [/UPDATE campaign_impact_reports/, { rows: [] }],
  [/FROM contributions/, { rows: [] }],
  [/FROM users/, { rows: [] }],
];

test('createImpactReport validates creator + campaign status', async () => {
  const db = makeDb([
    [/SELECT id FROM campaign_impact_reports WHERE campaign_id/, { rows: [] }],
    ...defaultHandlers,
  ]);

  const app = buildApp(db);

  const response = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_UUID}/impact-report`)
    .send({
      title: 'My Impact Report',
      content: '# Report\n\nThis is the content',
      summary: 'This is a summary',
    });

  assert.equal(response.status, 201);
  assert.ok(response.body.id);
});

test('createImpactReport enforces one report per campaign', async () => {
  const db = makeDb([
    [/SELECT id FROM campaign_impact_reports WHERE campaign_id/, { rows: [{ id: 'existing' }] }],
    ...defaultHandlers,
  ]);

  const app = buildApp(db);

  const response = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_UUID}/impact-report`)
    .send({ title: 'My Impact Report', content: 'Content' });

  assert.equal(response.status, 409);
});

test('publishImpactReport awards badge to creator', async () => {
  const draftRow = {
    id: 'report-id',
    campaign_id: CAMPAIGN_UUID,
    creator_id: 'test-user-id',
    title: 'Test Report',
    summary: 'Summary',
    status: 'draft',
  };
  const db = makeDb([
    [/status = 'draft'/, { rows: [draftRow] }],
    [
      /SELECT id, campaign_id, creator_id, title, summary, status FROM campaign_impact_reports/,
      { rows: [draftRow] },
    ],
    ...defaultHandlers,
  ]);

  const app = buildApp(db);

  const response = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_UUID}/impact-report/publish`)
    .send({});

  assert.equal(response.status, 200);
  assert.ok(queryLog(db).some(q => q.sql.includes('creator_impact_badges')));
});

test('getImpactReport returns null for draft', async () => {
  const db = makeDb([...defaultHandlers]);

  const app = buildApp(db);

  const response = await request(app).get(`/api/campaigns/${CAMPAIGN_UUID}/impact-report`);

  assert.equal(response.status, 404);
  assert.ok(response.body.error);
});

test('getImpactReport returns report after publish', async () => {
  const publishedRow = {
    id: 'report-id',
    campaign_id: CAMPAIGN_UUID,
    creator_id: 'test-user-id',
    title: 'Test Report',
    content: 'Test content',
    summary: 'Test summary',
    status: 'published',
    published_at: new Date().toISOString(),
    images: [],
    videos: [],
    milestones: [],
    views_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const db = makeDb([[/status = 'published'/, { rows: [publishedRow] }], ...defaultHandlers]);

  const app = buildApp(db);

  const response = await request(app).get(`/api/campaigns/${CAMPAIGN_UUID}/impact-report`);

  assert.equal(response.status, 200);
  assert.equal(response.body.title, 'Test Report');
  assert.equal(response.body.status, 'published');
});

test('getDraftImpactReport requires auth', async () => {
  const db = makeDb([...defaultHandlers]);
  const router = proxyquire('../routes/impactReports', {
    '../config/database': db,
    '../config/logger': mockLogger,
    '../services/impactReportService': buildService(db),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);

  const response = await request(app).get(`/api/campaigns/${CAMPAIGN_UUID}/impact-report/draft`);

  assert.equal(response.status, 401);
});

test('API validates required fields', async () => {
  const db = makeDb([...defaultHandlers]);

  const app = buildApp(db);

  const response = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_UUID}/impact-report`)
    .send({ content: 'Content only' });

  assert.equal(response.status, 400);
  assert.ok(response.body.errors);
});

test('API enforces field length limits', async () => {
  const db = makeDb([...defaultHandlers]);

  const app = buildApp(db);

  const longTitle = 'a'.repeat(300);
  const response = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_UUID}/impact-report`)
    .send({ title: longTitle, content: 'Content' });

  assert.equal(response.status, 400);
  assert.ok(response.body.errors);
});

test('impactReportService.createImpactReport validates input', async () => {
  const service = buildService(makeDb([...defaultHandlers]));

  await assert.rejects(
    service.createImpactReport({
      campaignId: null,
      creatorId: 'user-1',
      title: 'Title',
      content: 'Content',
    }),
    /Missing required fields/
  );
});

test('impactReportService.publishImpactReport verifies creator ownership', async () => {
  const db = makeDb([
    [
      /FROM campaign_impact_reports/,
      {
        rows: [
          {
            id: 'report-1',
            campaign_id: CAMPAIGN_UUID,
            creator_id: 'different-user',
            status: 'draft',
          },
        ],
      },
    ],
    ...defaultHandlers,
  ]);
  const service = buildService(db);

  await assert.rejects(service.publishImpactReport('report-1', 'current-user'), err => {
    assert.equal(err.status, 403);
    assert.match(err.message, /creator/);
    return true;
  });
});

test('impactReportService.updateImpactReport only updates draft status', async () => {
  const db = makeDb([
    [
      /FROM campaign_impact_reports/,
      {
        rows: [{ id: 'report-1', creator_id: 'user-1', status: 'published' }],
      },
    ],
    ...defaultHandlers,
  ]);
  const service = buildService(db);

  await assert.rejects(
    service.updateImpactReport('report-1', 'user-1', { title: 'New Title' }),
    err => {
      assert.equal(err.status, 400);
      assert.match(err.message, /draft/);
      return true;
    }
  );
});

test('impactReportService.hasPublishedReport checks publication status', async () => {
  const db = makeDb([[/COUNT/, { rows: [{ count: 1 }] }], ...defaultHandlers]);
  const service = buildService(db);

  const hasReport = await service.hasPublishedReport('campaign-1');
  assert.equal(hasReport, true);
});

test('impactReportService.getDraftImpactReport verifies creator access', async () => {
  const db = makeDb([
    [
      /status = 'draft'/,
      {
        rows: [
          {
            id: 'draft-1',
            campaign_id: CAMPAIGN_UUID,
            creator_id: 'different-user',
            title: 'Draft',
            content: 'Content',
            status: 'draft',
          },
        ],
      },
    ],
    ...defaultHandlers,
  ]);
  const service = buildService(db);

  await assert.rejects(service.getDraftImpactReport(CAMPAIGN_UUID, 'current-user'), err => {
    assert.equal(err.status, 403);
    assert.match(err.message, /creator/);
    return true;
  });
});
