'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const FILE_ID = '22222222-2222-2222-2222-222222222222';

function buildApp({
  user = { userId: 'user-owner', role: 'creator' },
  serviceOverrides = {},
  storageOverrides = {},
} = {}) {
  const router = proxyquire('./campaignDataRoom', {
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!user) {
          return res.status(401).json({ error: 'Authentication required' });
        }
        req.user = user;
        next();
      },
      optionalAuth: (req, _res, next) => {
        if (user) req.user = user;
        next();
      },
    },
    '../services/storage': {
      uploadDataRoomAttachment: async () => 'https://storage/uploaded-file.pdf',
      ...storageOverrides,
    },
    '../services/campaignDataRoomService': {
      listDataRoomFiles: async () => ({
        files: [
          {
            id: FILE_ID,
            name: 'Pitch Deck',
            category: 'pitch_deck',
            access_level: 'public',
            can_manage: true,
          },
        ],
        total: 1,
        user_role: 'owner',
        can_upload: true,
        can_view_logs: true,
        categories_summary: { pitch_deck: 1, financials: 0 },
      }),
      createDataRoomFile: async (_campId, _userId, payload) => ({
        id: FILE_ID,
        ...payload,
        can_manage: true,
      }),
      getDataRoomFile: async () => ({
        id: FILE_ID,
        name: 'Pitch Deck',
        access_level: 'public',
        file_url: 'https://storage/deck.pdf',
      }),
      downloadDataRoomFile: async () => ({
        file: { id: FILE_ID, name: 'Pitch Deck' },
        download_url: 'https://storage/deck.pdf',
        original_filename: 'deck.pdf',
        mime_type: 'application/pdf',
      }),
      updateDataRoomFile: async (_campId, _fileId, _userId, updates) => ({
        id: FILE_ID,
        name: updates.name || 'Pitch Deck',
      }),
      deleteDataRoomFile: async () => ({ success: true, id: FILE_ID }),
      getDataRoomAccessLogs: async () => ({
        logs: [{ id: 'log-1', action: 'download', file_name: 'Pitch Deck' }],
        total: 1,
      }),
      ...serviceOverrides,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);

  // Global error handler
  app.use((err, _req, res, _next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });

  return app;
}

test('GET /api/campaigns/:id/data-room/files returns accessible files', async () => {
  const app = buildApp({ user: null });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/data-room/files`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 1);
  assert.strictEqual(res.body.files[0].name, 'Pitch Deck');
});

test('POST /api/campaigns/:id/data-room/files requires authentication', async () => {
  const app = buildApp({ user: null });
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/data-room/files`)
    .send({ name: 'Financials' });

  assert.strictEqual(res.status, 401);
});

test('POST /api/campaigns/:id/data-room/files creates file via JSON', async () => {
  const app = buildApp();
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/data-room/files`).send({
    name: 'Financial Projections',
    file_url: 'https://cdn/projections.xlsx',
    category: 'financials',
    access_level: 'backer',
  });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.name, 'Financial Projections');
});

test('POST /api/campaigns/:id/data-room/files supports multipart file upload', async () => {
  const app = buildApp();
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/data-room/files`)
    .field('name', 'Whitepaper')
    .field('category', 'technical')
    .field('access_level', 'public')
    .attach('file', Buffer.from('%PDF-1.4 test content'), {
      filename: 'whitepaper.pdf',
      contentType: 'application/pdf',
    });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.name, 'Whitepaper');
});

test('POST /api/campaigns/:id/data-room/files rejects unsupported mime type via multipart', async () => {
  const app = buildApp();
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/data-room/files`)
    .field('name', 'Malicious Script')
    .attach('file', Buffer.from('#!/bin/bash echo bad'), {
      filename: 'script.sh',
      contentType: 'application/x-sh',
    });

  assert.strictEqual(res.status, 415);
  assert.match(res.body.error, /Unsupported Media Type/i);
});

test('POST /api/campaigns/:id/data-room/files forwards 403 on role permission violation', async () => {
  const app = buildApp({
    serviceOverrides: {
      createDataRoomFile: async () => {
        const err = new Error(
          'Cannot assign access level "owner" higher than your role permission "editor".'
        );
        err.status = 403;
        throw err;
      },
    },
  });

  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/data-room/files`).send({
    name: 'Secret Agreement',
    file_url: 'https://cdn/doc.pdf',
    access_level: 'owner',
  });

  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /Cannot assign access level/i);
});

test('GET /api/campaigns/:id/data-room/files/:fileId returns single file', async () => {
  const app = buildApp();
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/data-room/files/${FILE_ID}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.id, FILE_ID);
});

test('GET /api/campaigns/:id/data-room/files/:fileId/download returns download info', async () => {
  const app = buildApp();
  const res = await request(app).get(
    `/api/campaigns/${CAMPAIGN_ID}/data-room/files/${FILE_ID}/download`
  );

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.download_url, 'https://storage/deck.pdf');
});

test('PATCH /api/campaigns/:id/data-room/files/:fileId updates file metadata', async () => {
  const app = buildApp();
  const res = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/data-room/files/${FILE_ID}`)
    .send({ name: 'Updated Pitch Deck' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.name, 'Updated Pitch Deck');
});

test('DELETE /api/campaigns/:id/data-room/files/:fileId soft-deletes file', async () => {
  const app = buildApp();
  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/data-room/files/${FILE_ID}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
});

test('GET /api/campaigns/:id/data-room/access-logs returns audit logs', async () => {
  const app = buildApp();
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/data-room/access-logs`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 1);
  assert.strictEqual(res.body.logs[0].action, 'download');
});
