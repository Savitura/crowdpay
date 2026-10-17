/**
 * milestoneAutoRelease.js
 *
 * Automatic milestone release on verified evidence, gated by a dispute window
 * (#930). This is deliberately *not* an ungated auto-release:
 *
 *   1. The creator opts a milestone in *before* submitting evidence, choosing a
 *      verification rule and a dispute window (a platform default the creator
 *      may shorten, never below MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS).
 *   2. Submitting evidence that satisfies the rule schedules the release for
 *      NOW() + window. Evidence that does not satisfy it leaves the milestone
 *      in the manual review queue.
 *   3. Any backer can open a dispute inside the window, which halts every
 *      scheduled release on the campaign and routes to the dispute flow
 *      (routes/disputes.js). A halted release never resumes by itself.
 *   4. When the window elapses the worker re-checks everything under a row
 *      lock (rule, evidence, votes, disputes, campaign state, the 100%
 *      percentage invariant) before claiming the release.
 *
 * Exactly-once payout: a milestone has at most one row in
 * milestone_auto_release_attempts (UNIQUE milestone_id). The signed XDR and its
 * hash are persisted before submission; after a crash the worker looks the hash
 * up on Horizon and either records the release, resubmits the *same* envelope
 * (same sequence number, so it can land at most once), or — only once the
 * envelope can no longer land — marks the attempt failed and hands the
 * milestone back to manual review.
 */

const db = require('../config/database');
const logger = require('../config/logger');
const {
  MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS,
  MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_SECONDS,
  MILESTONE_AUTO_RELEASE_TX_TIMEOUT_S,
} = require('../config/constants');
const {
  toReleaseAmount,
  logMilestoneEvent,
  logWithdrawalEvent,
  getMilestoneVoteTally,
  votesBlockRelease,
  setCampaignStatusFromMilestoneProgress,
} = require('./milestoneLedger');
const stellarService = require('./stellarService');
const {
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
} = require('./stellarTransactionService');
const { withDecryptedWalletSecret } = require('./walletSecrets');
const { assertCustodialWithdrawalAllowed } = require('./custodialSigningPolicy');
const { parseMilestoneEvidenceUrl, milestoneEvidenceExists } = require('./storage');
const { sanitizeMetadata } = require('./auditService');
const { sendAlert } = require('./alerting');

const RULES = {
  platform_evidence: {
    description:
      'Evidence is a file uploaded to CrowdPay storage for this milestone (content-addressed and immutable).',
  },
  evidence_hash_commitment: {
    description:
      'Evidence is a platform-hosted file whose SHA-256 matches the hash the creator committed to in advance.',
  },
  backer_approval: {
    description:
      'Evidence is a platform-hosted file and, when the window closes, at least min_approvals backers approved and approvals outnumber rejections.',
  },
};

const ACTIVE_CAMPAIGN_STATUSES = ['funded', 'in_progress'];
const OPEN_DISPUTE_STATUSES = ['open', 'under_review'];
const PERCENTAGE_EPSILON = 0.001;
const LEASE_SECONDS = 5 * 60;
// Only fail an unconfirmed envelope once it is well past its maxTime, so a
// ledger closing slightly behind our clock cannot still include it.
const EXPIRY_GRACE_SECONDS = 120;

class AutoReleaseValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AutoReleaseValidationError';
    this.status = 422;
    this.code = code;
  }
}

// ─── Configuration policy ────────────────────────────────────────────

function defaultWindowSeconds() {
  const hours = Number(process.env.MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_HOURS);
  if (Number.isFinite(hours) && hours > 0) {
    return Math.max(MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS, Math.round(hours * 3600));
  }
  return MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_SECONDS;
}

function windowPolicy() {
  return {
    min_window_seconds: MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS,
    default_window_seconds: defaultWindowSeconds(),
  };
}

/**
 * Resolve the creator's requested dispute window. Omitted → platform default.
 * The window can be shortened to the minimum but never removed or extended.
 */
function resolveDisputeWindowSeconds(hours) {
  const defaultSeconds = defaultWindowSeconds();
  if (hours === undefined) return defaultSeconds;
  if (hours === null || hours === '' || Number(hours) === 0) {
    throw new AutoReleaseValidationError(
      'The dispute window cannot be removed from an auto-releasing milestone',
      'DISPUTE_WINDOW_REQUIRED'
    );
  }
  const numeric = Number(hours);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new AutoReleaseValidationError(
      'dispute_window_hours must be a positive number',
      'DISPUTE_WINDOW_INVALID'
    );
  }
  const seconds = Math.round(numeric * 3600);
  if (seconds < MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS) {
    throw new AutoReleaseValidationError(
      `dispute_window_hours must be at least ${MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS / 3600} hours`,
      'DISPUTE_WINDOW_BELOW_MINIMUM'
    );
  }
  if (seconds > defaultSeconds) {
    throw new AutoReleaseValidationError(
      `dispute_window_hours can shorten the platform default of ${defaultSeconds / 3600} hours but not extend it`,
      'DISPUTE_WINDOW_ABOVE_DEFAULT'
    );
  }
  return seconds;
}

