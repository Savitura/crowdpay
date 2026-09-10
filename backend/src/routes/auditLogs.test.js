const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const proxyquire = require('proxyquire').noCallThru();

function createApp(user, queryImpl) {
  const mockDb = { query: queryImpl };
  const auditLogsRouter = proxyquire('./auditLogs', {
    '../config/database': mockDb,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = user;
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
    },
    '../services/auditService': {
      queryAuditLogs: async (filters) => {
        const countResult = await mockDb.query('COUNT');
        const dataResult = await mockDb.query('DATA', filters);
        return {
          items: dataResult.rows,
          total: parseInt(countResult.rows[0]?.count || '0', 10),
          limit: parseInt(filters.limit, 10) || 50,
          offset: parseInt(filters.offset, 10) || 0,
        };
      },
      queryAllForExport: async () => {
        const result = await mockDb.query('EXPORT');
        return result.rows;
      },
      buildExportCsv: (rows) => {
        const headers = 'id,actor_id,action,ip_address,user_agent,metadata,created_at';
        const lines = rows.map((r) =>
          [r.id, r.actor_id, r.action, r.ip_address, r.user_agent, r.metadata, r.created_at].join(',')
        );
        return [headers, ...lines].join('\n');
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/admin/audit-logs', auditLogsRouter);
  return app;
}

describe('GET /api/admin/audit-logs', () => {
  it('returns paginated audit logs for admin', async () => {
    let callIndex = 0;
    const queryImpl = async () => {
      callIndex++;
      if (callIndex === 1) {
        return { rows: [{ count: '2' }] };
      }
      return {
        rows: [
          { id: 1, actor_id: 'u1', action: 'login', ip_address: '1.2.3.4', user_agent: 'test', metadata: '{}', created_at: new Date().toISOString() },
          { id: 2, actor_id: 'u2', action: 'refund', ip_address: '5.6.7.8', user_agent: 'test', metadata: '{"campaignId":"c1"}', created_at: new Date().toISOString() },
        ],
      };
    };

    const app = createApp({ userId: 'admin1', role: 'admin' }, queryImpl);
    const res = await request(app).get('/api/admin/audit-logs');

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.total, 2);
  });

  it('filters by action', async () => {
    let callIndex = 0;
    const queryImpl = async () => {
      callIndex++;
      if (callIndex === 1) {
        return { rows: [{ count: '1' }] };
      }
      return {
        rows: [
          { id: 1, actor_id: 'u1', action: 'login', ip_address: null, user_agent: null, metadata: null, created_at: new Date().toISOString() },
        ],
      };
    };

    const app = createApp({ userId: 'admin1', role: 'admin' }, queryImpl);
    const res = await request(app).get('/api/admin/audit-logs?action=login');

    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].action, 'login');
  });

  it('respects limit and offset', async () => {
    let callIndex = 0;
    const queryImpl = async () => {
      callIndex++;
      if (callIndex === 1) {
        return { rows: [{ count: '100' }] };
      }
      return { rows: [] };
    };

    const app = createApp({ userId: 'admin1', role: 'admin' }, queryImpl);
    const res = await request(app).get('/api/admin/audit-logs?limit=10&offset=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.limit, 10);
    assert.equal(res.body.offset, 20);
  });
});

describe('GET /api/admin/audit-logs/export', () => {
  it('exports JSON by default', async () => {
    const queryImpl = async () => ({
      rows: [
        { id: 1, actor_id: 'u1', action: 'login', ip_address: null, user_agent: null, metadata: null, created_at: new Date().toISOString() },
      ],
    });

    const app = createApp({ userId: 'admin1', role: 'admin' }, queryImpl);
    const res = await request(app).get('/api/admin/audit-logs/export');

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /json/);
    assert.match(res.headers['content-disposition'], /audit-logs\.json/);
  });

  it('exports CSV when format=csv', async () => {
    const queryImpl = async () => ({
      rows: [
        { id: 1, actor_id: 'u1', action: 'login', ip_address: null, user_agent: null, metadata: null, created_at: new Date().toISOString() },
      ],
    });

    const app = createApp({ userId: 'admin1', role: 'admin' }, queryImpl);
    const res = await request(app).get('/api/admin/audit-logs/export?format=csv');

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /csv/);
    assert.match(res.headers['content-disposition'], /audit-logs\.csv/);
    assert.ok(res.text.includes('id,actor_id,action'));
  });
});
