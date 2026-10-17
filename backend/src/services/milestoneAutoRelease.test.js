const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const proxyquire = require('proxyquire').noCallThru();

process.env.STORAGE_ENDPOINT = 'https://storage.test';
process.env.STORAGE_BUCKET = 'evidence';

const { toReleaseAmount } = require('./milestoneLedger');
const storage = require('./storage');

const autoRelease = proxyquire('./milestoneAutoRelease', {
  '../config/database': {},
  '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
  './stellarService': {},
  './stellarTransactionService': {},
  './walletSecrets': { withDecryptedWalletSecret: async (_c, _ctx, fn) => fn('SCREATOR') },
  './storage': storage,
  './auditService': { sanitizeMetadata: m => m },
  './alerting': { sendAlert: () => {} },
});

const HOUR = 3600 * 1000;
const T0 = new Date('2026-10-01T00:00:00Z');
const MILESTONE_ID = '22222222-2222-2222-2222-222222222222';
const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const DESTINATION = 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK';
const SHA = 'a'.repeat(64);

function evidenceUrl(milestoneId = MILESTONE_ID, sha = SHA) {
  return `https://storage.test/evidence/${encodeURIComponent(`milestones/${milestoneId}/${sha}.png`)}`;
}

function scheduledMilestone(overrides = {}) {
  const url = evidenceUrl();
  return {
    id: MILESTONE_ID,
    campaign_id: CAMPAIGN_ID,
    title: 'Ship v1',
    status: 'pending_review',
    release_percentage: '50.0000',
    destination_key: DESTINATION,
    evidence_url: url,
    claimed_at: null,
    auto_release_enabled: true,
    auto_release_rule: 'platform_evidence',
    auto_release_rule_config: {},
    auto_release_window_seconds: 72 * 3600,
    auto_release_status: 'scheduled',
    auto_release_scheduled_at: T0,
    auto_release_at: new Date(T0.getTime() + 72 * HOUR),
    auto_release_evidence_url: url,
    auto_release_evidence_sha256: SHA,
    // campaign columns joined in by the SQL repository
    campaign_status: 'funded',
    raised_amount: '1000',
    asset_type: 'USDC',
    campaign_wallet_public_key: 'GCAMPAIGN',
    creator_id: 'creator-1',
    ...overrides,
  };
}

/**
 * In-memory stand-in for createSqlRepository with the same contract: every
 * state change is guarded by the same preconditions the SQL uses, and nothing
 * lives in the worker's memory, so "restarting" is just calling
 * processAutoReleases again with fresh deps.
 */
