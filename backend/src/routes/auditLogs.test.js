const request = require('supertest');
const express = require('express');
const auditLogsRouter = require('./auditLogs');
const db = require('../config/database');

jest.mock('../config/database');

function createApp(user) {
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
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 1, actor_id: 'u1', action: 'login', ip_address: '1.2.3.4', user_agent: 'test', metadata: '{}', created_at: new Date().toISOString() },
          { id: 2, actor_id: 'u2', action: 'refund', ip_address: '5.6.7.8', user_agent: 'test', metadata: '{"campaignId":"c1"}', created_at: new Date().toISOString() },
        ],
      });

    const app = createApp({ userId: 'admin1', role: 'admin' });
    const res = await request(app).get('/api/admin/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it('filters by action', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 1, actor_id: 'u1', action: 'login', ip_address: null, user_agent: null, metadata: null, created_at: new Date().toISOString() },
        ],
      });

    const app = createApp({ userId: 'admin1', role: 'admin' });
    const res = await request(app).get('/api/admin/audit-logs?action=login');

    expect(res.status).toBe(200);
    expect(res.body.items[0].action).toBe('login');
  });

  it('respects limit and offset', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ count: '100' }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = createApp({ userId: 'admin1', role: 'admin' });
    const res = await request(app).get('/api/admin/audit-logs?limit=10&offset=20');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(20);
  });
});

describe('GET /api/admin/audit-logs/export', () => {
  it('exports JSON by default', async () => {
    db.query = jest.fn().mockResolvedValueOnce({
      rows: [
        { id: 1, actor_id: 'u1', action: 'login', ip_address: null, user_agent: null, metadata: null, created_at: new Date().toISOString() },
      ],
    });

    const app = createApp({ userId: 'admin1', role: 'admin' });
    const res = await request(app).get('/api/admin/audit-logs/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-disposition']).toMatch(/audit-logs\.json/);
  });

  it('exports CSV when format=csv', async () => {
    db.query = jest.fn().mockResolvedValueOnce({
      rows: [
        { id: 1, actor_id: 'u1', action: 'login', ip_address: null, user_agent: null, metadata: null, created_at: new Date().toISOString() },
      ],
    });

    const app = createApp({ userId: 'admin1', role: 'admin' });
    const res = await request(app).get('/api/admin/audit-logs/export?format=csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/);
    expect(res.headers['content-disposition']).toMatch(/audit-logs\.csv/);
    expect(res.text).toContain('id,actor_id,action');
  });
});
