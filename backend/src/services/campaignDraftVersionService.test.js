'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const service = require('./campaignDraftVersionService');

function makeRunner({ campaign = null, version = null, versions = [] } = {}) {
  const calls = [];
  const inserts = [];
  return {
    calls,
    inserts,
    async query(sql, params) {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: text, params });
      if (text.includes('FROM campaigns') && text.includes('FOR UPDATE')) {
        return { rows: campaign ? [campaign] : [] };
      }
      if (text.startsWith('UPDATE campaigns')) {
        const nextVersion = Number(campaign?.draft_version || 1) + 1;
        return { rows: [{ draft_version: nextVersion, draft_saved_at: '2026-09-30T00:00:00.000Z' }] };
      }
      if (text.startsWith('INSERT INTO campaign_draft_versions')) {
        inserts.push(params);
        return { rows: [] };
      }
      if (text.includes('FROM campaign_draft_versions') && text.includes('snapshot')) {
        return { rows: version ? [version] : [] };
      }
      if (text.includes('FROM campaign_draft_versions')) {
        return { rows: versions };
      }
      return { rows: [] };
    },
  };
}

const currentCampaign = {
  id: 'c1',
  draft_version: 3,
  title: 'Old',
  description: 'Old desc',
  category: 'technology',
  target_amount: '1000',
  deadline: null,
  min_contribution: null,
  max_contribution: null,
  max_per_user: null,
  show_backer_amounts: true,
};

test('pickDraftSnapshot keeps only editable fields and drops secrets/transient state', () => {
  const snapshot = service.pickDraftSnapshot({
    title: 'New',
    description: 'd',
    wallet_public_key: 'GSECRET',
    wallet_secret_encrypted: 'cipher',
    status: 'active',
    raised_amount: '999',
    preview_token: 'tok',
    idempotency_key: 'k',
    unrelated: 1,
  });

  assert.deepEqual(snapshot, { title: 'New', description: 'd' });
});

test('hasMaterialChange ignores absent and non-editable fields', () => {
  assert.equal(service.hasMaterialChange(currentCampaign, { title: 'Old' }), false);
  assert.equal(service.hasMaterialChange(currentCampaign, { status: 'active' }), false);
  assert.equal(service.hasMaterialChange(currentCampaign, { title: 'New' }), true);
  assert.equal(service.hasMaterialChange(currentCampaign, { show_backer_amounts: false }), true);
});

test('assertNoConflict throws a 409 carrying the current version', () => {
  assert.doesNotThrow(() => service.assertNoConflict({ currentVersion: 4, expectedVersion: 4 }));
  assert.doesNotThrow(() => service.assertNoConflict({ currentVersion: 4, expectedVersion: undefined }));

  assert.throws(
    () => service.assertNoConflict({ currentVersion: 4, expectedVersion: 2 }),
    err => err.statusCode === 409 && err.code === 'DRAFT_VERSION_CONFLICT' && err.currentVersion === 4
  );
});

test('saveDraft applies fields, bumps the version and snapshots material edits', async () => {
  const runner = makeRunner({ campaign: currentCampaign });

  const result = await service.saveDraft({
    campaignId: 'c1',
    actorId: 'u1',
    fields: { title: 'New', description: 'Old desc', wallet_public_key: 'GSECRET' },
    expectedVersion: 3,
    runner,
  });

  assert.equal(result.materialChange, true);
  assert.equal(result.draftVersion, 4);

  const update = runner.calls.find(c => c.sql.startsWith('UPDATE campaigns'));
  // Only the editable fields the caller sent are written; the secret is never written.
  assert.ok(update.sql.includes('title = $2'));
  assert.ok(update.sql.includes('description = $3'));
  assert.ok(!update.sql.includes('wallet_public_key'));
  assert.deepEqual(update.params, ['c1', 'New', 'Old desc']);

  assert.equal(runner.inserts.length, 1);
  const [campaignId, actorId, version, reason, snapshot] = runner.inserts[0];
  assert.equal(campaignId, 'c1');
  assert.equal(actorId, 'u1');
  assert.equal(version, 4);
  assert.equal(reason, 'autosave');
  assert.deepEqual(JSON.parse(snapshot), {
    title: 'New',
    description: 'Old desc',
    category: 'technology',
    target_amount: '1000',
    deadline: null,
    min_contribution: null,
    max_contribution: null,
    max_per_user: null,
    show_backer_amounts: true,
  });
});

test('saveDraft does not snapshot a no-op autosave but still advances the counter', async () => {
  const runner = makeRunner({ campaign: currentCampaign });

  const result = await service.saveDraft({
    campaignId: 'c1',
    actorId: 'u1',
    fields: { title: 'Old' },
    expectedVersion: 3,
    runner,
  });

  assert.equal(result.materialChange, false);
  assert.equal(result.draftVersion, 4);
  assert.equal(runner.inserts.length, 0);
});

test('saveDraft rejects a stale version with 409 before updating', async () => {
  const runner = makeRunner({ campaign: currentCampaign });

  await assert.rejects(
    () => service.saveDraft({ campaignId: 'c1', actorId: 'u1', fields: { title: 'New' }, expectedVersion: 1, runner }),
    err => err.statusCode === 409 && err.currentVersion === 3
  );
  assert.equal(runner.calls.some(c => c.sql.startsWith('UPDATE campaigns')), false);
});

test('saveDraft rejects a missing campaign with 404', async () => {
  const runner = makeRunner({ campaign: null });
  await assert.rejects(
    () => service.saveDraft({ campaignId: 'missing', fields: { title: 'New' }, runner }),
    err => err.statusCode === 404
  );
});

test('restoreVersion applies the snapshot and records a new restore version', async () => {
  const runner = makeRunner({
    campaign: currentCampaign,
    version: {
      id: 'v2',
      campaign_id: 'c1',
      version: 2,
      reason: 'autosave',
      snapshot: { title: 'Restored title' },
    },
  });

  const result = await service.restoreVersion({
    campaignId: 'c1',
    versionId: 'v2',
    actorId: 'u1',
    runner,
  });

  assert.equal(result.restoredFrom, 2);
  assert.equal(result.draftVersion, 4);
  assert.equal(runner.inserts.length, 1);
  assert.equal(runner.inserts[0][3], 'restore');
});

test('restoreVersion rejects an unknown version with 404', async () => {
  const runner = makeRunner({ campaign: currentCampaign, version: null });
  await assert.rejects(
    () => service.restoreVersion({ campaignId: 'c1', versionId: 'nope', actorId: 'u1', runner }),
    err => err.statusCode === 404
  );
});
