const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function contributionRow(overrides = {}) {
  return {
    id: 'contrib-1',
    campaign_title: 'Solar Garden',
    contributor_name: 'Ada Lovelace',
    contributor_email: 'ada@example.com',
    amount: '25.00',
    asset: 'USDC',
    created_at: '2026-06-01T12:00:00.000Z',
    tx_hash: 'tx-hash',
    memo: 'thanks',
    network_fee: '0.01',
    platform_fee: '0.50',
    total_charged: '25.51',
    ...overrides,
  };
}

function loadService({ rows = [contributionRow()], exists = false, pdfError = null } = {}) {
  const queries = [];
  const uploads = [];
  const rendered = [];
  const storage = {
    exists: async key => {
      storage.existsKeys.push(key);
      return exists;
    },
    existsKeys: [],
    getSignedUrl: async key => `https://files.test/${key}`,
    upload: async (key, body, contentType) => {
      uploads.push({ key, body, contentType });
    },
  };

  const service = proxyquire('./contributionReceiptService', {
    '../config/database': {
      query: async (text, params) => {
        queries.push({ text, params });
        return { rows };
      },
    },
    './storage': storage,
    './taxReceiptPdf': {
      generateContributionReceiptPdf(data, callback) {
        rendered.push(data);
        if (pdfError) callback(pdfError);
        else callback(null, Buffer.from('%PDF-receipt'));
      },
    },
  });

  return { service, queries, uploads, rendered, storage };
}

test('getReceiptData returns the joined contribution row', async () => {
  const { service, queries } = loadService();
  const row = await service.getReceiptData('contrib-1');

  assert.equal(row.campaign_title, 'Solar Garden');
  assert.deepEqual(queries[0].params, ['contrib-1']);
  assert.match(queries[0].text, /FROM contributions/);
});

test('getReceiptData throws when the contribution is missing', async () => {
  const { service } = loadService({ rows: [] });
  await assert.rejects(() => service.getReceiptData('missing'), /Contribution not found/);
});

test('getOrCreateReceiptPdf returns the stored URL without regenerating', async () => {
  const { service, uploads, rendered, storage } = loadService({ exists: true });
  const url = await service.getOrCreateReceiptPdf('contrib-1');

  assert.equal(url, 'https://files.test/receipts/contrib-1.pdf');
  assert.deepEqual(storage.existsKeys, ['receipts/contrib-1.pdf']);
  assert.equal(uploads.length, 0);
  assert.equal(rendered.length, 0);
});

test('getOrCreateReceiptPdf builds, uploads, and signs a receipt when none is stored', async () => {
  const { service, uploads, rendered } = loadService();
  const url = await service.getOrCreateReceiptPdf('contrib-1');

  assert.equal(url, 'https://files.test/receipts/contrib-1.pdf');
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].campaignTitle, 'Solar Garden');
  assert.equal(rendered[0].contributorName, 'Ada Lovelace');
  assert.equal(rendered[0].contributorEmail, 'ada@example.com');
  assert.equal(rendered[0].amount, '25.00');
  assert.equal(rendered[0].asset, 'USDC');
  assert.equal(rendered[0].txHash, 'tx-hash');
  assert.equal(rendered[0].memo, 'thanks');
  assert.equal(rendered[0].networkFee, '0.01');
  assert.equal(rendered[0].platformFee, '0.50');
  assert.equal(rendered[0].totalCharged, '25.51');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].key, 'receipts/contrib-1.pdf');
  assert.equal(uploads[0].contentType, 'application/pdf');
  assert.equal(uploads[0].body.toString(), '%PDF-receipt');
});

test('getOrCreateReceiptPdf fills missing contributor and fee fields before rendering', async () => {
  const { service, rendered } = loadService({
    rows: [
      contributionRow({
        contributor_name: null,
        contributor_email: null,
        network_fee: null,
        platform_fee: null,
        total_charged: null,
        memo: null,
        tx_hash: null,
      }),
    ],
  });

  await service.getOrCreateReceiptPdf('contrib-1');

  assert.equal(rendered[0].contributorName, 'Contributor');
  assert.equal(rendered[0].contributorEmail, '');
  assert.equal(rendered[0].networkFee, '0');
  assert.equal(rendered[0].platformFee, '0');
  assert.equal(rendered[0].totalCharged, '25.00');
  assert.equal(rendered[0].memo, null);
  assert.equal(rendered[0].txHash, null);
});

test('getOrCreateReceiptPdf regenerates when forceRegenerate is set even if a file exists', async () => {
  const { service, uploads, storage } = loadService({ exists: true });
  const url = await service.getOrCreateReceiptPdf('contrib-1', true);

  assert.equal(url, 'https://files.test/receipts/contrib-1.pdf');
  assert.equal(storage.existsKeys.length, 0);
  assert.equal(uploads.length, 1);
});

test('getOrCreateReceiptPdf rejects when PDF generation fails and does not upload', async () => {
  const { service, uploads } = loadService({ pdfError: new Error('pdf failed') });
  await assert.rejects(() => service.getOrCreateReceiptPdf('contrib-1'), /pdf failed/);
  assert.equal(uploads.length, 0);
});
