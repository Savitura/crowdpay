process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const proxyquire = require('proxyquire').noCallThru();

const USER_ID = 'creator-1';
const WALLET_PUBLIC_KEY = 'WBULK';
const CSV = `title,description,target_amount,asset_type,deadline,cover_image_url
"Valid Project","A description",1000,USDC,2028-01-01T00:00:00Z,"https://example.com/cover.png"
`;
const CSV_HASH = crypto.createHash('sha256').update(CSV).digest('hex');

function baseRow(overrides = {}) {
  return {
    title: 'Valid Campaign',
    description: 'A description',
    target_amount: '1000',
    asset_type: 'usdc',
    deadline: '2028-01-01T00:00:00Z',
    cover_image_url: 'https://example.com/cover.png',
    milestones: '',
    reward_tiers: '',
    ...overrides,
  };
}

function buildService(overrides = {}) {
  const calls = {
    queries: [],
    connects: 0,
    released: 0,
    logged: [],
  };

  const runQuery = async (text, params) => {
    calls.queries.push({ text, params });
    if (overrides.queryImpl) return overrides.queryImpl(text, params);
    return { rows: [] };
  };

  const service = proxyquire('./bulkCampaignService', {
    '../config/database': {
      query: runQuery,
      connect: async () => {
        calls.connects++;
        return {
          query: runQuery,
          release: () => {
            calls.released++;
          },
        };
      },
    },
    '../config/logger': {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: (...args) => calls.logged.push(args),
    },
    '@stellar/stellar-sdk': {
      Keypair: {
        random: () => ({ publicKey: () => WALLET_PUBLIC_KEY }),
      },
    },
  });

  return { service, calls };
}

function captureScheduledJobs(t) {
  const original = global.setImmediate;
  const scheduled = [];
  global.setImmediate = fn => {
    scheduled.push(fn);
    return scheduled.length;
  };
  t.after(() => {
    global.setImmediate = original;
  });
  return scheduled;
}

test('getCsvTemplate returns the documented CSV header and sample rows', () => {
  const { service } = buildService();
  const template = service.getCsvTemplate();

  assert.match(template, /title,description,target_amount,asset_type/);
  assert.match(template, /Clean Water Project/);
  assert.match(template, /Community Library/);
});

test('parseCsv lowercases headers and preserves commas inside quoted cells', () => {
  const { service } = buildService();

  const rows = service.parseCsv('Title,Target_Amount,Asset_Type\n"My, Campaign",100,USDC\n');

  assert.deepEqual(rows, [{ title: 'My, Campaign', target_amount: '100', asset_type: 'USDC' }]);
});

test('parseCsv handles escaped quotes, quoted newlines, CRLF and missing trailing columns', () => {
  const { service } = buildService();

  const rows = service.parseCsv(
    'title,description,target_amount\r\n"Say ""Hi""","line1\nline2",250\r\n"Only title"\r\n'
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    title: 'Say "Hi"',
    description: 'line1\nline2',
    target_amount: '250',
  });
  assert.deepEqual(rows[1], { title: 'Only title', description: '', target_amount: '' });
});

test('parseCsv returns no rows for header-only, empty or non-string input', () => {
  const { service } = buildService();

  assert.deepEqual(service.parseCsv('title,target_amount\n'), []);
  assert.deepEqual(service.parseCsv(''), []);
  assert.deepEqual(service.parseCsv(null), []);
  assert.deepEqual(service.parseCsv(undefined), []);
  assert.deepEqual(service.parseCsv(42), []);
});

test('validateCampaignRow accepts a complete row with case-insensitive asset type', () => {
  const { service } = buildService();

  assert.deepEqual(service.validateCampaignRow(baseRow(), 1), []);
});

