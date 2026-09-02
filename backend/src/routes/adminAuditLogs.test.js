const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, authUser } = {}) {
  const dbStub = { query: queryImpl || (async () => ({ rows: [] })) };

  const authMiddleware = {
    requireAuth: (req, res, next) => {
      if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
      req.user = authUser;
      next();
    },
    requireAdmin: (req, res, next) => {
      if (!req.user?.is_admin) return res.status(403).json({ error: 'Forbidden' });
      next();
    },
  };

  const adminAuditRoutes = proxyquire('./adminAuditLogs', {
    '../config/database': dbStub,
    '../middleware/auth': authMiddleware,
    '../services/auditService': proxyquire('../services/auditService', {
      '../config/database': dbStub,
      '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    }),
    '../utils/asyncHandler': (fn) => fn,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminAuditRoutes);
  return app;
}

describe('Admin Audit Log Access Control', () => {
  it('returns 401 for unauthenticated requests', async () => {
    const app = buildApp({ queryImpl: async () => ({ rows: [] }) });
    const res = await request(app).get('/api/admin/audit-logs');
    assert.equal(res.status, 401);
  });

  it('returns 403 for non-admin users', async () => {
    const app = buildApp({
      authUser: { userId: 'user-1', is_admin: false },
      queryImpl: async () => ({ rows: [] }),
    });
    const res = await request(app).get('/api/admin/audit-logs');
    assert.equal(res.status, 403);
  });

  it('returns 200 for admin users', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text) => {
        if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/audit-logs');
    assert.equal(res.status, 200);
  });
});

describe('Audit Log List Endpoint', () => {
  it('returns paginated results with data, total, limit, and offset', async () => {
    const mockRows = [
      { id: 'a1', actor_id: 'u1', actor_email: 'admin@test.com', action: 'login', resource_type: 'user', resource_id: null, ip_address: '1.2.3.4', user_agent: 'test', metadata: {}, created_at: new Date() },
    ];
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text) => {
        if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
        return { rows: mockRows };
      },
    });
    const res = await request(app).get('/api/admin/audit-logs');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.total, 1);
    assert.equal(typeof res.body.limit, 'number');
    assert.equal(typeof res.body.offset, 'number');
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].action, 'login');
  });

  it('passes actor filter to the query', async () => {
    let capturedParams = null;
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text, params) => {
        capturedParams = params;
        if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/audit-logs?actor=evil@test.com');
    assert.equal(res.status, 200);
    assert.ok(capturedParams);
  });

  it('passes action filter to the query', async () => {
    let capturedText = null;
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text) => {
        capturedText = text;
        if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/audit-logs?action=refund_issued');
    assert.equal(res.status, 200);
    assert.ok(capturedText.includes('a.action ='));
  });

  it('passes resource_type filter to the query', async () => {
    let capturedText = null;
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text) => {
        capturedText = text;
        if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/audit-logs?resource_type=refund');
    assert.equal(res.status, 200);
    assert.ok(capturedText.includes('a.resource_type ='));
  });

  it('passes start_date and end_date filters to the query', async () => {
    let capturedText = null;
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text) => {
        capturedText = text;
        if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    });
    const res = await request(app).get(
      '/api/admin/audit-logs?start_date=2026-01-01T00:00:00.000Z&end_date=2026-01-31T23:59:59.999Z'
    );
    assert.equal(res.status, 200);
    assert.ok(capturedText.includes('a.created_at >='));
    assert.ok(capturedText.includes('a.created_at <='));
  });

  it('uses limit and offset from pagination', async () => {
    let capturedParams = null;
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text, params) => {
        capturedParams = params;
        if (text.includes('COUNT(*)')) return { rows: [{ total: 50 }] };
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/audit-logs?limit=10&offset=20');
    assert.equal(res.status, 200);
    assert.ok(capturedParams);
    const limitIdx = capturedParams.indexOf(10);
    assert.ok(limitIdx >= 0, 'limit param found in query params');
  });
});