function createFakeRepo({ milestones = [scheduledMilestone()], clock }) {
  const state = {
    milestones: new Map(milestones.map(m => [m.id, { ...m }])),
    attempts: new Map(),
    disputes: [],
    votes: new Map(),
    events: [],
    audit: [],
    withdrawals: [],
  };
  const now = () => clock.now;
  const inflight = a => ['claimed', 'prepared', 'submitted'].includes(a.status);
  const leaseFree = a => !a.lease_until || a.lease_until < now();
  const openDisputes = campaignId =>
    state.disputes.filter(
      d => d.campaign_id === campaignId && ['open', 'under_review'].includes(d.status)
    ).length;
  let seq = 0;

  const repo = {
    state,
    async listDue(limit) {
      return [...state.milestones.values()]
        .filter(m => m.auto_release_status === 'scheduled' && new Date(m.auto_release_at) <= now())
        .slice(0, limit)
        .map(m => ({ id: m.id, auto_release_evidence_url: m.auto_release_evidence_url }));
    },
    async listRecoverable(limit) {
      return [...state.attempts.values()]
        .filter(a => inflight(a) && leaseFree(a))
        .slice(0, limit)
        .map(a => ({ id: a.id }));
    },
    async loadContext(milestoneId) {
      const m = state.milestones.get(milestoneId);
      return m ? { milestone: { ...m }, openDisputeCount: openDisputes(m.campaign_id) } : null;
    },
    async claimDue(milestoneId, decide) {
      const m = state.milestones.get(milestoneId);
      const siblings = [...state.milestones.values()].filter(x => x.campaign_id === m.campaign_id);
      const votes = state.votes.get(milestoneId) || { approve: 0, reject: 0 };
      const ctx = {
        milestone: { ...m },
        openDisputeCount: openDisputes(m.campaign_id),
        tally: {
          approve_count: votes.approve,
          reject_count: votes.reject,
          total_votes: votes.approve + votes.reject,
        },
        totalPercentage: siblings.reduce((s, x) => s + Number(x.release_percentage), 0),
        releasedPercentage: siblings
          .filter(x => x.status === 'released')
          .reduce((s, x) => s + Number(x.release_percentage), 0),
        attemptExists: [...state.attempts.values()].some(a => a.milestone_id === milestoneId),
      };
      const decision = decide(ctx);
      if (decision.action === 'halt') {
        Object.assign(m, {
          auto_release_status: 'halted',
          auto_release_halt_reason: decision.reason,
        });
        state.events.push({ milestoneId, action: 'auto_release_halted', note: decision.reason });
        return { ...decision, ctx };
      }
      if (decision.action !== 'claim') return { ...decision, ctx };
      if (
        m.auto_release_status !== 'scheduled' ||
        m.claimed_at ||
        new Date(m.auto_release_at) > now()
      ) {
        return { action: 'skip', reason: 'window_open', ctx };
      }
      Object.assign(m, { auto_release_status: 'releasing', claimed_at: now() });
      const attempt = {
        id: `attempt-${++seq}`,
        milestone_id: m.id,
        campaign_id: m.campaign_id,
        rule: m.auto_release_rule,
        rule_config: m.auto_release_rule_config,
        window_seconds: m.auto_release_window_seconds,
        amount: toReleaseAmount(m.raised_amount, m.release_percentage),
        destination_key: m.destination_key,
        status: 'claimed',
        lease_until: new Date(now().getTime() + 5 * 60 * 1000),
      };
      state.attempts.set(attempt.id, attempt);
      return { action: 'claim', ctx, attempt: { ...attempt } };
    },
    async leaseAttempt(id) {
      const a = state.attempts.get(id);
      if (!a || !inflight(a) || !leaseFree(a)) return null;
      a.lease_until = new Date(now().getTime() + 5 * 60 * 1000);
      return { ...a };
    },
    async prepareAttempt(id, { signedXdr, txHash }) {
      const a = state.attempts.get(id);
      if (a.status !== 'claimed') return null;
      Object.assign(a, { status: 'prepared', signed_xdr: signedXdr, tx_hash: txHash });
      return { ...a };
    },
    async markSubmitted(id) {
      const a = state.attempts.get(id);
      if (!['prepared', 'submitted'].includes(a.status)) return null;
      a.status = 'submitted';
      return { ...a };
    },
    async failAttempt(id, reason) {
      const a = state.attempts.get(id);
      if (!inflight(a)) return null;
      Object.assign(a, { status: 'failed', failure_reason: reason, lease_until: null });
      const m = state.milestones.get(a.milestone_id);
      if (m.status === 'pending_review') {
        Object.assign(m, {
          auto_release_status: 'failed',
          auto_release_halt_reason: reason,
          claimed_at: null,
        });
      }
      return { ...a };
    },
    async finalizeRelease(id) {
      if (repo.crashNextFinalize) {
        repo.crashNextFinalize = false;
        throw new Error('simulated crash before the release was recorded');
      }
      const a = state.attempts.get(id);
      if (a.status === 'confirmed') return { alreadyFinal: true, attempt: { ...a } };
      const m = state.milestones.get(a.milestone_id);
      const withdrawalRequest = {
        id: `wr-${a.id}`,
        amount: a.amount,
        tx_hash: a.tx_hash,
        milestone_id: m.id,
      };
      state.withdrawals.push(withdrawalRequest);
      Object.assign(m, {
        status: 'released',
        release_trigger: 'auto',
        auto_release_status: 'released',
      });
      const meta = {
        trigger: 'automatic',
        rule: a.rule,
        rule_config: a.rule_config,
        tx_hash: a.tx_hash,
      };
      state.events.push({ milestoneId: m.id, action: 'auto_released', metadata: meta });
      state.audit.push({
        action: 'milestone.auto_released',
        resource_id: m.id,
        metadata: { release_mode: 'automatic', ...meta },
      });
      Object.assign(a, { status: 'confirmed', lease_until: null });
      return { attempt: { ...a }, milestone: { ...m }, withdrawalRequest };
    },
    async haltScheduled({ campaignId, disputeId }) {
      state.disputes.push({ id: disputeId, campaign_id: campaignId, status: 'open' });
      const halted = [];
      for (const m of state.milestones.values()) {
        if (m.campaign_id === campaignId && m.auto_release_status === 'scheduled') {
          Object.assign(m, {
            auto_release_status: 'halted',
            auto_release_halt_reason: 'dispute_opened',
            auto_release_dispute_id: disputeId,
          });
          halted.push(m.id);
        }
      }
      return halted;
    },
  };
  return repo;
}

