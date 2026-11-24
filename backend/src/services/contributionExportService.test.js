'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  EXPORT_COLUMNS,
  csvCell,
  buildContributionExportRow,
  streamCampaignContributionExport,
} = require('./contributionExportService');

function createMockResponse({ failWriteOnce = false } = {}) {
  const headers = {};
  const chunks = [];
  let writeCount = 0;

  const res = Object.assign(new EventEmitter(), {
    headers,
    chunks,
    destroyed: false,
    writableEnded: false,
    setHeader(name, value) {
      headers[name] = value;
    },
    write(chunk) {
      if (this.destroyed || this.writableEnded) return false;
      chunks.push(chunk);
      writeCount++;
      if (failWriteOnce && writeCount === 1) {
        process.nextTick(() => {
          this.emit('drain');
        });
        return false;
      }
      return true;
    },
    end() {
      this.writableEnded = true;
      this.emit('finish');
    },
    destroy() {
      this.destroyed = true;
    },
  });

  return res;
}

test('contributionExportService - EXPORT_COLUMNS matches expected structure', () => {
  assert.deepEqual(EXPORT_COLUMNS, [
    'contributor_name',
    'display_name',
    'amount_usd',
    'amount_xlm',
    'tier',
    'contributed_at',
    'wallet_address',
  ]);
});

test('contributionExportService - csvCell neutralizes formula prefixes to prevent CSV injection', () => {
  // Formula prefixes: =, +, -, @ should be prepended with a single quote '
  assert.equal(csvCell('=SUM(A1:A10)'), "'=SUM(A1:A10)");
  assert.equal(csvCell('+12345'), "'+12345");
  assert.equal(csvCell('-cmd|/C calc!A0'), "'-cmd|/C calc!A0");
  assert.equal(csvCell('@SUM'), "'@SUM");

  // If a formula also contains CSV special characters like commas or quotes,
  // it should prefix with quote and wrap with double quotes
  assert.equal(csvCell('=1+2,test'), `"'=1+2,test"`);
  assert.equal(csvCell('=cmd|"exploit"'), `"'=cmd|""exploit"""`);
});

test('contributionExportService - csvCell handles escaping, null, and empty values', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(100), '100');
  assert.equal(csvCell('regular text'), 'regular text');
  assert.equal(csvCell('hello, world'), '"hello, world"');
  assert.equal(csvCell('hello "world"'), '"hello ""world"""');
  assert.equal(csvCell('multi\nline'), '"multi\nline"');
  assert.equal(csvCell('multi\r\nline'), '"multi\r\nline"');
});

test('contributionExportService - buildContributionExportRow handles anonymous privacy', () => {
  const row = {
    contributor_name: 'Alice',
    display_name: 'Alice D',
    sender_public_key: 'GAAAA111',
    amount: '100',
    asset: 'USDC',
    tier: 'Gold Tier',
    created_at: new Date('2026-01-01T00:00:00Z'),
    contributor_privacy: 'anonymous',
  };

  const exported = buildContributionExportRow(row);
  assert.deepEqual(exported, [
    '', // contributor_name hidden
    '', // display_name hidden
    '100', // amount_usd
    '', // amount_xlm
    'Gold Tier',
    '2026-01-01T00:00:00.000Z',
    '', // wallet_address hidden
  ]);
});

test('contributionExportService - buildContributionExportRow handles amount_only privacy', () => {
  const row = {
    contributor_name: 'Bob',
    display_name: 'Bob B',
    sender_public_key: 'GBBBB222',
    amount: '500',
    asset: 'XLM',
    tier: null,
    created_at: '2026-02-01T12:00:00Z',
    contributor_privacy: 'amount_only',
  };

  const exported = buildContributionExportRow(row);
  assert.deepEqual(exported, [
    '', // contributor_name hidden
    '', // display_name hidden
    '', // amount_usd
    '500', // amount_xlm
    '',
    '2026-02-01T12:00:00.000Z',
    '', // wallet_address hidden
  ]);
});

test('contributionExportService - buildContributionExportRow handles full privacy with public contributor', () => {
  const row = {
    contributor_name: 'Charlie',
    display_name: 'Charlie C',
    sender_public_key: 'GCCCC333',
    amount: '25',
    asset: 'USD',
    tier: 'Silver',
    created_at: new Date('2026-03-01T00:00:00Z'),
    contributor_privacy: 'full',
  };

  const exported = buildContributionExportRow(row);
  assert.deepEqual(exported, [
    'Charlie',
    'Charlie C',
    '25',
    '',
    'Silver',
    '2026-03-01T00:00:00.000Z',
    'GCCCC333',
  ]);
});

test('contributionExportService - buildContributionExportRow handles full privacy with empty display_name', () => {
  const row = {
    contributor_name: 'Secret User',
    display_name: '   ',
    sender_public_key: 'GDDDD444',
    source_amount: '120',
    source_asset: 'USDC',
    tier: '',
    created_at: 'invalid-date',
    contributor_privacy: 'full',
  };

  const exported = buildContributionExportRow(row);
  assert.deepEqual(exported, [
    '', // contributor_name hidden when display_name is empty
    '',
    '120',
    '',
    '',
    'invalid-date', // invalid timestamp falls back to String(value)
    '', // wallet_address hidden when display_name is empty
  ]);
});

