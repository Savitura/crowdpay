process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';
process.env.PLATFORM_SECRET_KEY = process.env.PLATFORM_SECRET_KEY || 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const COMMENT_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = 'user-1';
const CREATOR_ID = 'creator-1';

function buildApp({ queryImpl, user = { userId: USER_ID, role: 'contributor' } } = {}) {
  const calls = [];
  let commentEmailSent = false;
  let replyEmailSent = false;

  const router = proxyquire('./campaignComments', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        if (queryImpl) return queryImpl(text, params);
        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        if (user) req.user = user;
        next();
      },
      authenticate: async (req) => {
        if (user) req.user = user;
      },
    },
    '../services/notifications': {
      createNotification: async () => {},
    },
    '../services/emailService': {
      sendCampaignCommentEmail: async () => {
        commentEmailSent = true;
      },
      sendCommentReplyEmail: async () => {
        replyEmailSent = true;
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return { app, calls, getEmailStats: () => ({ commentEmailSent, replyEmailSent }) };
}

test('GET /api/campaigns/:id/comments returns comments list with creator badge and upvotes count', async () => {
  const mockComments = [
    {
      id: COMMENT_ID,
      campaign_id: CAMPAIGN_ID,
      author_id: USER_ID,
      user_id: USER_ID,
      parent_id: null,
      body: 'When is estimated delivery?',
      hidden: false,
      created_at: new Date().toISOString(),
      author_name: 'Alice',
      is_creator_reply: false,
      upvotes_count: 3,
      user_upvoted: true,
    },
  ];

  const { app, calls } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT id, creator_id FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID }] };
      }
      if (text.includes('FROM campaign_comments')) {
        return { rows: mockComments };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/comments`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, mockComments);
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /is_creator_reply/);
  assert.match(calls[1].text, /upvotes_count/);
});

test('POST /api/campaigns/:id/comments posts a top-level question', async () => {
  const newComment = {
    id: COMMENT_ID,
    campaign_id: CAMPAIGN_ID,
    author_id: USER_ID,
    parent_id: null,
    body: 'What is the refund policy?',
    hidden: false,
    created_at: new Date().toISOString(),
  };

  const { app, calls } = buildApp({
    user: { userId: USER_ID, role: 'contributor' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id, creator_id, title FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Sample Campaign' }] };
      }
      if (text.includes('INSERT INTO campaign_comments')) {
        return { rows: [newComment] };
      }
      if (text.includes('SELECT name FROM users')) {
        return { rows: [{ name: 'Alice' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/comments`)
    .send({ body: 'What is the refund policy?' });

  assert.equal(res.status, 201);
  assert.equal(res.body.body, 'What is the refund policy?');
  assert.equal(res.body.is_creator_reply, false);
  assert.equal(res.body.author_name, 'Alice');
});

test('POST /api/campaigns/:id/comments/:commentId/upvote toggles upvote', async () => {
  let hasUpvoted = false;
  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM campaign_comments')) {
        return { rows: [{ id: COMMENT_ID }] };
      }
      if (text.includes('SELECT 1 FROM campaign_comment_upvotes')) {
        return { rows: hasUpvoted ? [{ 1: 1 }] : [] };
      }
      if (text.includes('INSERT INTO campaign_comment_upvotes')) {
        hasUpvoted = true;
        return { rows: [] };
      }
      if (text.includes('DELETE FROM campaign_comment_upvotes')) {
        hasUpvoted = false;
        return { rows: [] };
      }
      if (text.includes('COUNT(*)::int AS upvotes_count')) {
        return { rows: [{ upvotes_count: hasUpvoted ? 1 : 0 }] };
      }
      return { rows: [] };
    },
  });

  // First call -> Upvote
  const res1 = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/comments/${COMMENT_ID}/upvote`);
  assert.equal(res1.status, 200);
  assert.equal(res1.body.upvoted, true);
  assert.equal(res1.body.upvotes_count, 1);

  // Second call -> Downvote / remove upvote
  const res2 = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/comments/${COMMENT_ID}/upvote`);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.upvoted, false);
  assert.equal(res2.body.upvotes_count, 0);
});

test('DELETE /api/campaigns/:id/comments/:commentId deletes a comment', async () => {
  const { app, calls } = buildApp({
    user: { userId: USER_ID, role: 'contributor' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id, creator_id FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID }] };
      }
      if (text.includes('DELETE FROM campaign_comments')) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/comments/${COMMENT_ID}`);

  assert.equal(res.status, 204);
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /DELETE FROM campaign_comments/);
});

test('POST /api/campaigns/:id/comments/:commentId/flag flags a comment for review', async () => {
  const { app, calls } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM campaign_comments')) {
        return { rows: [{ id: COMMENT_ID }] };
      }
      if (text.includes('INSERT INTO campaign_comment_flags')) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/comments/${COMMENT_ID}/flag`)
    .send({ reason: 'Spam comment' });

  assert.equal(res.status, 204);
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /INSERT INTO campaign_comment_flags/);
});

test('POST /api/campaigns/:id/comments/:commentId/pin pins a comment to the top', async () => {
  const { app, calls } = buildApp({
    user: { userId: CREATOR_ID, role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id, creator_id') && text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Test Campaign' }] };
      }
      if (text.includes('UPDATE campaign_comments SET pinned = FALSE')) {
        return { rows: [] };
      }
      if (text.includes('UPDATE campaign_comments') && text.includes('pinned = TRUE')) {
        return { rows: [{ id: COMMENT_ID, campaign_id: CAMPAIGN_ID, pinned: true }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/comments/${COMMENT_ID}/pin`);
  assert.equal(res.status, 200);
  assert.equal(res.body.pinned, true);
});

test('POST /api/campaigns/:id/comments/:commentId/unpin unpins a comment', async () => {
  const { app, calls } = buildApp({
    user: { userId: CREATOR_ID, role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id, creator_id') && text.includes('FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Test Campaign' }] };
      }
      if (text.includes('UPDATE campaign_comments') && text.includes('pinned = FALSE')) {
        return { rows: [{ id: COMMENT_ID, campaign_id: CAMPAIGN_ID, pinned: false }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/comments/${COMMENT_ID}/unpin`);
  assert.equal(res.status, 200);
  assert.equal(res.body.pinned, false);
});