/** Stellar double: a "ledger" keyed by hash, so resubmitting a landed envelope is rejected like tx_bad_seq. */
function createFakeStellar() {
  const s = {
    ledger: new Map(),
    submissions: [],
    built: 0,
    expired: false,
    loseResponseOnce: false,
    async buildWithdrawalTransaction(args) {
      s.built += 1;
      return JSON.stringify({
        amount: args.amount,
        destination: args.destinationPublicKey,
        n: s.built,
        sigs: [],
      });
    },
    signTransactionXdr({ xdr, signerSecret }) {
      const tx = JSON.parse(xdr);
      tx.sigs.push(signerSecret ? 'signed' : 'missing');
      return JSON.stringify(tx);
    },
    signatureCountFromXdr: xdr => JSON.parse(xdr).sigs.length,
    transactionHashFromXdr: xdr => `hash-${JSON.parse(xdr).n}`,
    async submitSignedWithdrawal({ xdr }) {
      const hash = s.transactionHashFromXdr(xdr);
      s.submissions.push(hash);
      if (s.ledger.has(hash)) {
        const err = new Error('tx_bad_seq');
        err.definitive = true;
        throw err;
      }
      s.ledger.set(hash, 'success');
      if (s.loseResponseOnce) {
        s.loseResponseOnce = false;
        throw new Error('504 Gateway Timeout');
      }
      return hash;
    },
    getTransactionOutcome: async hash => s.ledger.get(hash) || 'not_found',
    isDefinitiveSubmissionFailure: err => !!err.definitive,
    isXdrExpired: () => s.expired,
  };
  return s;
}

function setup(options = {}) {
  const clock = { now: new Date(T0.getTime() + HOUR) };
  const repo = createFakeRepo({ clock, ...options });
  const stellar = createFakeStellar();
  const released = [];
  const deps = () => ({
    stellar,
    withDecryptedWalletSecret: async (_c, _ctx, fn) => fn('SCREATOR'),
    evidenceExists: async () => true,
    afterRelease: async result => released.push(result),
    alert: () => {},
  });
  const run = () => autoRelease.processAutoReleases({ repo, deps: deps(), now: () => clock.now });
  return {
    clock,
    repo,
    stellar,
    released,
    run,
    milestone: () => repo.state.milestones.get(MILESTONE_ID),
  };
}

// ─── Release fires ───────────────────────────────────────────────────

