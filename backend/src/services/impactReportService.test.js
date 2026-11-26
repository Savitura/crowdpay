'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const proxyquire = require('proxyquire').noCallThru();

function buildService({ queryImpl, onNotification } = {}) {
  const notifications = [];
  const service = proxyquire('./impactReportService', {
    '../config/database': {
      query: queryImpl || (async () => ({ rows: [] })),
    },
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    './notifications': {
      createNotification: async (userId, payload) => {
        notifications.push({ userId, payload });
        if (onNotification) return onNotification(userId, payload);
      },
    },
  });
  return { service, notifications };
}

test('createImpactReport validates fields, ownership, campaign status, and duplicates', async () => {
  const { service } = buildService({
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns')) {
        if (params[0] === 'missing') return { rows: [] };
        if (params[0] === 'draft-camp')
          return { rows: [{ id: 'draft-camp', creator_id: 'u1', status: 'draft' }] };
        return { rows: [{ id: params[0], creator_id: 'u1', status: 'completed' }] };
      }
      if (text.includes('FROM campaign_impact_reports')) {
        if (params[0] === 'dup-camp') return { rows: [{ id: 'rep-existing' }] };
        return { rows: [] };
      }
      if (text.includes('INSERT INTO campaign_impact_reports')) {
        return { rows: [{ id: 'rep-1' }] };
      }
      return { rows: [] };
    },
  });

  await assert.rejects(
    () => service.createImpactReport({ campaignId: 'c1' }),
    /Missing required fields/
  );
  await assert.rejects(
    () =>
      service.createImpactReport({
        campaignId: 'missing',
        creatorId: 'u1',
        title: 'T',
        content: 'C',
      }),
    err => err.status === 404
  );
  await assert.rejects(
    () =>
      service.createImpactReport({
        campaignId: 'c1',
        creatorId: 'other',
        title: 'T',
        content: 'C',
      }),
    err => err.status === 403
  );
  await assert.rejects(
    () =>
      service.createImpactReport({
        campaignId: 'draft-camp',
        creatorId: 'u1',
        title: 'T',
        content: 'C',
      }),
    err => err.status === 400
  );
  await assert.rejects(
    () =>
      service.createImpactReport({
        campaignId: 'dup-camp',
        creatorId: 'u1',
        title: 'T',
        content: 'C',
      }),
    err => err.status === 409
  );

  const reportId = await service.createImpactReport({
    campaignId: 'c1',
    creatorId: 'u1',
    title: 'Impact 2026',
    content: 'Built 3 wells',
    summary: 'Summary',
  });
  assert.equal(reportId, 'rep-1');
});

test('publishImpactReport enforces draft ownership, awards badge, and notifies contributors', async () => {
  const queries = [];
  const { service, notifications } = buildService({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('FROM campaign_impact_reports WHERE id = $1')) {
        if (params[0] === 'missing') return { rows: [] };
        if (params[0] === 'already-pub') {
          return {
            rows: [{ id: 'already-pub', campaign_id: 'c1', creator_id: 'u1', status: 'published' }],
          };
        }
        return {
          rows: [
            {
              id: params[0],
              campaign_id: 'c1',
              creator_id: 'u1',
              title: 'Report',
              summary: 'Great impact',
              status: 'draft',
            },
          ],
        };
      }
      if (text.includes('SELECT title FROM campaigns')) return { rows: [{ title: 'Solar Fund' }] };
      if (text.includes('SELECT DISTINCT c.sender_public_key')) {
        return { rows: [{ sender_public_key: 'GPK1' }, { sender_public_key: 'GPK2' }] };
      }
      if (text.includes('FROM users WHERE wallet_public_key = ANY')) {
        return { rows: [{ id: 'user-a' }, { id: 'user-b' }] };
      }
      return { rows: [] };
    },
    onNotification: async userId => {
      if (userId === 'user-a') throw new Error('notify failed');
    },
  });

  await assert.rejects(() => service.publishImpactReport('', 'u1'), /Missing reportId/);
  await assert.rejects(
    () => service.publishImpactReport('missing', 'u1'),
    err => err.status === 404
  );
  await assert.rejects(
    () => service.publishImpactReport('rep-1', 'other'),
    err => err.status === 403
  );
  await assert.rejects(
    () => service.publishImpactReport('already-pub', 'u1'),
    err => err.status === 400
  );

  await service.publishImpactReport('rep-1', 'u1');

  assert.equal(
    queries.some(q => q.text.includes("SET status = 'published'")),
    true
  );
  assert.equal(
    queries.some(q => q.text.includes('INSERT INTO creator_impact_badges')),
    true
  );
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].userId, 'user-b');
  assert.equal(notifications[1].payload.type, 'impact_report_published');
  assert.match(notifications[1].payload.title, /Solar Fund/);
});