function normalizeRuleConfig(rule, config) {
  const input = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  switch (rule) {
    case 'platform_evidence':
      return {};
    case 'evidence_hash_commitment': {
      const sha256 = String(input.sha256 || '')
        .trim()
        .toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw new AutoReleaseValidationError(
          'rule_config.sha256 must be the hex SHA-256 of the evidence file you will upload',
          'RULE_CONFIG_INVALID'
        );
      }
      return { sha256 };
    }
    case 'backer_approval': {
      const minApprovals = input.min_approvals === undefined ? 1 : Number(input.min_approvals);
      if (!Number.isInteger(minApprovals) || minApprovals < 1 || minApprovals > 1000) {
        throw new AutoReleaseValidationError(
          'rule_config.min_approvals must be an integer between 1 and 1000',
          'RULE_CONFIG_INVALID'
        );
      }
      return { min_approvals: minApprovals };
    }
    default:
      throw new AutoReleaseValidationError(
        `rule must be one of: ${Object.keys(RULES).join(', ')}`,
        'RULE_INVALID'
      );
  }
}

/**
 * Validate an auto-release configuration from a request body.
 * @returns {{ enabled: false } | { enabled: true, rule: string, ruleConfig: object, windowSeconds: number }}
 */
function parseAutoReleaseConfig(body) {
  const input = body || {};
  if (input.enabled === false) return { enabled: false };
  if (input.enabled !== true) {
    throw new AutoReleaseValidationError('enabled must be true or false', 'ENABLED_INVALID');
  }
  const rule = String(input.rule || '').trim();
  const ruleConfig = normalizeRuleConfig(rule, input.rule_config);
  const windowSeconds = resolveDisputeWindowSeconds(input.dispute_window_hours);
  return { enabled: true, rule, ruleConfig, windowSeconds };
}

// ─── Rule evaluation (pure) ──────────────────────────────────────────

/**
 * Evidence half of a rule, checked at submission and again at fire time.
 * @returns {{ ok: boolean, reason?: string, evidence?: { key: string, sha256: string } }}
 */
function evaluateEvidence({ milestoneId, evidenceUrl, rule, ruleConfig }) {
  const evidence = parseMilestoneEvidenceUrl(milestoneId, evidenceUrl);
  if (!evidence) return { ok: false, reason: 'evidence_not_platform_hosted' };
  if (rule === 'evidence_hash_commitment' && evidence.sha256 !== ruleConfig?.sha256) {
    return { ok: false, reason: 'evidence_hash_mismatch', evidence };
  }
  if (!RULES[rule]) return { ok: false, reason: 'unknown_rule' };
  return { ok: true, evidence };
}

/**
 * Decide, under the milestone row lock, whether a due release may be claimed.
 * @returns {{ action: 'claim' } | { action: 'halt', reason: string } | { action: 'skip', reason: string }}
 */
function decideFire(ctx, now = new Date()) {
  const m = ctx.milestone;
  if (!m) return { action: 'skip', reason: 'not_found' };
  if (m.auto_release_status !== 'scheduled') return { action: 'skip', reason: 'not_scheduled' };
  if (!m.auto_release_at || new Date(m.auto_release_at) > now)
    return { action: 'skip', reason: 'window_open' };
  if (ctx.attemptExists) return { action: 'skip', reason: 'already_attempted' };
  if (m.claimed_at) return { action: 'skip', reason: 'claimed_by_manual_release' };
  if (ctx.evidenceExists === null || ctx.evidenceExists === undefined) {
    return { action: 'skip', reason: 'evidence_check_unavailable' };
  }

  if (m.status !== 'pending_review')
    return { action: 'halt', reason: 'milestone_not_pending_review' };
  if (!ACTIVE_CAMPAIGN_STATUSES.includes(m.campaign_status))
    return { action: 'halt', reason: 'campaign_not_releasable' };
  if (ctx.openDisputeCount > 0) return { action: 'halt', reason: 'dispute_open' };
  if (m.evidence_url !== m.auto_release_evidence_url)
    return { action: 'halt', reason: 'evidence_changed' };

  const evaluation = evaluateEvidence({
    milestoneId: m.id,
    evidenceUrl: m.evidence_url,
    rule: m.auto_release_rule,
    ruleConfig: m.auto_release_rule_config,
  });
  if (!evaluation.ok) return { action: 'halt', reason: evaluation.reason };
  if (evaluation.evidence.sha256 !== m.auto_release_evidence_sha256)
    return { action: 'halt', reason: 'evidence_changed' };
  if (!ctx.evidenceExists) return { action: 'halt', reason: 'evidence_missing_from_storage' };

  const tally = ctx.tally || { total_votes: 0, approve_count: 0, reject_count: 0 };
  if (votesBlockRelease(tally)) return { action: 'halt', reason: 'backer_votes_reject' };
  if (m.auto_release_rule === 'backer_approval') {
    const minApprovals = Number(m.auto_release_rule_config?.min_approvals || 1);
    if (tally.approve_count < minApprovals)
      return { action: 'halt', reason: 'backer_approval_quorum_not_met' };
  }

  if (!m.destination_key || !isValidPublicKey(m.destination_key))
    return { action: 'halt', reason: 'destination_invalid' };

  // scripts/validate-milestone-percentages.js invariant: a campaign's
  // milestones never total more than 100%, so an automated release can never
  // pay out more than the escrow holds for it.
  const total = Number(ctx.totalPercentage || 0);
  const released = Number(ctx.releasedPercentage || 0);
  if (
    total > 100 + PERCENTAGE_EPSILON ||
    released + Number(m.release_percentage) > 100 + PERCENTAGE_EPSILON
  ) {
    return { action: 'halt', reason: 'milestone_percentage_invariant_violated' };
  }
  if (!(Number(m.raised_amount) > 0)) return { action: 'halt', reason: 'nothing_raised' };

  return { action: 'claim' };
}