test('release fires once the dispute window elapses, and not before', async () => {
  const { clock, repo, stellar, released, run, milestone } = setup();

  assert.deepEqual(await run(), [], 'nothing is due inside the window');
  clock.now = new Date(T0.getTime() + 72 * HOUR - 1000);
  assert.deepEqual(await run(), []);
  assert.equal(stellar.submissions.length, 0);

  clock.now = new Date(T0.getTime() + 72 * HOUR + 1000);
  const results = await run();

  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'released');
  assert.equal(stellar.submissions.length, 1);
  assert.equal(milestone().status, 'released');
  assert.equal(milestone().release_trigger, 'auto');
  assert.equal(repo.state.withdrawals.length, 1);
  assert.equal(repo.state.withdrawals[0].amount, '500.0000000', '50% of 1000 raised');
  assert.equal(released.length, 1, 'post-release notifications fire once');

  // Audit trail: distinguishable from a manual release and names the rule.
  const audit = repo.state.audit.find(row => row.action === 'milestone.auto_released');
  assert.equal(audit.metadata.release_mode, 'automatic');
  assert.equal(audit.metadata.rule, 'platform_evidence');
  assert.ok(
    repo.state.events.some(
      e => e.action === 'auto_released' && e.metadata.rule === 'platform_evidence'
    )
  );

  // Later ticks are no-ops: no second payout.
  clock.now = new Date(clock.now.getTime() + HOUR);
  assert.deepEqual(await run(), []);
  assert.equal(stellar.submissions.length, 1);
});

test('backer_approval rule waits for its quorum and halts without it', async () => {
  const { clock, repo, stellar, run, milestone } = setup({
    milestones: [
      scheduledMilestone({
        auto_release_rule: 'backer_approval',
        auto_release_rule_config: { min_approvals: 2 },
      }),
    ],
  });
  repo.state.votes.set(MILESTONE_ID, { approve: 1, reject: 0 });
  clock.now = new Date(T0.getTime() + 73 * HOUR);

  const [result] = await run();
  assert.equal(result.outcome, 'halted');
  assert.equal(result.reason, 'backer_approval_quorum_not_met');
  assert.equal(milestone().auto_release_status, 'halted');
  assert.equal(stellar.submissions.length, 0);
});

// ─── A dispute halts it ──────────────────────────────────────────────

test('a dispute opened inside the window halts the release for good', async () => {
  const { clock, repo, stellar, run, milestone } = setup();

  clock.now = new Date(T0.getTime() + 10 * HOUR);
  const halted = await repo.haltScheduled({
    campaignId: CAMPAIGN_ID,
    disputeId: 'dispute-1',
    milestoneId: MILESTONE_ID,
  });
  assert.deepEqual(halted, [MILESTONE_ID]);

  for (const hours of [72.5, 100, 500]) {
    clock.now = new Date(T0.getTime() + hours * HOUR);
    assert.deepEqual(await run(), []);
  }
  assert.equal(stellar.submissions.length, 0);
  assert.equal(milestone().auto_release_status, 'halted');
  assert.equal(milestone().auto_release_dispute_id, 'dispute-1');
  assert.equal(
    milestone().status,
    'pending_review',
    'falls back to the dispute flow / manual review'
  );
});

test('an open dispute blocks a due release even if the halt did not reach it', async () => {
  const { clock, repo, stellar, run, milestone } = setup();
  repo.state.disputes.push({ id: 'dispute-2', campaign_id: CAMPAIGN_ID, status: 'open' });
  clock.now = new Date(T0.getTime() + 73 * HOUR);

  const [result] = await run();
  assert.equal(result.outcome, 'halted');
  assert.equal(result.reason, 'dispute_open');
  assert.equal(milestone().auto_release_status, 'halted');
  assert.equal(stellar.submissions.length, 0);
});

test('a dispute that lands after the claim but before submission still stops the payout', async () => {
  const { clock, repo, stellar, run, milestone } = setup();
  clock.now = new Date(T0.getTime() + 73 * HOUR);

  // Claim, then "crash" before anything is built or sent.
  const claim = await repo.claimDue(MILESTONE_ID, ctx =>
    autoRelease.decideFire({ ...ctx, evidenceExists: true }, clock.now)
  );
  assert.equal(claim.action, 'claim');
  repo.state.disputes.push({ id: 'dispute-3', campaign_id: CAMPAIGN_ID, status: 'open' });

  clock.now = new Date(clock.now.getTime() + 10 * 60 * 1000); // lease expired
  const [result] = await run();
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason, /dispute_open/);
  assert.equal(stellar.submissions.length, 0);
  assert.equal(milestone().auto_release_status, 'failed');
  assert.equal(milestone().claimed_at, null, 'handed back to manual review');
});

