'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ATTRIBUTION_MODES,
  normalizeAttributionMode,
  accountPrivacyToAttributionMode,
  resolveStoredAttributionMode,
  serializePublicAttribution,
  setContributionAttribution,
} = require('./contributionAttributionService');

test('normalizeAttributionMode defaults and validates', () => {
  assert.equal(normalizeAttributionMode(undefined), 'public');
  assert.equal(normalizeAttributionMode(null), 'public');
  assert.equal(normalizeAttributionMode(''), 'public');
  assert.equal(normalizeAttributionMode('anonymous'), 'anonymous');
  assert.deepEqual(ATTRIBUTION_MODES, ['public', 'display_name', 'anonymous']);
  assert.throws(() => normalizeAttributionMode('secret'), /attribution_mode must be one of/);
});

test('accountPrivacyToAttributionMode maps legacy values', () => {
  assert.equal(accountPrivacyToAttributionMode('full'), 'public');
  assert.equal(accountPrivacyToAttributionMode(undefined), 'public');
  assert.equal(accountPrivacyToAttributionMode('amount_only'), 'anonymous');
  assert.equal(accountPrivacyToAttributionMode('anonymous'), 'anonymous');
  assert.equal(accountPrivacyToAttributionMode('display_name'), 'display_name');
});

test('resolveStoredAttributionMode keeps the more private of the two', () => {
  // Requested public but account is anonymous -> stays anonymous.
  assert.equal(
    resolveStoredAttributionMode({ requestedMode: 'public', contributorPrivacy: 'anonymous' }),
    'anonymous'
  );
  // Requested anonymous but account is public -> anonymous wins.
  assert.equal(
    resolveStoredAttributionMode({ requestedMode: 'anonymous', contributorPrivacy: 'full' }),
    'anonymous'
  );
  // Requested display_name, account public -> display_name.
  assert.equal(
    resolveStoredAttributionMode({ requestedMode: 'display_name', contributorPrivacy: 'full' }),
    'display_name'
  );
  // Requested public, account public -> public.
  assert.equal(
    resolveStoredAttributionMode({ requestedMode: 'public', contributorPrivacy: 'full' }),
    'public'
  );
});

test('serializePublicAttribution hides private fields per mode', () => {
  const row = {
    display_name: 'Ada',
    sender_public_key: 'GADA',
    amount: '100',
    asset: 'XLM',
    created_at: '2026-09-30T00:00:00.000Z',
  };

  assert.deepEqual(serializePublicAttribution({ ...row, attribution_mode: 'public' }), {
    display_name: 'Ada',
    sender_public_key: 'GADA',
    amount: '100',
    asset: 'XLM',
    created_at: '2026-09-30T00:00:00.000Z',
    contributor_privacy: 'public',
  });

  assert.deepEqual(serializePublicAttribution({ ...row, attribution_mode: 'display_name' }), {
    display_name: 'Ada',
    sender_public_key: null,
    amount: '100',
    asset: 'XLM',
    created_at: '2026-09-30T00:00:00.000Z',
    contributor_privacy: 'display_name',
  });

  assert.deepEqual(serializePublicAttribution({ ...row, attribution_mode: 'anonymous' }), {
    display_name: null,
    sender_public_key: null,
    amount: '100',
    asset: 'XLM',
    created_at: '2026-09-30T00:00:00.000Z',
    contributor_privacy: 'anonymous',
  });
});

test('serializePublicAttribution respects showAmount while keeping identity hidden', () => {
  const result = serializePublicAttribution(
    { attribution_mode: 'anonymous', display_name: 'Ada', sender_public_key: 'G', amount: '5', asset: 'XLM' },
    { showAmount: false }
  );
  assert.equal(result.amount, null);
  assert.equal(result.sender_public_key, null);
  assert.equal(result.display_name, null);
});

function makeRunner({ contribution, walletPublicKey, updated }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('FROM contributions')) {
        return { rows: contribution ? [contribution] : [] };
      }
      if (sql.includes('FROM users')) {
        return { rows: walletPublicKey ? [{ wallet_public_key: walletPublicKey }] : [] };
      }
      if (sql.includes('UPDATE contributions')) {
        return { rows: [updated] };
      }
      return { rows: [] };
    },
  };
}

test('setContributionAttribution updates the contributor\'s own contribution', async () => {
  const runner = makeRunner({
    contribution: {
      id: 'c1',
      sender_public_key: 'GADA',
      display_name: null,
      attribution_mode: 'public',
    },
    walletPublicKey: 'GADA',
    updated: {
      id: 'c1',
      campaign_id: 'camp1',
      display_name: 'Ada',
      sender_public_key: 'GADA',
      attribution_mode: 'display_name',
      amount: '100',
      asset: 'XLM',
      created_at: '2026-09-30T00:00:00.000Z',
    },
  });

  const result = await setContributionAttribution({
    contributionId: 'c1',
    userId: 'u1',
    mode: 'display_name',
    displayName: 'Ada',
    runner,
  });

  assert.equal(result.attribution_mode, 'display_name');
  assert.equal(result.display_name, 'Ada');
  const update = runner.calls.find(c => c.sql.includes('UPDATE contributions'));
  assert.deepEqual(update.params, ['display_name', 'Ada', 'c1']);
});

test('setContributionAttribution nulls the display name for anonymous', async () => {
  const runner = makeRunner({
    contribution: { id: 'c1', sender_public_key: 'GADA', display_name: 'Ada', attribution_mode: 'public' },
    walletPublicKey: 'GADA',
    updated: { id: 'c1', campaign_id: 'camp1', display_name: null, attribution_mode: 'anonymous' },
  });

  await setContributionAttribution({
    contributionId: 'c1',
    userId: 'u1',
    mode: 'anonymous',
    displayName: 'Ada',
    runner,
  });

  const update = runner.calls.find(c => c.sql.includes('UPDATE contributions'));
  assert.deepEqual(update.params, ['anonymous', null, 'c1']);
});

test('setContributionAttribution rejects someone else\'s contribution', async () => {
  const runner = makeRunner({
    contribution: { id: 'c1', sender_public_key: 'GOTHER', display_name: null, attribution_mode: 'public' },
    walletPublicKey: 'GADA',
  });

  await assert.rejects(
    () => setContributionAttribution({ contributionId: 'c1', userId: 'u1', mode: 'anonymous', runner }),
    err => err.statusCode === 403
  );
});

test('setContributionAttribution rejects a missing contribution', async () => {
  const runner = makeRunner({ contribution: null, walletPublicKey: 'GADA' });

  await assert.rejects(
    () => setContributionAttribution({ contributionId: 'missing', userId: 'u1', mode: 'public', runner }),
    err => err.statusCode === 404
  );
});
