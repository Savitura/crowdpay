process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'testsecret';
process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const CREATOR_ID = 'user-creator';
const OTHER_USER_ID = 'user-other';

function buildTranslationsApp(queryImpl, authUser = { userId: CREATOR_ID, role: 'creator' }) {
  const router = proxyquire('./translations', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = authUser;
        next();
      },
    },
    '../middleware/validation': {
      validateRequest: (req, res, next) => {
        const { validationResult } = require('express-validator');
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(400).json({ success: false, errors: errors.array() });
        }
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

function buildCampaignsApp(queryImpl) {
  const campaignsRouter = proxyquire('./campaigns', {
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release: async () => {} }),
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../services/campaignStatusService': {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
    },
    '../services/stellarService': {
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', campaignsRouter);
  return app;
}

test('POST /:campaignId/translations creates a new translation with locale, title, description, milestone_titles', async () => {
  const calls = [];
  const app = buildTranslationsApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes('SELECT creator_id FROM campaigns')) {
      return { rows: [{ creator_id: CREATOR_ID, status: 'active' }] };
    }
    if (text.includes('INSERT INTO campaign_translations')) {
      return {
        rows: [{
          id: 'trans-1',
          campaign_id: CAMPAIGN_ID,
          language: 'fr',
          locale: 'fr',
          title: 'Campagne en français',
          description: 'Description en français',
          milestone_titles: ['Étape 1', 'Étape 2'],
        }],
      };
    }
    return { rows: [] };
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/translations`)
    .send({
      locale: 'fr',
      title: 'Campagne en français',
      description: 'Description en français',
      milestone_titles: ['Étape 1', 'Étape 2'],
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.locale, 'fr');
  assert.equal(res.body.data.title, 'Campagne en français');
});

test('POST /:campaignId/translations forbids unauthorized user', async () => {
  const app = buildTranslationsApp(
    async (text) => {
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: CREATOR_ID, status: 'active' }] };
      }
      return { rows: [] };
    },
    { userId: OTHER_USER_ID, role: 'contributor' }
  );

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/translations`)
    .send({
      locale: 'fr',
      title: 'Titre',
    });

  assert.equal(res.status, 403);
  assert.equal(res.body.success, false);
});

test('GET /:campaignId/translations lists all translations for a campaign', async () => {
  const app = buildTranslationsApp(async (text) => {
    if (text.includes('FROM campaign_translations') && text.includes('WHERE campaign_id = $1')) {
      return {
        rows: [
          { id: 'trans-1', campaign_id: CAMPAIGN_ID, locale: 'fr', title: 'Titre FR' },
          { id: 'trans-2', campaign_id: CAMPAIGN_ID, locale: 'es', title: 'Título ES' },
        ],
      };
    }
    return { rows: [] };
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/translations`);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.data[0].locale, 'fr');
});

test('DELETE /:campaignId/translations/:locale removes translation', async () => {
  let deleted = false;
  const app = buildTranslationsApp(async (text, _params) => {
    if (text.includes('SELECT creator_id FROM campaigns')) {
      return { rows: [{ creator_id: CREATOR_ID }] };
    }
    if (text.includes('DELETE FROM campaign_translations')) {
      deleted = true;
      return { rows: [] };
    }
    return { rows: [] };
  });

  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/translations/fr`);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(deleted, true);
});

test('GET /:id?locale=fr returns translated fields when available', async () => {
  const app = buildCampaignsApp(async (text, params) => {
    if (text.includes('FROM campaigns c') && text.includes('JOIN users u')) {
      return {
        rows: [{
          id: CAMPAIGN_ID,
          creator_id: CREATOR_ID,
          title: 'Original English Title',
          description: 'Original English Description',
          status: 'active',
          target_amount: 1000,
        }],
      };
    }
    if (text.includes('FROM campaign_translations')) {
      if (params && params[1] === 'fr') {
        return {
          rows: [{
            title: 'Titre Français',
            description: 'Description en Français',
            milestone_titles: ['Étape 1'],
            locale: 'fr',
          }],
        };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}?locale=fr`);
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Titre Français');
  assert.equal(res.body.description, 'Description en Français');
  assert.equal(res.body.is_translated, true);
  assert.equal(res.body.locale, 'fr');
});

test('GET /:id?locale=es falls back to original language when translation is unavailable', async () => {
  const app = buildCampaignsApp(async (text, _params) => {
    if (text.includes('FROM campaigns c') && text.includes('JOIN users u')) {
      return {
        rows: [{
          id: CAMPAIGN_ID,
          creator_id: CREATOR_ID,
          title: 'Original English Title',
          description: 'Original English Description',
          status: 'active',
          target_amount: 1000,
        }],
      };
    }
    if (text.includes('FROM campaign_translations')) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}?locale=es`);
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Original English Title');
  assert.equal(res.body.description, 'Original English Description');
  assert.equal(res.body.is_translated, undefined);
});

test('GET /:id/milestones?locale=fr translates milestone titles when translation exists', async () => {
  const app = buildCampaignsApp(async (text, params) => {
    if (text.includes('FROM milestones m')) {
      return {
        rows: [
          { id: 'm-1', campaign_id: CAMPAIGN_ID, title: 'Milestone 1', release_percentage: 50 },
          { id: 'm-2', campaign_id: CAMPAIGN_ID, title: 'Milestone 2', release_percentage: 50 },
        ],
      };
    }
    if (text.includes('FROM campaign_translations')) {
      if (params && params[1] === 'fr') {
        return {
          rows: [{
            milestone_titles: ['Première étape', 'Deuxième étape'],
          }],
        };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/milestones?locale=fr`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].title, 'Première étape');
  assert.equal(res.body[1].title, 'Deuxième étape');
});

test('GET /:id/milestones?locale=de falls back to original milestone titles when translation missing', async () => {
  const app = buildCampaignsApp(async (text) => {
    if (text.includes('FROM milestones m')) {
      return {
        rows: [
          { id: 'm-1', campaign_id: CAMPAIGN_ID, title: 'Milestone 1', release_percentage: 100 },
        ],
      };
    }
    if (text.includes('FROM campaign_translations')) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/milestones?locale=de`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].title, 'Milestone 1');
});