test('validateCampaignRow reports required-field, amount, asset, deadline and URL errors', () => {
  const { service } = buildService();

  const errors = service.validateCampaignRow(
    baseRow({
      title: '',
      target_amount: 'abc',
      asset_type: 'BTC',
      deadline: 'yesterday',
      cover_image_url: 'ftp://example.com/cover.png',
    }),
    7
  );

  assert.deepEqual(
    errors.map(e => e.field),
    ['title', 'target_amount', 'asset_type', 'deadline', 'cover_image_url']
  );
  assert.ok(errors.every(e => e.row === 7));

  assert.equal(
    service.validateCampaignRow(baseRow({ title: 'x'.repeat(121) }), 1)[0].field,
    'title'
  );
  assert.ok(
    service
      .validateCampaignRow(baseRow({ deadline: '2020-01-01T00:00:00Z' }), 1)
      .some(e => e.field === 'deadline' && /in the future/.test(e.reason))
  );
  assert.deepEqual(service.validateCampaignRow(baseRow({ deadline: '' }), 1), []);
});

test('validateCampaignRow validates milestone JSON structure, limits and percentages', () => {
  const { service } = buildService();

  assert.ok(
    service
      .validateCampaignRow(baseRow({ milestones: '{not json' }), 1)
      .some(e => e.field === 'milestones' && /valid JSON/.test(e.reason))
  );
  assert.ok(
    service
      .validateCampaignRow(baseRow({ milestones: '{}' }), 1)
      .some(e => e.field === 'milestones' && /must be a JSON array/.test(e.reason))
  );

  const sixMilestones = Array.from({ length: 6 }, () => ({
    title: 'Phase',
    description: 'Work',
    release_percentage: '16.6667',
  }));
  assert.ok(
    service
      .validateCampaignRow(baseRow({ milestones: JSON.stringify(sixMilestones) }), 1)
      .some(e => e.field === 'milestones' && /At most 5 milestones/.test(e.reason))
  );

  const incomplete = service.validateCampaignRow(
    baseRow({
      milestones: JSON.stringify([{ title: 'Phase', description: '', release_percentage: '20' }]),
    }),
    1
  );
  assert.ok(incomplete.some(e => /requires title and description/.test(e.reason)));
  assert.ok(incomplete.some(e => /must sum to 100%/.test(e.reason)));

  const valid = [
    { title: 'Phase 1', description: 'Work', release_percentage: 40 },
    { title: 'Phase 2', description: 'Work', release_percentage: 60 },
  ];
  assert.deepEqual(
    service.validateCampaignRow(baseRow({ milestones: JSON.stringify(valid) }), 1),
    []
  );
});

test('validateCampaignRow validates reward tier JSON structure and amounts', () => {
  const { service } = buildService();

  assert.ok(
    service
      .validateCampaignRow(baseRow({ reward_tiers: '[{' }), 1)
      .some(e => e.field === 'reward_tiers' && /valid JSON/.test(e.reason))
  );
  assert.ok(
    service
      .validateCampaignRow(baseRow({ reward_tiers: '{}' }), 1)
      .some(e => e.field === 'reward_tiers' && /must be a JSON array/.test(e.reason))
  );

  const errors = service.validateCampaignRow(
    baseRow({ reward_tiers: JSON.stringify([{ title: '', amount: 0 }]) }),
    1
  );
  assert.ok(errors.some(e => /requires a title/.test(e.reason)));
  assert.ok(errors.some(e => /amount must be > 0/.test(e.reason)));

  const valid = [{ title: 'Supporter', description: 'Thanks', amount: 50 }];
  assert.deepEqual(
    service.validateCampaignRow(baseRow({ reward_tiers: JSON.stringify(valid) }), 1),
    []
  );
});

test('validateAllRows aggregates per-row validity into a report', () => {
  const { service } = buildService();

  const allValid = service.validateAllRows([baseRow(), baseRow({ title: 'Second' })]);
  assert.equal(allValid.valid, true);
  assert.equal(allValid.total_rows, 2);
  assert.equal(allValid.valid_rows, 2);
  assert.equal(allValid.invalid_rows, 0);
  assert.deepEqual(allValid.errors, []);

  const mixed = service.validateAllRows([baseRow(), baseRow({ title: '' })]);
  assert.equal(mixed.valid, false);
  assert.equal(mixed.total_rows, 2);
  assert.equal(mixed.valid_rows, 1);
  assert.equal(mixed.invalid_rows, 1);
  assert.ok(mixed.errors.some(e => e.row === 2 && e.field === 'title'));
});