test('getImpactReport, getDraftImpactReport, updateImpactReport, and hasPublishedReport', async () => {
  let updatedQuery = null;
  const { service } = buildService({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT COUNT(*) as count')) {
        return { rows: [{ count: params[0] === 'c1' ? 1 : 0 }] };
      }
      if (text.includes("status = 'published'") && text.includes('FROM campaign_impact_reports')) {
        if (params[0] === 'none') return { rows: [] };
        return {
          rows: [
            {
              id: 'rep-1',
              campaign_id: 'c1',
              creator_id: 'u1',
              title: 'Pub',
              content: 'Body',
              summary: null,
              status: 'published',
              published_at: '2026-01-01T00:00:00Z',
              images: null,
              videos: null,
              milestones: null,
              views_count: 5,
            },
          ],
        };
      }
      if (text.includes("status = 'draft'")) {
        if (params[0] === 'none') return { rows: [] };
        return {
          rows: [
            { id: 'rep-d', campaign_id: 'c1', creator_id: 'u1', title: 'Draft', status: 'draft' },
          ],
        };
      }
      if (text.includes('SELECT id, creator_id, status FROM campaign_impact_reports')) {
        if (params[0] === 'pub')
          return { rows: [{ id: 'pub', creator_id: 'u1', status: 'published' }] };
        return { rows: [{ id: 'rep-d', creator_id: 'u1', status: 'draft' }] };
      }
      if (text.startsWith('UPDATE campaign_impact_reports SET') && !text.includes('views_count')) {
        updatedQuery = { text, params };
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  assert.equal(await service.getImpactReport('none'), null);
  const pub = await service.getImpactReport('c1');
  assert.equal(pub.title, 'Pub');
  assert.deepEqual(pub.images, []);

  assert.equal(await service.getDraftImpactReport('none', 'u1'), null);
  await assert.rejects(
    () => service.getDraftImpactReport('c1', 'other'),
    err => err.status === 403
  );
  const draft = await service.getDraftImpactReport('c1', 'u1');
  assert.equal(draft.id, 'rep-d');

  await assert.rejects(
    () => service.updateImpactReport('pub', 'u1', { title: 'X' }),
    err => err.status === 400
  );
  await service.updateImpactReport('rep-d', 'u1', {});
  assert.equal(updatedQuery, null);

  await service.updateImpactReport('rep-d', 'u1', { title: 'New Title', images: ['img.png'] });
  assert.ok(updatedQuery.text.includes('title = $2'));
  assert.ok(updatedQuery.text.includes('images = $3'));
  assert.equal(updatedQuery.params[2], '["img.png"]');

  assert.equal(await service.hasPublishedReport('c1'), true);
  assert.equal(await service.hasPublishedReport('none'), false);
});

test('signImpactStats and verifyImpactSignature sign and verify RSA payloads', () => {
  const { service } = buildService();
  const prevKey = process.env.CROWDPAY_IMPACT_SIGNING_PRIVATE_KEY;
  delete process.env.CROWDPAY_IMPACT_SIGNING_PRIVATE_KEY;
  delete process.env.CROWDPAY_SIGNING_PRIVATE_KEY;
  delete process.env.PLATFORM_SIGNING_PRIVATE_KEY;

  try {
    assert.equal(service.signImpactStats({ total_raised: 10 }, 'c1'), null);
    assert.equal(service.verifyImpactSignature(null, 'sig', 'pub'), false);

    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    process.env.CROWDPAY_IMPACT_SIGNING_PRIVATE_KEY = privateKey;

    const signed = service.signImpactStats({ total_raised: 150 }, 'c1');
    assert.equal(signed.algorithm, 'sha256');
    assert.equal(service.verifyImpactSignature(signed.payload, signed.signature, publicKey), true);
    assert.equal(
      service.verifyImpactSignature('{"tampered":true}', signed.signature, publicKey),
      false
    );
  } finally {
    if (prevKey === undefined) delete process.env.CROWDPAY_IMPACT_SIGNING_PRIVATE_KEY;
    else process.env.CROWDPAY_IMPACT_SIGNING_PRIVATE_KEY = prevKey;
  }
});

test('getCampaignImpact caches by version and enforces per-IP rate limit', async () => {
  let statsQueries = 0;
  let version = '2026-01-01T00:00:00Z';

  const { service } = buildService({
    queryImpl: async text => {
      if (text.includes('AS version')) {
        return { rows: [{ version }] };
      }
      if (text.includes('AS total_raised')) {
        statsQueries++;
        return {
          rows: [
            {
              total_raised: '250.5',
              contribution_count: 2,
              average_contribution: '125.25',
              largest_contribution: '200',
              unique_contributor_count: 2,
              currency: 'USDC',
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const first = await service.getCampaignImpact('camp-cache');
  const second = await service.getCampaignImpact('camp-cache');
  assert.equal(first.total_raised, 250.5);
  assert.equal(second.total_raised, 250.5);
  assert.equal(statsQueries, 1);

  version = '2026-01-02T00:00:00Z';
  await service.getCampaignImpact('camp-cache');
  assert.equal(statsQueries, 2);

  for (let i = 0; i < 30; i++) {
    await service.getCampaignImpact('camp-cache', { ip: '198.51.100.42' });
  }
  await assert.rejects(
    () => service.getCampaignImpact('camp-cache', { ip: '198.51.100.42' }),
    err => err.status === 429
  );
});