test('contributionExportService - streamCampaignContributionExport exports empty campaign correctly', async () => {
  const res = createMockResponse();
  const queries = [];
  const runner = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };

  await streamCampaignContributionExport({
    campaignId: 'camp-123',
    res,
    runner,
    batchSize: 10,
  });

  assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.equal(
    res.headers['Content-Disposition'],
    'attachment; filename="campaign-camp-123-contributors.csv"'
  );
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.writableEnded, true);

  // Expect only header row
  assert.equal(res.chunks.length, 1);
  assert.equal(
    res.chunks[0],
    'contributor_name,display_name,amount_usd,amount_xlm,tier,contributed_at,wallet_address\n'
  );

  assert.equal(queries.length, 1);
  assert.equal(queries[0].params[0], 'camp-123');
  assert.equal(queries[0].params[1], 10); // batchSize
  assert.equal(queries[0].params[2], 0); // offset
});

test('contributionExportService - streamCampaignContributionExport paginates batches correctly', async () => {
  const res = createMockResponse();
  const queries = [];
  let pageCall = 0;

  const runner = {
    async query(sql, params) {
      queries.push({ sql, params });
      pageCall++;
      if (pageCall === 1) {
        // First batch: 2 items (equals batchSize)
        return {
          rows: [
            {
              contributor_name: 'User 1',
              display_name: 'U1',
              sender_public_key: 'KEY1',
              amount: '10',
              asset: 'USDC',
              created_at: '2026-01-01T00:00:00Z',
              contributor_privacy: 'full',
            },
            {
              contributor_name: 'User 2',
              display_name: 'U2',
              sender_public_key: 'KEY2',
              amount: '20',
              asset: 'XLM',
              created_at: '2026-01-02T00:00:00Z',
              contributor_privacy: 'full',
            },
          ],
        };
      }
      if (pageCall === 2) {
        // Second batch: 1 item (< batchSize, triggers termination)
        return {
          rows: [
            {
              contributor_name: 'User 3',
              display_name: 'U3',
              sender_public_key: 'KEY3',
              amount: '=FORMULA()', // formula injection test inside streaming
              asset: 'USDC',
              created_at: '2026-01-03T00:00:00Z',
              contributor_privacy: 'full',
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  await streamCampaignContributionExport({
    campaignId: 'camp/special@456',
    res,
    runner,
    batchSize: 2,
  });

  // Verify filename sanitization: special characters replaced with '_'
  assert.equal(
    res.headers['Content-Disposition'],
    'attachment; filename="campaign-camp_special_456-contributors.csv"'
  );
  assert.equal(res.writableEnded, true);

  assert.equal(queries.length, 2);
  assert.equal(queries[0].params[1], 2);
  assert.equal(queries[0].params[2], 0); // offset 0
  assert.equal(queries[1].params[1], 2);
  assert.equal(queries[1].params[2], 2); // offset 2

  // Chunks: 1 header + 2 in batch 1 + 1 in batch 2 = 4 chunks
  assert.equal(res.chunks.length, 4);
  assert.match(res.chunks[1], /User 1,U1,10/);
  assert.match(res.chunks[2], /User 2,U2,,20/);
  // Neutralized formula in chunk 3: '=FORMULA()
  assert.match(res.chunks[3], /User 3,U3,'=FORMULA\(\)/);
});

test('contributionExportService - streamCampaignContributionExport handles backpressure (drain)', async () => {
  const res = createMockResponse({ failWriteOnce: true });
  const runner = {
    async query() {
      return {
        rows: [
          {
            contributor_name: 'P1',
            display_name: 'D1',
            sender_public_key: 'K1',
            amount: '10',
            asset: 'USDC',
            created_at: '2026-01-01T00:00:00Z',
            contributor_privacy: 'full',
          },
        ],
      };
    },
  };

  await streamCampaignContributionExport({
    campaignId: 'camp-drain',
    res,
    runner,
    batchSize: 5,
  });

  assert.equal(res.writableEnded, true);
  assert.equal(res.chunks.length, 2);
});

test('contributionExportService - streamCampaignContributionExport stops if response is destroyed', async () => {
  const res = createMockResponse();
  let queryCount = 0;
  const runner = {
    async query() {
      queryCount++;
      res.destroy();
      return {
        rows: [
          {
            contributor_name: 'P1',
            display_name: 'D1',
            sender_public_key: 'K1',
            amount: '10',
            asset: 'USDC',
            created_at: '2026-01-01T00:00:00Z',
            contributor_privacy: 'full',
          },
        ],
      };
    },
  };

  await streamCampaignContributionExport({
    campaignId: 'camp-destroyed',
    res,
    runner,
    batchSize: 1,
  });

  assert.equal(queryCount, 1);
  assert.equal(res.destroyed, true);
});