function isValidPublicKey(key) {
  try {
    require('@stellar/stellar-sdk').Keypair.fromPublicKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Public view of a milestone's pending release, for backers. */
function describeAutoRelease(milestone, now = new Date()) {
  const firesAt = milestone.auto_release_at ? new Date(milestone.auto_release_at) : null;
  const scheduled = milestone.auto_release_status === 'scheduled';
  return {
    milestone_id: milestone.id,
    enabled: !!milestone.auto_release_enabled,
    status: milestone.auto_release_status || null,
    rule: milestone.auto_release_rule || null,
    rule_description: RULES[milestone.auto_release_rule]?.description || null,
    rule_config: milestone.auto_release_rule_config || {},
    dispute_window_seconds: milestone.auto_release_window_seconds || null,
    scheduled_at: milestone.auto_release_scheduled_at || null,
    fires_at: firesAt ? firesAt.toISOString() : null,
    seconds_remaining: scheduled && firesAt ? Math.max(0, Math.ceil((firesAt - now) / 1000)) : null,
    can_dispute: scheduled,
    evidence: {
      url: milestone.auto_release_evidence_url || milestone.evidence_url || null,
      sha256: milestone.auto_release_evidence_sha256 || null,
      description: milestone.evidence_description || null,
      submitted_at: milestone.evidence_submitted_at || null,
    },
    halted_at: milestone.auto_release_halted_at || null,
    halt_reason: milestone.auto_release_halt_reason || null,
    dispute_id: milestone.auto_release_dispute_id || null,
    release_trigger: milestone.release_trigger || null,
    ...windowPolicy(),
  };
}

// ─── SQL repository ──────────────────────────────────────────────────

const CONTEXT_SELECT = `
  SELECT m.*, c.status AS campaign_status, c.raised_amount, c.asset_type,
         c.wallet_public_key AS campaign_wallet_public_key, c.title AS campaign_title,
         c.creator_id, c.milestones_contract_id,
         u.wallet_public_key AS creator_wallet_public_key, u.wallet_secret_encrypted,
         u.wallet_type AS creator_wallet_type
  FROM milestones m
  JOIN campaigns c ON c.id = m.campaign_id
  JOIN users u ON u.id = c.creator_id
  WHERE m.id = $1`;

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function countOpenDisputes(q, campaignId) {
  const { rows } = await q.query(
    `SELECT COUNT(*)::int AS count FROM disputes WHERE campaign_id = $1 AND status = ANY($2::text[])`,
    [campaignId, OPEN_DISPUTE_STATUSES]
  );
  return rows[0]?.count || 0;
}

async function insertAuditRow(q, { action, resourceId, metadata }) {
  await q.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, metadata)
     VALUES (NULL, $1, 'milestone', $2, $3::jsonb)`,
    [action, String(resourceId), JSON.stringify(sanitizeMetadata(metadata))]
  );
}

/**
 * Halt every scheduled auto-release on a campaign. Runs on the caller's
 * transaction client so it commits atomically with the dispute that caused it.
 */
async function haltScheduledReleasesSql(
  q,
  { campaignId, disputeId, milestoneId = null, reason = 'dispute_opened' }
) {
  const { rows } = await q.query(
    `UPDATE milestones
     SET auto_release_status = 'halted',
         auto_release_halted_at = NOW(),
         auto_release_halt_reason = $3,
         auto_release_dispute_id = $2
     WHERE campaign_id = $1 AND auto_release_status = 'scheduled'
     RETURNING id, auto_release_at, auto_release_rule, (auto_release_at > NOW()) AS inside_window`,
    [campaignId, disputeId || null, reason]
  );
  for (const row of rows) {
    await logMilestoneEvent(q, {
      milestoneId: row.id,
      actorUserId: null,
      action: 'auto_release_halted',
      note: reason,
      metadata: {
        dispute_id: disputeId || null,
        disputed_milestone_id: milestoneId,
        rule: row.auto_release_rule,
        fires_at: row.auto_release_at,
        inside_window: row.inside_window,
      },
    });
  }
  return rows.map(row => row.id);
}

function createSqlRepository(pool = db) {
  return {
    async listDue(limit) {
      const { rows } = await pool.query(
        `SELECT id, auto_release_evidence_url
         FROM milestones
         WHERE auto_release_status = 'scheduled' AND auto_release_at <= NOW()
         ORDER BY auto_release_at ASC
         LIMIT $1`,
        [limit]
      );
      return rows;
    },

    async listRecoverable(limit) {
      const { rows } = await pool.query(
        `SELECT id FROM milestone_auto_release_attempts
         WHERE status IN ('claimed', 'prepared', 'submitted')
           AND (lease_until IS NULL OR lease_until < NOW())
         ORDER BY created_at ASC
         LIMIT $1`,
        [limit]
      );
      return rows;
    },

    async loadContext(milestoneId) {
      const { rows } = await pool.query(CONTEXT_SELECT, [milestoneId]);
      if (!rows.length) return null;
      return {
        milestone: rows[0],
        openDisputeCount: await countOpenDisputes(pool, rows[0].campaign_id),
      };
    },

    async claimDue(milestoneId, decide) {
      return withTransaction(pool, async client => {
        const { rows } = await client.query(`${CONTEXT_SELECT} FOR UPDATE OF m`, [milestoneId]);
        const milestone = rows[0] || null;
        if (!milestone) return { action: 'skip', reason: 'not_found' };

        const openDisputeCount = await countOpenDisputes(client, milestone.campaign_id);
        const tally = await getMilestoneVoteTally(client, milestone.id);
        const percentages = await client.query(
          `SELECT COALESCE(SUM(release_percentage), 0)::numeric AS total,
                  COALESCE(SUM(release_percentage) FILTER (WHERE status = 'released'), 0)::numeric AS released
           FROM milestones WHERE campaign_id = $1`,
          [milestone.campaign_id]
        );
        const attempts = await client.query(
          'SELECT 1 FROM milestone_auto_release_attempts WHERE milestone_id = $1',
          [milestone.id]
        );
        const ctx = {
          milestone,
          openDisputeCount,
          tally,
          totalPercentage: percentages.rows[0]?.total,
          releasedPercentage: percentages.rows[0]?.released,
          attemptExists: attempts.rows.length > 0,
        };
        const decision = decide(ctx);

        if (decision.action === 'halt') {
          await client.query(
            `UPDATE milestones
             SET auto_release_status = 'halted', auto_release_halted_at = NOW(), auto_release_halt_reason = $2
             WHERE id = $1 AND auto_release_status = 'scheduled'`,
            [milestone.id, decision.reason]
          );
          await logMilestoneEvent(client, {
            milestoneId: milestone.id,
            action: 'auto_release_halted',
            note: decision.reason,
            metadata: { rule: milestone.auto_release_rule, fires_at: milestone.auto_release_at },
          });
          return { ...decision, ctx };
        }
        if (decision.action !== 'claim') return { ...decision, ctx };

        // The DB clock is authoritative for the window: never claim early.
        const { rows: claimed } = await client.query(
          `UPDATE milestones
           SET auto_release_status = 'releasing', claimed_at = NOW()
           WHERE id = $1 AND auto_release_status = 'scheduled' AND claimed_at IS NULL
             AND auto_release_at <= NOW()
           RETURNING id`,
          [milestone.id]
        );
        if (!claimed.length) return { action: 'skip', reason: 'window_open', ctx };

        const amount = toReleaseAmount(milestone.raised_amount, milestone.release_percentage);
        const { rows: attemptRows } = await client.query(
          `INSERT INTO milestone_auto_release_attempts
             (milestone_id, campaign_id, rule, rule_config, window_seconds, scheduled_at, fires_at,
              evidence_url, evidence_sha256, amount, destination_key, lease_until)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, NOW() + make_interval(secs => $12))
           RETURNING *`,
          [
            milestone.id,
            milestone.campaign_id,
            milestone.auto_release_rule,
            JSON.stringify(milestone.auto_release_rule_config || {}),
            milestone.auto_release_window_seconds,
            milestone.auto_release_scheduled_at,
            milestone.auto_release_at,
            milestone.auto_release_evidence_url,
            milestone.auto_release_evidence_sha256,
            amount,
            milestone.destination_key,
            LEASE_SECONDS,
          ]
        );
        await logMilestoneEvent(client, {
          milestoneId: milestone.id,
          action: 'auto_release_claimed',
          note: 'Dispute window elapsed; automated release claimed',
          metadata: { attempt_id: attemptRows[0].id, rule: milestone.auto_release_rule, amount },
        });
        return { action: 'claim', ctx, attempt: attemptRows[0] };
      });
    },

    async leaseAttempt(attemptId) {
      const { rows } = await pool.query(
        `UPDATE milestone_auto_release_attempts
         SET lease_until = NOW() + make_interval(secs => $2), updated_at = NOW()
         WHERE id = $1 AND status IN ('claimed', 'prepared', 'submitted')
           AND (lease_until IS NULL OR lease_until < NOW())
         RETURNING *`,
        [attemptId, LEASE_SECONDS]
      );
      return rows[0] || null;
    },

    async prepareAttempt(attemptId, { signedXdr, txHash }) {
      const { rows } = await pool.query(
        `UPDATE milestone_auto_release_attempts
         SET status = 'prepared', signed_xdr = $2, tx_hash = $3, updated_at = NOW()
         WHERE id = $1 AND status = 'claimed'
         RETURNING *`,
        [attemptId, signedXdr, txHash]
      );
      return rows[0] || null;
    },

    async markSubmitted(attemptId) {
      const { rows } = await pool.query(
        `UPDATE milestone_auto_release_attempts
         SET status = 'submitted', updated_at = NOW()
         WHERE id = $1 AND status IN ('prepared', 'submitted')
         RETURNING *`,
        [attemptId]
      );
      return rows[0] || null;
    },

    async failAttempt(attemptId, reason) {
      return withTransaction(pool, async client => {
        const { rows } = await client.query(
          `UPDATE milestone_auto_release_attempts
           SET status = 'failed', failure_reason = $2, lease_until = NULL, updated_at = NOW()
           WHERE id = $1 AND status IN ('claimed', 'prepared', 'submitted')
           RETURNING *`,
          [attemptId, reason]
        );
        if (!rows.length) return null;
        // No funds moved: hand the milestone back to manual platform review.
        await client.query(
          `UPDATE milestones
           SET auto_release_status = 'failed', auto_release_halted_at = NOW(),
               auto_release_halt_reason = $2, claimed_at = NULL
           WHERE id = $1 AND status = 'pending_review'`,
          [rows[0].milestone_id, reason]
        );
        await logMilestoneEvent(client, {
          milestoneId: rows[0].milestone_id,
          action: 'auto_release_failed',
          note: reason,
          metadata: { attempt_id: attemptId, tx_hash: rows[0].tx_hash },
        });
        return rows[0];
      });
    },

    async finalizeRelease(attemptId) {
      return withTransaction(pool, async client => {
        const { rows: attemptRows } = await client.query(
          'SELECT * FROM milestone_auto_release_attempts WHERE id = $1 FOR UPDATE',
          [attemptId]
        );
        const attempt = attemptRows[0];
        if (!attempt) return { alreadyFinal: true };
        if (attempt.status === 'confirmed') return { alreadyFinal: true, attempt };

        const { rows: milestoneRows } = await client.query(`${CONTEXT_SELECT} FOR UPDATE OF m`, [
          attempt.milestone_id,
        ]);
        const milestone = milestoneRows[0];
        if (milestone.status === 'released') {
          await client.query(
            `UPDATE milestone_auto_release_attempts SET status = 'confirmed', lease_until = NULL, updated_at = NOW() WHERE id = $1`,
            [attemptId]
          );
          return { alreadyFinal: true, attempt };
        }

        const releaseMeta = {
          trigger: 'automatic',
          attempt_id: attempt.id,
          rule: attempt.rule,
          rule_config: attempt.rule_config,
          dispute_window_seconds: attempt.window_seconds,
          scheduled_at: attempt.scheduled_at,
          fires_at: attempt.fires_at,
          evidence_url: attempt.evidence_url,
          evidence_sha256: attempt.evidence_sha256,
          release_amount: attempt.amount,
          tx_hash: attempt.tx_hash,
        };

        const { rows: releaseRows } = await client.query(
          `INSERT INTO withdrawal_requests
             (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
              creator_signed, platform_signed, status, tx_hash, milestone_id)
           VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, 'submitted', $6, $7)
           RETURNING *`,
          [
            milestone.campaign_id,
            milestone.creator_id,
            attempt.amount,
            attempt.destination_key,
            attempt.signed_xdr,
            attempt.tx_hash,
            milestone.id,
          ]
        );
        const withdrawalRequest = releaseRows[0];

        await logWithdrawalEvent(client, {
          withdrawalRequestId: withdrawalRequest.id,
          actorUserId: null,
          action: 'requested',
          note: 'Automatic milestone release on verified evidence',
          metadata: { milestone_id: milestone.id, ...releaseMeta },
        });
        await logWithdrawalEvent(client, {
          withdrawalRequestId: withdrawalRequest.id,
          actorUserId: milestone.creator_id,
          action: 'creator_signed',
          note: 'Creator signature applied under the creator-configured automatic release',
          metadata: { milestone_id: milestone.id, trigger: 'automatic' },
        });
        await logWithdrawalEvent(client, {
          withdrawalRequestId: withdrawalRequest.id,
          actorUserId: null,
          action: 'platform_signed',
          note: 'Platform signed automatically after the dispute window elapsed',
          metadata: {
            milestone_id: milestone.id,
            trigger: 'automatic',
            rule: attempt.rule,
            tx_hash: attempt.tx_hash,
          },
        });

        await insertWithdrawalPendingSignatures(client, {
          campaignId: milestone.campaign_id,
          withdrawalRequestId: withdrawalRequest.id,
          userId: milestone.creator_id,
          unsignedXdr: attempt.signed_xdr,
          metadata: {
            milestone_id: milestone.id,
            milestone_title: milestone.title,
            amount: attempt.amount,
            asset_type: milestone.asset_type,
            trigger: 'automatic',
          },
        });
        await finalizeWithdrawalSubmitted(client, {
          withdrawalRequestId: withdrawalRequest.id,
          txHash: attempt.tx_hash,
          signedXdr: attempt.signed_xdr,
        });

        const { rows: updated } = await client.query(
          `UPDATE milestones
           SET status = 'released',
               release_trigger = 'auto',
               auto_release_status = 'released',
               approved_at = COALESCE(approved_at, NOW()),
               released_at = NOW(),
               reviewed_at = COALESCE(reviewed_at, NOW())
           WHERE id = $1
           RETURNING *`,
          [milestone.id]
        );

        await logMilestoneEvent(client, {
          milestoneId: milestone.id,
          actorUserId: null,
          action: 'auto_released',
          note: `Released automatically under rule "${attempt.rule}" after the dispute window elapsed`,
          metadata: { ...releaseMeta, withdrawal_request_id: withdrawalRequest.id },
        });
        await insertAuditRow(client, {
          action: 'milestone.auto_released',
          resourceId: milestone.id,
          metadata: {
            release_mode: 'automatic',
            campaign_id: milestone.campaign_id,
            withdrawal_request_id: withdrawalRequest.id,
            ...releaseMeta,
          },
        });

        const campaignStatus = await setCampaignStatusFromMilestoneProgress(
          client,
          milestone.campaign_id
        );
        await client.query(
          `UPDATE milestone_auto_release_attempts
           SET status = 'confirmed', withdrawal_request_id = $2, lease_until = NULL, updated_at = NOW()
           WHERE id = $1`,
          [attemptId, withdrawalRequest.id]
        );

        return {
          attempt,
          milestone: { ...milestone, ...updated[0] },
          withdrawalRequest,
          campaignStatus,
        };
      });
    },

    haltScheduled(args) {
      return withTransaction(pool, client => haltScheduledReleasesSql(client, args));
    },
  };
}

// ─── Worker ──────────────────────────────────────────────────────────

function defaultDeps() {
  return {
    stellar: stellarService,
    withDecryptedWalletSecret,
    evidenceExists: milestoneEvidenceExists,
    afterRelease: announceAutoRelease,
    alert: sendAlert,
  };
}

function releaseBlocker(ctx) {
  if (!ctx?.milestone) return 'milestone_missing';
  if (ctx.milestone.status !== 'pending_review') return 'milestone_not_pending_review';
  if (!ACTIVE_CAMPAIGN_STATUSES.includes(ctx.milestone.campaign_status))
    return 'campaign_not_releasable';
  if (ctx.openDisputeCount > 0) return 'dispute_open';
  return null;
}

/** Build and sign the payout envelope, persisting it before anything is submitted. */
async function prepare(attempt, ctx, repo, deps) {
  const m = ctx.milestone;
  // Signing below uses the creator's custodial key plus the platform key, so
  // above the custodial limit the release goes back to manual review instead.
  assertCustodialWithdrawalAllowed({
    walletType: m.creator_wallet_type,
    amount: Number(attempt.amount).toFixed(7),
  });
  const unsignedXdr = await deps.stellar.buildWithdrawalTransaction({
    campaignWalletPublicKey: m.campaign_wallet_public_key,
    destinationPublicKey: attempt.destination_key,
    amount: Number(attempt.amount).toFixed(7),
    asset: m.asset_type,
    timeoutSeconds: MILESTONE_AUTO_RELEASE_TX_TIMEOUT_S,
  });
  const creatorSigned = await deps.withDecryptedWalletSecret(
    m.wallet_secret_encrypted,
    { userId: m.creator_id, walletPublicKey: m.creator_wallet_public_key },
    async creatorSecret =>
      deps.stellar.signTransactionXdr({ xdr: unsignedXdr, signerSecret: creatorSecret })
  );
  const signedXdr = deps.stellar.signTransactionXdr({
    xdr: creatorSigned,
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });
  if (deps.stellar.signatureCountFromXdr(signedXdr) < 2) {
    throw new Error('Automated release requires both creator and platform signatures');
  }
  const txHash = deps.stellar.transactionHashFromXdr(signedXdr);
  return repo.prepareAttempt(attempt.id, { signedXdr, txHash });
}

async function finalize(attempt, repo, deps) {
  const result = await repo.finalizeRelease(attempt.id);
  if (!result.alreadyFinal && deps.afterRelease) {
    await Promise.resolve(deps.afterRelease(result)).catch(err =>
      logger.error('milestone auto-release: post-release hooks failed', {
        attempt_id: attempt.id,
        error: err.message,
      })
    );
  }
  logger.info('milestone auto-release: released', {
    milestone_id: attempt.milestone_id,
    tx_hash: attempt.tx_hash,
  });
  return { milestoneId: attempt.milestone_id, outcome: 'released', txHash: attempt.tx_hash };
}

async function fail(attempt, reason, repo, deps) {
  await repo.failAttempt(attempt.id, reason);
  logger.warn('milestone auto-release: failed, returned to manual review', {
    milestone_id: attempt.milestone_id,
    reason,
  });
  deps.alert?.('Milestone auto-release failed', {
    milestone_id: attempt.milestone_id,
    attempt_id: attempt.id,
    reason,
  });
  return { milestoneId: attempt.milestone_id, outcome: 'failed', reason };
}

/** Submit a prepared envelope. The attempt is marked 'submitted' first, so 'prepared' always means "never sent". */
async function submit(attempt, repo, deps) {
  await repo.markSubmitted(attempt.id);
  try {
    await deps.stellar.submitSignedWithdrawal({ xdr: attempt.signed_xdr });
  } catch (err) {
    if (!deps.stellar.isDefinitiveSubmissionFailure(err)) {
      // Timeout / network error: the envelope may still land. Reconcile by hash later.
      logger.warn('milestone auto-release: submission outcome unknown', {
        attempt_id: attempt.id,
        error: err.message,
      });
      return { milestoneId: attempt.milestone_id, outcome: 'pending' };
    }
    // A rejected resubmission (e.g. tx_bad_seq) can mean the first one landed.
    const outcome = await deps.stellar
      .getTransactionOutcome(attempt.tx_hash)
      .catch(() => 'unknown');
    if (outcome === 'success') return finalize(attempt, repo, deps);
    if (outcome === 'unknown') return { milestoneId: attempt.milestone_id, outcome: 'pending' };
    const codes = JSON.stringify(err?.response?.data?.extras?.result_codes || {});
    return fail(attempt, `submission_rejected ${codes}`, repo, deps);
  }
  return finalize(attempt, repo, deps);
}

/** Drive an attempt forward from whatever state it was left in. Safe to call repeatedly. */
async function advanceAttempt(attempt, repo, deps) {
  if (attempt.status === 'claimed' || attempt.status === 'prepared') {
    // Nothing has been sent yet, so a dispute raised after the claim still stops the payout.
    const ctx = await repo.loadContext(attempt.milestone_id);
    const blocker = releaseBlocker(ctx);
    if (blocker) return fail(attempt, `blocked_before_submission: ${blocker}`, repo, deps);

    let prepared = attempt;
    if (attempt.status === 'claimed') {
      try {
        prepared = await prepare(attempt, ctx, repo, deps);
      } catch (err) {
        return fail(attempt, `prepare_failed: ${err.message}`, repo, deps);
      }
      if (!prepared)
        return {
          milestoneId: attempt.milestone_id,
          outcome: 'skipped',
          reason: 'attempt_moved_on',
        };
    }
    return submit(prepared, repo, deps);
  }

  if (attempt.status === 'submitted') {
    const outcome = await deps.stellar.getTransactionOutcome(attempt.tx_hash);
    if (outcome === 'success') return finalize(attempt, repo, deps);
    if (outcome === 'failed') return fail(attempt, 'transaction_failed_on_ledger', repo, deps);
    if (deps.stellar.isXdrExpired(attempt.signed_xdr, EXPIRY_GRACE_SECONDS)) {
      return fail(attempt, 'transaction_expired_without_landing', repo, deps);
    }
    const ctx = await repo.loadContext(attempt.milestone_id);
    if (releaseBlocker(ctx)) {
      // May already be in flight; do not push it again. It expires shortly.
      return { milestoneId: attempt.milestone_id, outcome: 'pending', reason: 'awaiting_expiry' };
    }
    return submit(attempt, repo, deps);
  }

  return {
    milestoneId: attempt.milestone_id,
    outcome: 'skipped',
    reason: `attempt_${attempt.status}`,
  };
}

async function checkEvidence(milestoneId, evidenceUrl, deps) {
  const parsed = parseMilestoneEvidenceUrl(milestoneId, evidenceUrl);
  if (!parsed) return false;
  try {
    return await deps.evidenceExists(parsed.key);
  } catch (err) {
    logger.warn('milestone auto-release: evidence check unavailable', {
      milestone_id: milestoneId,
      error: err.message,
    });
    return null;
  }
}

/**
 * Worker entry point. First reconciles attempts left in flight (e.g. by a
 * restart), then claims releases whose dispute window has elapsed. Every
 * piece of state lives in the database, so a restarted worker neither misses
 * a window nor repeats a payout.
 */
async function processAutoReleases({
  repo = createSqlRepository(),
  deps = defaultDeps(),
  now = () => new Date(),
  limit = 25,
} = {}) {
  const results = [];

  for (const { id } of await repo.listRecoverable(limit)) {
    try {
      const leased = await repo.leaseAttempt(id);
      if (leased) results.push(await advanceAttempt(leased, repo, deps));
    } catch (err) {
      logger.error('milestone auto-release: recovery failed', {
        attempt_id: id,
        error: err.message,
      });
    }
  }

  for (const due of await repo.listDue(limit)) {
    try {
      const evidenceExists = await checkEvidence(due.id, due.auto_release_evidence_url, deps);
      const claim = await repo.claimDue(due.id, ctx =>
        decideFire({ ...ctx, evidenceExists }, now())
      );
      if (claim.action === 'claim') {
        results.push(await advanceAttempt(claim.attempt, repo, deps));
      } else {
        results.push({
          milestoneId: due.id,
          outcome: claim.action === 'halt' ? 'halted' : 'skipped',
          reason: claim.reason,
        });
      }
    } catch (err) {
      logger.error('milestone auto-release: release failed', {
        milestone_id: due.id,
        error: err.message,
      });
    }
  }

  return results;
}

// ─── Hooks used by the routes ────────────────────────────────────────

/**
 * On evidence submission (inside the route's transaction): schedule the
 * release if the evidence satisfies the milestone's rule, otherwise leave it
 * for manual review and record why.
 */
async function scheduleOnSubmission(q, milestone, { evidenceExists }) {
  if (!milestone.auto_release_enabled) return null;

  const { rows: attempts } = await q.query(
    'SELECT 1 FROM milestone_auto_release_attempts WHERE milestone_id = $1',
    [milestone.id]
  );
  const evaluation = attempts.length
    ? { ok: false, reason: 'previous_automatic_attempt' }
    : evaluateEvidence({
        milestoneId: milestone.id,
        evidenceUrl: milestone.evidence_url,
        rule: milestone.auto_release_rule,
        ruleConfig: milestone.auto_release_rule_config,
      });
  if (evaluation.ok && evidenceExists !== true) {
    evaluation.ok = false;
    evaluation.reason =
      evidenceExists === false ? 'evidence_missing_from_storage' : 'evidence_unverifiable';
  }

  if (!evaluation.ok) {
    const { rows } = await q.query(
      `UPDATE milestones
       SET auto_release_status = 'ineligible', auto_release_halt_reason = $2,
           auto_release_halted_at = NOW(), auto_release_at = NULL, auto_release_scheduled_at = NULL
       WHERE id = $1
       RETURNING *`,
      [milestone.id, evaluation.reason]
    );
    await logMilestoneEvent(q, {
      milestoneId: milestone.id,
      action: 'auto_release_ineligible',
      note: evaluation.reason,
      metadata: { rule: milestone.auto_release_rule, evidence_url: milestone.evidence_url },
    });
    return rows[0];
  }

  const { rows } = await q.query(
    `UPDATE milestones
     SET auto_release_status = 'scheduled',
         auto_release_scheduled_at = NOW(),
         auto_release_at = NOW() + make_interval(secs => GREATEST(auto_release_window_seconds, $3)),
         auto_release_evidence_url = evidence_url,
         auto_release_evidence_sha256 = $2,
         auto_release_halted_at = NULL,
         auto_release_halt_reason = NULL,
         auto_release_dispute_id = NULL
     WHERE id = $1
     RETURNING *`,
    [milestone.id, evaluation.evidence.sha256, MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS]
  );
  await logMilestoneEvent(q, {
    milestoneId: milestone.id,
    action: 'auto_release_scheduled',
    note: `Evidence satisfies rule "${milestone.auto_release_rule}"; release scheduled after the dispute window`,
    metadata: {
      rule: milestone.auto_release_rule,
      rule_config: milestone.auto_release_rule_config,
      dispute_window_seconds: rows[0].auto_release_window_seconds,
      fires_at: rows[0].auto_release_at,
      evidence_url: rows[0].auto_release_evidence_url,
      evidence_sha256: evaluation.evidence.sha256,
    },
  });
  return rows[0];
}

/** Called by the dispute route inside its transaction. */
function haltScheduledReleases(q, args) {
  return haltScheduledReleasesSql(q, args);
}

/** Best-effort side effects after an automated release has been recorded. */
async function announceAutoRelease({ milestone, withdrawalRequest, attempt }) {
  const { releaseMilestone } = require('./sorobanService');
  const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('./webhookDispatcher');
  const { notifyContributorFundRelease } = require('./fundReleaseNotifications');

  if (milestone.milestones_contract_id) {
    try {
      await releaseMilestone({
        milestonesContractId: milestone.milestones_contract_id,
        milestoneIndex: milestone.sort_order,
        signerSecret: process.env.PLATFORM_SECRET_KEY,
      });
      await db.query('UPDATE withdrawal_requests SET contract_milestone_index = $1 WHERE id = $2', [
        milestone.sort_order,
        withdrawalRequest.id,
      ]);
    } catch (err) {
      logger.error('milestone auto-release: Soroban release failed', {
        milestone_id: milestone.id,
        error: err.message,
      });
      sendAlert('Soroban milestone release failed after automated payout', {
        milestone_id: milestone.id,
        tx_hash: attempt.tx_hash,
        error: err.message,
      });
    }
  }

  await emitWebhookEventForUser(milestone.creator_id, WEBHOOK_EVENTS.MILESTONE_APPROVED, {
    milestone,
    campaign_id: milestone.campaign_id,
    withdrawal_request_id: withdrawalRequest.id,
    tx_hash: attempt.tx_hash,
    trigger: 'automatic',
    rule: attempt.rule,
  }).catch(err => logger.error('milestone auto-release: webhook failed', { error: err.message }));

  await notifyContributorFundRelease({
    campaignId: milestone.campaign_id,
    campaignTitle: milestone.campaign_title,
    amount: attempt.amount,
    asset: milestone.asset_type,
    txHash: attempt.tx_hash,
    usage: `Milestone "${milestone.title}" was released automatically after its dispute window closed with no dispute.`,
    recipient: attempt.destination_key,
    excludeUserIds: [],
  }).catch(err =>
    logger.error('milestone auto-release: contributor notify failed', { error: err.message })
  );
}

module.exports = {
  RULES,
  AutoReleaseValidationError,
  defaultWindowSeconds,
  windowPolicy,
  resolveDisputeWindowSeconds,
  normalizeRuleConfig,
  parseAutoReleaseConfig,
  evaluateEvidence,
  decideFire,
  describeAutoRelease,
  createSqlRepository,
  processAutoReleases,
  advanceAttempt,
  scheduleOnSubmission,
  haltScheduledReleases,
};
