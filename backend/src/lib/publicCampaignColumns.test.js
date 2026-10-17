const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAMPAIGN_TABLE_COLUMNS,
  INTERNAL_CAMPAIGN_COLUMNS,
  PUBLIC_CAMPAIGN_COLUMNS,
  PUBLIC_CAMPAIGN_SELECT,
  publicCampaignColumnList,
  stripInternalCampaignFields,
} = require('./publicCampaignColumns');

// #899: the public campaign endpoints used to serialise `SELECT c.*`, handing
// every anonymous caller the fraud detector's output and the column reserved
// for the encrypted campaign wallet key.
const SECRET_COLUMNS = [
  'content_fingerprint',
  'fraud_score',
  'fraud_signals',
  'is_flagged_duplicate',
  'is_flagged_fraud',
  'wallet_secret_encrypted',
];

test('the public allowlist excludes every fraud/duplicate internal and the wallet key', () => {
  for (const column of SECRET_COLUMNS) {
    assert.equal(
      PUBLIC_CAMPAIGN_COLUMNS.includes(column),
      false,
      `${column} must not be in the public allowlist`
    );
    assert.equal(
      INTERNAL_CAMPAIGN_COLUMNS.includes(column),
      true,
      `${column} must be declared internal`
    );
  }
});

test('public and internal columns partition the campaigns table columns', () => {
  const union = [...PUBLIC_CAMPAIGN_COLUMNS, ...INTERNAL_CAMPAIGN_COLUMNS].sort();
  assert.deepEqual(union, [...CAMPAIGN_TABLE_COLUMNS].sort());
  assert.equal(
    PUBLIC_CAMPAIGN_COLUMNS.some(column => INTERNAL_CAMPAIGN_COLUMNS.includes(column)),
    false,
    'a column cannot be both public and internal'
  );
});

test('PUBLIC_CAMPAIGN_SELECT is an alias-prefixed allowlist with no `*`', () => {
  assert.equal(PUBLIC_CAMPAIGN_SELECT.includes('*'), false);
  assert.match(PUBLIC_CAMPAIGN_SELECT, /^c\.id,/);
  for (const column of INTERNAL_CAMPAIGN_COLUMNS) {
    assert.equal(
      PUBLIC_CAMPAIGN_SELECT.includes(`c.${column}`),
      false,
      `${column} must not appear in the generated SELECT`
    );
  }
});

test('publicCampaignColumnList supports an unaliased list for INSERT ... RETURNING', () => {
  const list = publicCampaignColumnList('');
  assert.match(list, /^id,/);
  assert.equal(list.includes('c.'), false);
});

test('stripInternalCampaignFields removes secrets while preserving public fields', () => {
  const row = {
    id: 'camp-1',
    title: 'Solar panels',
    raised_amount: '120',
    fraud_signals: { velocity: 'high' },
    fraud_score: 91,
    is_flagged_fraud: true,
    is_flagged_duplicate: true,
    content_fingerprint: 'fp',
    wallet_secret_encrypted: 'enc',
    search_vector: 'solar:1',
    refund_xdr: 'AAAA',
    creator_name: 'Ada',
  };

  const clean = stripInternalCampaignFields(row);

  assert.equal(clean.id, 'camp-1');
  assert.equal(clean.title, 'Solar panels');
  assert.equal(clean.creator_name, 'Ada');
  for (const column of INTERNAL_CAMPAIGN_COLUMNS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(clean, column),
      false,
      `${column} must be stripped`
    );
  }
  // The original row must not be mutated.
  assert.equal(row.fraud_score, 91);
  assert.equal(stripInternalCampaignFields(null), null);
});