// ─── Restart mid-window / mid-release ────────────────────────────────

test('a worker restarted mid-window neither misses the window nor fires early', async () => {
  const { clock, stellar, run, milestone } = setup();

  clock.now = new Date(T0.getTime() + 24 * HOUR);
  await run(); // worker A, mid-window
  // Worker A dies; the process is down past the deadline.
  clock.now = new Date(T0.getTime() + 90 * HOUR);
  const results = await run(); // worker B, fresh process

  assert.equal(results[0].outcome, 'released');
  assert.equal(stellar.submissions.length, 1);
  assert.equal(milestone().status, 'released');
});

test('restart after submission but before recording: reconciles by hash, pays once', async () => {
  const { clock, repo, stellar, released, run, milestone } = setup();
  clock.now = new Date(T0.getTime() + 73 * HOUR);
  repo.crashNextFinalize = true;

  await run(); // lands on the ledger, then dies before recording
  assert.equal(stellar.submissions.length, 1);
  assert.equal(milestone().status, 'pending_review');
  assert.equal(milestone().auto_release_status, 'releasing');

  // Still leased: a restarted worker waits rather than racing the old one.
  assert.deepEqual(await run(), []);

  clock.now = new Date(clock.now.getTime() + 6 * 60 * 1000);
  const [result] = await run();
  assert.equal(result.outcome, 'released');
  assert.equal(stellar.submissions.length, 1, 'recovered from Horizon, not resubmitted');
  assert.equal(stellar.built, 1, 'no second transaction was ever built');
  assert.equal(repo.state.withdrawals.length, 1);
  assert.equal(released.length, 1);
});

test('lost submission response: resubmitting the same envelope cannot double-pay', async () => {
  const { clock, repo, stellar, run, milestone } = setup();
  clock.now = new Date(T0.getTime() + 73 * HOUR);
  stellar.loseResponseOnce = true;

  const [first] = await run();
  assert.equal(first.outcome, 'pending');
  assert.equal(milestone().status, 'pending_review');

  clock.now = new Date(clock.now.getTime() + 6 * 60 * 1000);
  const [second] = await run();
  assert.equal(second.outcome, 'released');
  assert.equal(stellar.built, 1);
  assert.equal(new Set(stellar.submissions).size, 1, 'only one envelope ever existed');
  assert.equal(repo.state.withdrawals.length, 1);
});

test('restart between signing and submitting: submits the persisted envelope once', async () => {
  const { clock, repo, stellar, run, milestone } = setup();
  clock.now = new Date(T0.getTime() + 73 * HOUR);
  const claim = await repo.claimDue(MILESTONE_ID, ctx =>
    autoRelease.decideFire({ ...ctx, evidenceExists: true }, clock.now)
  );
  await repo.prepareAttempt(claim.attempt.id, {
    signedXdr: JSON.stringify({ n: 7, sigs: ['a', 'b'] }),
    txHash: 'hash-7',
  });

  clock.now = new Date(clock.now.getTime() + 6 * 60 * 1000);
  const [result] = await run();
  assert.equal(result.outcome, 'released');
  assert.deepEqual(stellar.submissions, ['hash-7']);
  assert.equal(stellar.built, 0, 'the persisted envelope is reused, not rebuilt');
  assert.equal(milestone().status, 'released');
});

test('an envelope that expired without landing fails safely back to manual review', async () => {
  const { clock, repo, stellar, run, milestone } = setup();
  clock.now = new Date(T0.getTime() + 73 * HOUR);
  const claim = await repo.claimDue(MILESTONE_ID, ctx =>
    autoRelease.decideFire({ ...ctx, evidenceExists: true }, clock.now)
  );
  await repo.prepareAttempt(claim.attempt.id, {
    signedXdr: JSON.stringify({ n: 9, sigs: ['a', 'b'] }),
    txHash: 'hash-9',
  });
  await repo.markSubmitted(claim.attempt.id);
  stellar.expired = true;

  clock.now = new Date(clock.now.getTime() + 30 * 60 * 1000);
  const [result] = await run();
  assert.equal(result.outcome, 'failed');
  assert.equal(stellar.submissions.length, 0);
  assert.equal(milestone().auto_release_status, 'failed');
  assert.equal(milestone().claimed_at, null);

  assert.deepEqual(await run(), [], 'a failed attempt is never retried automatically');
});