test('createImportJob returns the existing job for a repeated idempotency key', async t => {
  const scheduled = captureScheduledJobs(t);
  const existing = { id: 'job-existing', idempotency_key: 'key-1' };
  const { service, calls } = buildService({
    queryImpl: async text =>
      text.includes('WHERE idempotency_key = $1') ? { rows: [existing] } : { rows: [] },
  });

  const job = await service.createImportJob({
    userId: USER_ID,
    csvContent: CSV,
    idempotencyKey: 'key-1',
  });

  assert.equal(job, existing);
  const keyQuery = calls.queries.find(q => q.text.includes('WHERE idempotency_key = $1'));
  assert.deepEqual(keyQuery.params, ['key-1', USER_ID]);
  assert.ok(!calls.queries.some(q => q.text.includes('content_hash = $1')));
  assert.ok(!calls.queries.some(q => q.text.includes('INSERT INTO bulk_campaign_imports')));
  assert.equal(scheduled.length, 0);
});

test('createImportJob deduplicates by content hash when no idempotency key is supplied', async t => {
  const scheduled = captureScheduledJobs(t);
  const existing = { id: 'job-by-hash' };
  const { service, calls } = buildService({
    queryImpl: async text =>
      text.includes('WHERE content_hash = $1') ? { rows: [existing] } : { rows: [] },
  });

  const job = await service.createImportJob({ userId: USER_ID, csvContent: CSV });

  assert.equal(job, existing);
  const hashQuery = calls.queries.find(q => q.text.includes('WHERE content_hash = $1'));
  assert.deepEqual(hashQuery.params, [CSV_HASH, USER_ID]);
  assert.match(hashQuery.text, /24 hours/);
  assert.ok(!calls.queries.some(q => q.text.includes('INSERT INTO bulk_campaign_imports')));
  assert.equal(scheduled.length, 0);
});

test('createImportJob rejects a CSV with no data rows and does not create a job', async t => {
  const scheduled = captureScheduledJobs(t);
  const { service, calls } = buildService();

  await assert.rejects(
    () => service.createImportJob({ userId: USER_ID, csvContent: 'title,target_amount\n' }),
    err => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /empty/);
      return true;
    }
  );

  assert.ok(!calls.queries.some(q => q.text.includes('INSERT INTO bulk_campaign_imports')));
  assert.equal(scheduled.length, 0);
});