describe('Audit Log Export', () => {
  it('GET /audit-logs/export.csv returns CSV with correct content type', async () => {
    const mockRows = [
      { id: 'a1', actor_id: 'u1', actor_email: 'admin@test.com', action: 'login', resource_type: 'user', resource_id: null, ip_address: '1.2.3.4', user_agent: 'test-agent', metadata: { detail: 'ok' }, created_at: new Date('2026-06-15T12:00:00Z') },
    ];
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text) => {
        if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
        return { rows: mockRows };
      },
    });
    const res = await request(app).get('/api/admin/audit-logs/export.csv');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.headers['content-disposition'].includes('audit-logs'));
    assert.ok(res.text.includes('actor'));
    assert.ok(res.text.includes('admin@test.com'));
    assert.ok(res.text.includes('login'));
    assert.ok(res.text.includes('user'));
  });

  it('GET /audit-logs/export.json returns JSON with correct content type', async () => {
    const mockRows = [
      { id: 'a1', actor_id: 'u1', actor_email: 'admin@test.com', action: 'refund_issued', resource_type: 'refund', resource_id: 'ref-1', ip_address: '1.2.3.4', user_agent: 'test-agent', metadata: { amount: 50 }, created_at: new Date('2026-06-15T12:00:00Z') },
    ];
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text) => {
        if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
        return { rows: mockRows };
      },
    });
    const res = await request(app).get('/api/admin/audit-logs/export.json');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    const parsed = JSON.parse(res.text);
    assert.ok(Array.isArray(parsed.audit_logs));
    assert.equal(parsed.audit_logs.length, 1);
    assert.equal(parsed.audit_logs[0].action, 'refund_issued');
    assert.equal(parsed.audit_logs[0].metadata.amount, 50);
  });

  it('CSV export returns 403 for non-admin', async () => {
    const app = buildApp({
      authUser: { userId: 'user-1', is_admin: false },
      queryImpl: async () => ({ rows: [] }),
    });
    const res = await request(app).get('/api/admin/audit-logs/export.csv');
    assert.equal(res.status, 403);
  });

  it('JSON export returns 403 for non-admin', async () => {
    const app = buildApp({
      authUser: { userId: 'user-1', is_admin: false },
      queryImpl: async () => ({ rows: [] }),
    });
    const res = await request(app).get('/api/admin/audit-logs/export.json');
    assert.equal(res.status, 403);
  });
});

describe('Audit Log Metadata Sanitization', () => {
  it('sanitizeMetadata redacts sensitive keys', () => {
    const { sanitizeMetadata } = require('../services/auditService');
    const input = {
      user_email: 'test@test.com',
      password: 'secret123',
      my_token: 'abc123',
      password_hash: '$2b$10$abc',
      nested: {
        secret_key: 'xyz',
        safe_field: 'ok',
      },
      arr: [{ totp_code: '123456' }, { note: 'safe' }],
    };
    const result = sanitizeMetadata(input);
    assert.equal(result.user_email, 'test@test.com');
    assert.equal(result.password, '[REDACTED]');
    assert.equal(result.my_token, '[REDACTED]');
    assert.equal(result.password_hash, '[REDACTED]');
    assert.equal(result.nested.secret_key, '[REDACTED]');
    assert.equal(result.nested.safe_field, 'ok');
    assert.equal(result.arr[0].totp_code, '[REDACTED]');
    assert.equal(result.arr[1].note, 'safe');
  });

  it('sanitizeMetadata redacts Stellar private key patterns', () => {
    const { sanitizeMetadata } = require('../services/auditService');
    const input = { key: `S${'A'.repeat(55)}` };
    const result = sanitizeMetadata(input);
    assert.equal(result.key, '[REDACTED]');
  });

  it('sanitizeMetadata handles null/undefined/non-object gracefully', () => {
    const { sanitizeMetadata } = require('../services/auditService');
    assert.equal(sanitizeMetadata(null), null);
    assert.equal(sanitizeMetadata(undefined), undefined);
    assert.equal(sanitizeMetadata('simple string'), 'simple string');
    assert.equal(sanitizeMetadata(42), 42);
  });

  it('audit_log stores metadata with redacted values', async () => {
    let capturedValues = null;

    const dbStub = {
      query: async (text, values) => {
        capturedValues = values;
        return {
          rows: [{
            id: 'new-id', actor_id: values[0], action: values[1], resource_type: values[2],
            resource_id: values[3], ip_address: values[4], user_agent: values[5],
            metadata: JSON.parse(values[6]), created_at: new Date(),
          }],
        };
      },
    };

    const mockService = proxyquire('../services/auditService', {
      '../config/database': dbStub,
      '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    });

    await mockService.logAuditEvent({
      actorId: 'admin-1',
      action: 'test_action',
      resourceType: 'user',
      resourceId: 'u1',
      metadata: { password: 'mysecret', safe: 'ok', api_token: 'tok123' },
      req: { ip: '1.2.3.4', headers: { 'user-agent': 'test' } },
    });

    assert.ok(capturedValues, 'INSERT INTO audit_logs was called');
    const storedMetadata = JSON.parse(capturedValues[6]);
    assert.equal(storedMetadata.password, '[REDACTED]');
    assert.equal(storedMetadata.api_token, '[REDACTED]');
    assert.equal(storedMetadata.safe, 'ok');
    assert.equal(capturedValues[0], 'admin-1');
  });
});

describe('Audit Log - Append-Only Enforcement', () => {
  it('audit_logs table does not expose update/delete via routes', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async () => ({ rows: [] }),
    });

    // Verify there are no PUT, PATCH, or DELETE routes for audit-logs
    const resPut = await request(app).put('/api/admin/audit-logs');
    const resPatch = await request(app).patch('/api/admin/audit-logs');
    const resDelete = await request(app).delete('/api/admin/audit-logs');
    assert.equal(resPut.status, 404, 'PUT /admin/audit-logs should not exist');
    assert.equal(resPatch.status, 404, 'PATCH /admin/audit-logs should not exist');
    assert.equal(resDelete.status, 404, 'DELETE /admin/audit-logs should not exist');
  });
});