// ─── Minimum window ──────────────────────────────────────────────────

test('dispute window: default applies, shortening is allowed down to the documented minimum', () => {
  const { MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS } = require('../config/constants');
  assert.equal(MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS, 24 * 3600);

  assert.equal(autoRelease.resolveDisputeWindowSeconds(undefined), 72 * 3600);
  assert.equal(autoRelease.resolveDisputeWindowSeconds(48), 48 * 3600);
  assert.equal(autoRelease.resolveDisputeWindowSeconds(24), 24 * 3600);

  assert.throws(() => autoRelease.resolveDisputeWindowSeconds(23.99), {
    code: 'DISPUTE_WINDOW_BELOW_MINIMUM',
  });
  assert.throws(() => autoRelease.resolveDisputeWindowSeconds(1), {
    code: 'DISPUTE_WINDOW_BELOW_MINIMUM',
  });
  assert.throws(() => autoRelease.resolveDisputeWindowSeconds(0), {
    code: 'DISPUTE_WINDOW_REQUIRED',
  });
  assert.throws(() => autoRelease.resolveDisputeWindowSeconds(null), {
    code: 'DISPUTE_WINDOW_REQUIRED',
  });
  assert.throws(() => autoRelease.resolveDisputeWindowSeconds(96), {
    code: 'DISPUTE_WINDOW_ABOVE_DEFAULT',
  });
  assert.throws(() => autoRelease.resolveDisputeWindowSeconds('abc'), {
    code: 'DISPUTE_WINDOW_INVALID',
  });
});

test('dispute window: a platform default configured below the minimum is clamped up', () => {
  const previous = process.env.MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_HOURS;
  process.env.MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_HOURS = '2';
  try {
    assert.equal(autoRelease.defaultWindowSeconds(), 24 * 3600);
    assert.throws(() => autoRelease.resolveDisputeWindowSeconds(2), {
      code: 'DISPUTE_WINDOW_BELOW_MINIMUM',
    });
  } finally {
    if (previous === undefined) delete process.env.MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_HOURS;
    else process.env.MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_HOURS = previous;
  }
});

test('dispute window: the database enforces the same 24h floor', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', '..', 'db', 'migrations', '20260929_milestone_auto_release.sql'),
    'utf8'
  );
  assert.match(sql, /auto_release_window_seconds >= 86400/);
  assert.match(sql, /auto_release_at >= auto_release_scheduled_at \+ INTERVAL '24 hours'/);
});

// ─── Rules, evidence, invariant ──────────────────────────────────────

test('parseAutoReleaseConfig validates rule and rule_config', () => {
  assert.deepEqual(autoRelease.parseAutoReleaseConfig({ enabled: false }), { enabled: false });
  assert.deepEqual(
    autoRelease.parseAutoReleaseConfig({
      enabled: true,
      rule: 'platform_evidence',
      dispute_window_hours: 24,
    }),
    {
      enabled: true,
      rule: 'platform_evidence',
      ruleConfig: {},
      windowSeconds: 24 * 3600,
    }
  );
  assert.throws(() => autoRelease.parseAutoReleaseConfig({ enabled: true, rule: 'trust_me' }), {
    code: 'RULE_INVALID',
  });
  assert.throws(
    () =>
      autoRelease.parseAutoReleaseConfig({
        enabled: true,
        rule: 'evidence_hash_commitment',
        rule_config: { sha256: 'nope' },
      }),
    { code: 'RULE_CONFIG_INVALID' }
  );
  assert.throws(
    () =>
      autoRelease.parseAutoReleaseConfig({
        enabled: true,
        rule: 'backer_approval',
        rule_config: { min_approvals: 0 },
      }),
    { code: 'RULE_CONFIG_INVALID' }
  );
});