test('createImportJob inserts a job, writes an audit entry and schedules background execution', async t => {
  const scheduled = captureScheduledJobs(t);
  const inserted = { id: 'job-new', status: 'processing' };
  const { service, calls } = buildService({
    queryImpl: async text =>
      text.includes('INSERT INTO bulk_campaign_imports') ? { rows: [inserted] } : { rows: [] },
  });

  const job = await service.createImportJob({
    userId: USER_ID,
    csvContent: CSV,
    idempotencyKey: 'key-2',
  });

  assert.equal(job, inserted);
  const insert = calls.queries.find(q => q.text.includes('INSERT INTO bulk_campaign_imports'));
  assert.equal(insert.params[0], USER_ID);
  assert.equal(insert.params[1], 'key-2');
  assert.equal(insert.params[2], CSV_HASH);
  assert.equal(insert.params[3], 1);
  assert.deepEqual(JSON.parse(insert.params[4]), []);

  const audit = calls.queries.find(q => q.text.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(audit.params[0], 'bulk_campaign_import_started');
  assert.equal(audit.params[1], USER_ID);
  assert.equal(audit.params[3], inserted.id);
  assert.deepEqual(JSON.parse(audit.params[4]), { total_rows: 1, content_hash: CSV_HASH });

  assert.equal(scheduled.length, 1);
  assert.equal(typeof scheduled[0], 'function');
});

test('executeImportJob commits valid rows, skips invalid rows and stores final counts', async () => {
  const milestones = [{ title: 'Phase 1', description: 'Build', release_percentage: 100 }];
  const rows = [
    baseRow({ title: 'Good', milestones: JSON.stringify(milestones) }),
    baseRow({ title: '' }),
    baseRow({ title: 'Another' }),
  ];
  let finalUpdate;
  const { service, calls } = buildService({
    queryImpl: async (text, params) => {
      if (text.includes('INSERT INTO campaigns')) {
        return { rows: [{ id: `camp-${params[1]}`, title: params[1] }] };
      }
      if (text.includes('UPDATE bulk_campaign_imports')) {
        finalUpdate = { params };
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  await service.executeImportJob('job-1', USER_ID, rows);

  assert.equal(calls.connects, 2);
  assert.equal(calls.released, 2);
  assert.equal(finalUpdate.params[0], 3);
  assert.equal(finalUpdate.params[1], 2);
  assert.equal(finalUpdate.params[2], 1);

  const results = JSON.parse(finalUpdate.params[3]);
  assert.deepEqual(
    results.map(r => r.success),
    [true, false, true]
  );
  assert.equal(results[0].campaign_id, 'camp-Good');
  assert.ok(results[1].errors.some(e => /Title is required/.test(e)));

  const campaigns = calls.queries.filter(q => q.text.includes('INSERT INTO campaigns'));
  assert.equal(campaigns.length, 2);
  assert.equal(campaigns[0].params[0], USER_ID);
  assert.equal(campaigns[0].params[3], '1000.0000000');
  assert.equal(campaigns[0].params[4], 'USDC');
  assert.equal(campaigns[0].params[5], '2028-01-01T00:00:00.000Z');
  assert.equal(campaigns[0].params[7], 'general');
  assert.equal(campaigns[0].params[11], WALLET_PUBLIC_KEY);

  const milestoneInsert = calls.queries.find(q => q.text.includes('INSERT INTO milestones'));
  assert.deepEqual(milestoneInsert.params, ['camp-Good', 'Phase 1', 'Build', '100.0000', 0]);
});

test('executeImportJob rolls back a failed row and still completes the job', async () => {
  const { service, calls } = buildService({
    queryImpl: async text => {
      if (text.includes('INSERT INTO campaigns')) throw new Error('db unavailable');
      return { rows: [] };
    },
  });

  await service.executeImportJob('job-2', USER_ID, [baseRow()]);

  const texts = calls.queries.map(q => q.text);
  assert.ok(texts.includes('BEGIN'));
  assert.ok(texts.includes('ROLLBACK'));
  assert.ok(!texts.includes('COMMIT'));
  assert.equal(calls.released, 1);
  assert.ok(
    calls.logged.some(args => /Failed to create campaign in bulk row/.test(String(args[0])))
  );

  const finalUpdate = calls.queries.find(q => q.text.includes('UPDATE bulk_campaign_imports'));
  assert.equal(finalUpdate.params[0], 1);
  assert.equal(finalUpdate.params[1], 0);
  assert.equal(finalUpdate.params[2], 1);
});

test('getImportJob returns a user-scoped job or a 404 when it is missing', async () => {
  const job = { id: 'job-3', user_id: USER_ID, status: 'completed' };
  const found = buildService({
    queryImpl: async text =>
      text.includes('FROM bulk_campaign_imports') ? { rows: [job] } : { rows: [] },
  });
  assert.equal(await found.service.getImportJob('job-3', USER_ID), job);
  assert.deepEqual(found.calls.queries[0].params, ['job-3', USER_ID]);

  const missing = buildService();
  await assert.rejects(
    () => missing.service.getImportJob('missing', USER_ID),
    err => {
      assert.equal(err.statusCode, 404);
      assert.match(err.message, /not found/);
      return true;
    }
  );
});
