const assert = require('node:assert/strict');

const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = 'camp-1';

const USER_ID = 'user-1';

const CAMPAIGN_ROW = { id: CAMPAIGN_ID, creator_id: USER_ID, title: 'Test Campaign' };

function denyAuth() {
  return (_req, res) => res.status(401).json({ error: 'Unauthorized' });
}

function buildApp({ queryImpl, role = 'user', authed = true } = {}) {
  const calls = {};

  const defaultQuery = async (sql, params) => {
    calls.lastQuery = { sql, params };
    if (sql.includes('SELECT id, creator_id, title FROM campaigns')) {
      return { rows: role === 'admin' ? [{ ...CAMPAIGN_ROW, creator_id: 'other-user' }] : [CAMPAIGN_ROW] };
    }
    if (sql.includes('INSERT INTO thank_you_messages')) {
      calls.insertParams = params;
      return { rows: [{ id: 'msg-1', campaign_id: CAMPAIGN_ID, creator_id: USER_ID, message: params[2], type: 'bulk' }] };
    }
    if (sql.includes('SELECT DISTINCT ON (u.id)')) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  const router = proxyquire('./thankYou', {
    '../config/database': { query: queryImpl || defaultQuery },
    '../middleware/auth': {
      requireAuth: authed
        ? (req, _res, next) => {
            req.user = { userId: USER_ID, role };
            next();
          }
        : denyAuth(),
    },
    '../config/logger': { error: () => {} },
    '../services/emailService': { sendThankYouEmail: async () => {} },
    '../services/notifications': { createNotification: async () => {} },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/thank-you', router);

  return { app, calls };
}

const request = require('supertest');
const express = require('express');
const thankYouRouter = require('./thankYou');
const db = require('../config/database');

jest.mock('../config/database', () => ({
  query: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
  sendThankYouEmail: jest.fn(),
}));

jest.mock('../services/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { userId: 'creator-1', role: 'creator' };
  next();
});
app.use('/', thankYouRouter);

describe('thankYou routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('handles valid bulk thank-you with proper DISTINCT ON and ORDER BY query', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'camp-1', creator_id: 'creator-1', title: 'Test Campaign' }] }) // campaign lookup
      .mockResolvedValueOnce({ rows: [] }) // rate limit check
      .mockResolvedValueOnce({
        rows: [
          { id: 'user-1', email: 'alice@example.com', name: 'Alice' },
          { id: 'user-2', email: 'bob@example.com', name: 'Bob' },
        ],
      }) // contributors query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'msg-1',
            campaign_id: 'camp-1',
            creator_id: 'creator-1',
            message: 'Thanks everyone!',
            type: 'bulk',
            sent_at: new Date(),
          },
        ],
      }); // insert message

    const res = await request(app)
      .post('/campaigns/camp-1/thank-you')
      .send({ message: 'Thanks everyone!' });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('bulk');

    // Verify the query call includes ORDER BY u.id
    const contributorQueryCall = db.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('DISTINCT ON')
    );
    expect(contributorQueryCall[0]).toContain('ORDER BY u.id');
  });

  it('does not return 201 when database lookup fails', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'camp-1', creator_id: 'creator-1', title: 'Test Campaign' }] }) // campaign lookup
      .mockResolvedValueOnce({ rows: [] }) // rate limit check
      .mockRejectedValueOnce(new Error('DB failure')); // contributors query failure

    const res = await request(app)
      .post('/campaigns/camp-1/thank-you')
      .send({ message: 'Thanks everyone!' });

    expect(res.status).not.toBe(201);
  });

  it('enforces rate limit when bulk thank-you was sent recently', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'camp-1', creator_id: 'creator-1', title: 'Test Campaign' }] }) // campaign lookup
      .mockResolvedValueOnce({ rows: [{}] }); // recent bulk message found

    const res = await request(app)
      .post('/campaigns/camp-1/thank-you')
      .send({ message: 'Thanks again!' });

    expect(res.status).toBe(429);
  });
});