test("evaluateEvidence only accepts this milestone's platform-hosted evidence", () => {
  const base = { milestoneId: MILESTONE_ID, rule: 'platform_evidence', ruleConfig: {} };
  assert.equal(autoRelease.evaluateEvidence({ ...base, evidenceUrl: evidenceUrl() }).ok, true);
  assert.equal(
    autoRelease.evaluateEvidence({ ...base, evidenceUrl: 'https://example.com/proof.png' }).reason,
    'evidence_not_platform_hosted'
  );
  assert.equal(
    autoRelease.evaluateEvidence({
      ...base,
      evidenceUrl: evidenceUrl('33333333-3333-3333-3333-333333333333'),
    }).reason,
    'evidence_not_platform_hosted',
    'evidence uploaded for a different milestone does not count'
  );

  const commitment = {
    milestoneId: MILESTONE_ID,
    rule: 'evidence_hash_commitment',
    ruleConfig: { sha256: SHA },
  };
  assert.equal(
    autoRelease.evaluateEvidence({ ...commitment, evidenceUrl: evidenceUrl() }).ok,
    true
  );
  assert.equal(
    autoRelease.evaluateEvidence({
      ...commitment,
      evidenceUrl: evidenceUrl(MILESTONE_ID, 'b'.repeat(64)),
    }).reason,
    'evidence_hash_mismatch'
  );
});

test('decideFire halts when evidence changed after scheduling', () => {
  const ctx = {
    milestone: scheduledMilestone({ evidence_url: evidenceUrl(MILESTONE_ID, 'c'.repeat(64)) }),
    evidenceExists: true,
  };
  assert.deepEqual(autoRelease.decideFire(ctx, new Date(T0.getTime() + 73 * HOUR)), {
    action: 'halt',
    reason: 'evidence_changed',
  });
});

test('decideFire skips (retries later) when storage cannot be checked', () => {
  const ctx = { milestone: scheduledMilestone(), evidenceExists: null };
  assert.equal(autoRelease.decideFire(ctx, new Date(T0.getTime() + 73 * HOUR)).action, 'skip');
});

test('milestone percentage invariant holds for auto-releasing milestones', async () => {
  const over = {
    milestone: scheduledMilestone(),
    evidenceExists: true,
    totalPercentage: '120',
    releasedPercentage: '0',
  };
  assert.deepEqual(autoRelease.decideFire(over, new Date(T0.getTime() + 73 * HOUR)), {
    action: 'halt',
    reason: 'milestone_percentage_invariant_violated',
  });

  // End to end: two auto milestones that together make 100% release exactly
  // their share each, never more than was raised.
  const second = scheduledMilestone({
    id: '44444444-4444-4444-4444-444444444444',
    title: 'Ship v2',
    evidence_url: evidenceUrl('44444444-4444-4444-4444-444444444444'),
    auto_release_evidence_url: evidenceUrl('44444444-4444-4444-4444-444444444444'),
  });
  const { clock, repo, run } = setup({ milestones: [scheduledMilestone(), second] });
  clock.now = new Date(T0.getTime() + 73 * HOUR);
  await run();
  const paid = repo.state.withdrawals.reduce((sum, w) => sum + Number(w.amount), 0);
  assert.equal(repo.state.withdrawals.length, 2);
  assert.equal(paid, 1000);
});

test('describeAutoRelease exposes the countdown, rule and evidence to backers', () => {
  const view = autoRelease.describeAutoRelease(
    scheduledMilestone(),
    new Date(T0.getTime() + 70 * HOUR)
  );
  assert.equal(view.status, 'scheduled');
  assert.equal(view.can_dispute, true);
  assert.equal(view.seconds_remaining, 2 * 3600);
  assert.equal(view.rule, 'platform_evidence');
  assert.ok(view.rule_description);
  assert.equal(view.evidence.sha256, SHA);
  assert.equal(view.min_window_seconds, 24 * 3600);
});
