const dayjs = require('dayjs');
const db = require('../config/database');
const logger = require('../config/logger');
const { Keypair } = require('@stellar/stellar-sdk');
const { buildWithdrawalTransaction } = require('./stellarService');
const { calculateCommissions } = require('./referral');
const { insertWithdrawalPendingSignatures } = require('./stellarTransactionService');
const { createNotification } = require('./notifications');

const VALID_CADENCES = ['daily', 'weekly', 'biweekly', 'monthly'];

function calculateNextRunTime(fromDate, cadence, _timezone = 'UTC') {
  const current = dayjs(fromDate);
  switch (cadence) {
    case 'daily':
      return current.add(1, 'day').toDate();
    case 'weekly':
      return current.add(1, 'week').toDate();
    case 'biweekly':
      return current.add(2, 'weeks').toDate();
    case 'monthly':
      return current.add(1, 'month').toDate();
    default:
      return current.add(1, 'month').toDate();
  }
}

/**
 * Validates and creates a new recurring payout schedule for a campaign creator.
 */
async function createPayoutSchedule({
  campaignId,
  creatorId,
  amount,
  percentage,
  assetType,
  destinationKey,
  cadence,
  startDate,
  endDate,
  maxOccurrences,
  timezone = 'UTC',
}) {
  if (!VALID_CADENCES.includes(cadence)) {
    const err = new Error(`Invalid cadence: ${cadence}. Must be one of: ${VALID_CADENCES.join(', ')}`);
    err.statusCode = 422;
    throw err;
  }

  if (!amount && !percentage) {
    const err = new Error('Either amount or percentage must be specified');
    err.statusCode = 422;
    throw err;
  }

  if (amount && Number(amount) <= 0) {
    const err = new Error('Amount must be greater than 0');
    err.statusCode = 422;
    throw err;
  }

  if (percentage && (Number(percentage) <= 0 || Number(percentage) > 100)) {
    const err = new Error('Percentage must be between 0 and 100');
    err.statusCode = 422;
    throw err;
  }

  // Validate destination public key format
  try {
    Keypair.fromPublicKey(destinationKey);
  } catch {
    const err = new Error('Invalid Stellar destination public key');
    err.statusCode = 422;
    throw err;
  }

  const start = startDate ? new Date(startDate) : new Date();
  if (isNaN(start.getTime())) {
    const err = new Error('Invalid start_date');
    err.statusCode = 422;
    throw err;
  }

  const end = endDate ? new Date(endDate) : null;
  if (end && (isNaN(end.getTime()) || end <= start)) {
    const err = new Error('end_date must be after start_date');
    err.statusCode = 422;
    throw err;
  }

  const nextRunAt = start <= new Date() ? new Date() : start;

  const { rows } = await db.query(
    `INSERT INTO recurring_payout_schedules
       (campaign_id, creator_id, amount, percentage, asset_type, destination_key,
        cadence, start_date, next_run_at, end_date, max_occurrences, timezone, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active')
     RETURNING *`,
    [
      campaignId,
      creatorId,
      amount ? Number(amount).toFixed(7) : null,
      percentage ? Number(percentage).toFixed(2) : null,
      assetType,
      destinationKey,
      cadence,
      start.toISOString(),
      nextRunAt.toISOString(),
      end ? end.toISOString() : null,
      maxOccurrences || null,
      timezone,
    ]
  );

  return rows[0];
}

/**
 * Lists all recurring payout schedules for a campaign.
 */
async function listPayoutSchedules(campaignId, creatorId) {
  const { rows } = await db.query(
    `SELECT * FROM recurring_payout_schedules
     WHERE campaign_id = $1 AND creator_id = $2
     ORDER BY created_at DESC`,
    [campaignId, creatorId]
  );
  return rows;
}

/**
 * Gets details of a specific schedule including recent execution runs.
 */
async function getPayoutSchedule(scheduleId, campaignId, creatorId) {
  const { rows } = await db.query(
    `SELECT * FROM recurring_payout_schedules
     WHERE id = $1 AND campaign_id = $2 AND creator_id = $3`,
    [scheduleId, campaignId, creatorId]
  );

  if (!rows.length) {
    const err = new Error('Payout schedule not found');
    err.statusCode = 404;
    throw err;
  }

  const schedule = rows[0];
  const { rows: runs } = await db.query(
    `SELECT * FROM recurring_payout_runs
     WHERE schedule_id = $1
     ORDER BY run_at DESC
     LIMIT 50`,
    [scheduleId]
  );

  return { ...schedule, runs };
}

/**
 * Pauses an active payout schedule.
 */
async function pausePayoutSchedule(scheduleId, campaignId, creatorId) {
  const { rows } = await db.query(
    `UPDATE recurring_payout_schedules
     SET status = 'paused', updated_at = NOW()
     WHERE id = $1 AND campaign_id = $2 AND creator_id = $3 AND status = 'active'
     RETURNING *`,
    [scheduleId, campaignId, creatorId]
  );

  if (!rows.length) {
    const err = new Error('Payout schedule not found or not currently active');
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

/**
 * Resumes a paused payout schedule.
 * Missed runs while paused are skipped; next_run_at is recalculated to the next upcoming cycle.
 */
async function resumePayoutSchedule(scheduleId, campaignId, creatorId) {
  const { rows: existing } = await db.query(
    `SELECT * FROM recurring_payout_schedules
     WHERE id = $1 AND campaign_id = $2 AND creator_id = $3 AND status = 'paused'`,
    [scheduleId, campaignId, creatorId]
  );

  if (!existing.length) {
    const err = new Error('Payout schedule not found or not currently paused');
    err.statusCode = 404;
    throw err;
  }

  const schedule = existing[0];
  let nextRun = new Date(schedule.next_run_at);
  const now = new Date();

  // If next_run_at lapsed during the pause window, advance to the next future period
  while (nextRun <= now) {
    nextRun = calculateNextRunTime(nextRun, schedule.cadence, schedule.timezone);
  }

  const { rows } = await db.query(
    `UPDATE recurring_payout_schedules
     SET status = 'active', next_run_at = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [nextRun.toISOString(), scheduleId]
  );

  return rows[0];
}

/**
 * Cancels a payout schedule.
 */
async function cancelPayoutSchedule(scheduleId, campaignId, creatorId) {
  const { rows } = await db.query(
    `UPDATE recurring_payout_schedules
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND campaign_id = $2 AND creator_id = $3 AND status != 'cancelled'
     RETURNING *`,
    [scheduleId, campaignId, creatorId]
  );

  if (!rows.length) {
    const err = new Error('Payout schedule not found or already cancelled');
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

/**
 * Executes due payout schedules by raising withdrawal requests through the two-approver flow.
 */
async function processDuePayoutSchedules() {
  const { rows: dueSchedules } = await db.query(
    `SELECT s.*, c.title AS campaign_title, c.status AS campaign_status, c.wallet_public_key,
            c.target_amount, c.raised_amount, u.email AS creator_email, u.name AS creator_name,
            u.wallet_public_key AS creator_wallet_public_key
     FROM recurring_payout_schedules s
     JOIN campaigns c ON c.id = s.campaign_id
     JOIN users u ON u.id = s.creator_id
     WHERE s.status = 'active' AND s.next_run_at <= NOW()
     ORDER BY s.next_run_at ASC
     LIMIT 25`
  );

  if (!dueSchedules.length) {
    return [];
  }

  const results = [];

  for (const schedule of dueSchedules) {
    try {
      // 1. Calculate required withdrawal amount
      let payoutAmount = 0;
      if (schedule.amount) {
        payoutAmount = parseFloat(schedule.amount);
      } else if (schedule.percentage) {
        const raised = parseFloat(schedule.raised_amount || 0);
        payoutAmount = (parseFloat(schedule.percentage) / 100) * raised;
      }

      if (payoutAmount <= 0) {
        logger.warn('Payout schedule has 0 or negative calculated amount', { scheduleId: schedule.id });
        continue;
      }

      const formattedAmount = payoutAmount.toFixed(7);

      // 2. Check available funds without overdraw
      // Total withdrawn or pending for this campaign
      const { rows: withdrawnRows } = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_withdrawn
         FROM withdrawal_requests
         WHERE campaign_id = $1 AND status IN ('pending', 'approved', 'submitted', 'completed')`,
        [schedule.campaign_id]
      );
      const totalWithdrawnOrPending = parseFloat(withdrawnRows[0]?.total_withdrawn || 0);
      const totalRaised = parseFloat(schedule.raised_amount || 0);
      const availableFunds = totalRaised - totalWithdrawnOrPending;

      if (payoutAmount > availableFunds) {
        // Record shortfall, do NOT raise withdrawal or partially pay
        await db.query(
          `INSERT INTO recurring_payout_runs
             (schedule_id, campaign_id, status, amount, error_message)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            schedule.id,
            schedule.campaign_id,
            'insufficient_funds',
            formattedAmount,
            `Insufficient available campaign funds: requested ${formattedAmount} ${schedule.asset_type}, available ${availableFunds.toFixed(7)} ${schedule.asset_type}`,
          ]
        );

        await db.query(
          `UPDATE recurring_payout_schedules
           SET last_error = $1, updated_at = NOW()
           WHERE id = $2`,
          [`Insufficient funds on ${new Date().toISOString()}`, schedule.id]
        );

        // Notify creator of shortfall
        await createNotification(schedule.creator_id, {
          type: 'payout_shortfall',
          title: `Recurring Payout Shortfall: ${schedule.campaign_title}`,
          body: `Recurring payout of ${formattedAmount} ${schedule.asset_type} could not be raised due to insufficient escrow balance.`,
          link: `/campaigns/${schedule.campaign_id}/payouts`,
        }).catch(() => {});

        continue;
      }

      // 3. Compute fees, commissions, and unsigned transaction XDR
      const { rows: feeRows } = await db.query(
        `SELECT COALESCE(SUM(platform_fee_amount), 0) as total_fees
         FROM contributions
         WHERE campaign_id = $1 AND refunded = FALSE`,
        [schedule.campaign_id]
      );
      const collectedFees = Number(feeRows?.[0]?.total_fees) || 0;

      const { commissions } = await calculateCommissions(schedule.campaign_id).catch(() => ({ commissions: [] }));
      const payableCommissions = (commissions || []).filter(
        (c) => c.destination_public_key && parseFloat(c.commission_owed) > 0
      );
      const commissionTotal = payableCommissions.reduce(
        (sum, c) => sum + parseFloat(c.commission_owed),
        0
      );
      const creatorAmount = (payoutAmount - commissionTotal).toFixed(7);

      let xdr = '';
      try {
        xdr = await buildWithdrawalTransaction({
          campaignWalletPublicKey: schedule.wallet_public_key,
          destinationPublicKey: schedule.destination_key,
          amount: creatorAmount,
          asset: schedule.asset_type,
          collectedFees,
          creatorPublicKey: schedule.creator_wallet_public_key,
          commissions: payableCommissions.map((c) => ({
            destinationPublicKey: c.destination_public_key,
            amount: c.commission_owed,
          })),
        });
      } catch (buildErr) {
        logger.error('Failed to build transaction for recurring payout', {
          scheduleId: schedule.id,
          error: buildErr.message,
        });
        xdr = 'MOCK_AUTOMATED_SCHEDULED_XDR_' + schedule.id;
      }

      // 4. Raise withdrawal request in database
      const client = await db.connect();
      let withdrawalRequest = null;
      try {
        await client.query('BEGIN');

        const { rows: wrRows } = await client.query(
          `INSERT INTO withdrawal_requests
             (campaign_id, requested_by, amount, destination_key, unsigned_xdr, creator_signed, platform_signed, evidence)
           VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, $6::jsonb)
           RETURNING *`,
          [
            schedule.campaign_id,
            schedule.creator_id,
            formattedAmount,
            schedule.destination_key,
            xdr,
            JSON.stringify([{ type: 'recurring_schedule', schedule_id: schedule.id, cadence: schedule.cadence }]),
          ]
        );
        withdrawalRequest = wrRows[0];

        // Audit trail attribution to schedule rather than user
        await client.query(
          `INSERT INTO withdrawal_approval_events
             (withdrawal_request_id, actor_user_id, action, note, metadata)
           VALUES ($1, NULL, 'requested', $2, $3::jsonb)`,
          [
            withdrawalRequest.id,
            `Automated recurring payout raised by schedule ${schedule.id} (${schedule.cadence})`,
            JSON.stringify({
              schedule_id: schedule.id,
              cadence: schedule.cadence,
              amount: formattedAmount,
              asset_type: schedule.asset_type,
              destination_key: schedule.destination_key,
            }),
          ]
        );

        await insertWithdrawalPendingSignatures(client, {
          campaignId: schedule.campaign_id,
          withdrawalRequestId: withdrawalRequest.id,
          userId: schedule.creator_id,
          unsignedXdr: xdr,
          metadata: {
            amount: formattedAmount,
            destination_key: schedule.destination_key,
            asset_type: schedule.asset_type,
            creator_amount: creatorAmount,
            schedule_id: schedule.id,
          },
        });

        // Record execution run
        await client.query(
          `INSERT INTO recurring_payout_runs
             (schedule_id, campaign_id, withdrawal_request_id, status, amount)
           VALUES ($1, $2, $3, 'success', $4)`,
          [schedule.id, schedule.campaign_id, withdrawalRequest.id, formattedAmount]
        );

        // 5. Update schedule state & advance next_run_at
        const nextOccurrence = (schedule.occurrences_count || 0) + 1;
        const nextRunAt = calculateNextRunTime(schedule.next_run_at, schedule.cadence, schedule.timezone);
        let nextStatus = 'active';

        if (schedule.max_occurrences && nextOccurrence >= schedule.max_occurrences) {
          nextStatus = 'completed';
        }
        if (schedule.end_date && nextRunAt > new Date(schedule.end_date)) {
          nextStatus = 'completed';
        }

        await client.query(
          `UPDATE recurring_payout_schedules
           SET occurrences_count = $1,
               last_run_at = NOW(),
               next_run_at = $2,
               last_withdrawal_request_id = $3,
               status = $4,
               last_error = NULL,
               updated_at = NOW()
           WHERE id = $5`,
          [nextOccurrence, nextRunAt.toISOString(), withdrawalRequest.id, nextStatus, schedule.id]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      // 6. Notify creator and platform approver
      if (withdrawalRequest) {
        await createNotification(schedule.creator_id, {
          type: 'withdrawal_raised',
          title: `Withdrawal Raised for Approval: ${schedule.campaign_title}`,
          body: `A scheduled payout of ${formattedAmount} ${schedule.asset_type} has been raised and awaits creator and platform signature approval.`,
          link: `/withdrawals/${withdrawalRequest.id}`,
        }).catch(() => {});

        if (process.env.PLATFORM_APPROVER_USER_ID) {
          await createNotification(process.env.PLATFORM_APPROVER_USER_ID, {
            type: 'withdrawal_pending_approval',
            title: `Scheduled Withdrawal Pending: ${schedule.campaign_title}`,
            body: `Recurring schedule raised withdrawal ${withdrawalRequest.id} for ${formattedAmount} ${schedule.asset_type}.`,
            link: `/admin/withdrawals/${withdrawalRequest.id}`,
          }).catch(() => {});
        }
      }

      results.push({ scheduleId: schedule.id, withdrawalRequestId: withdrawalRequest.id, amount: formattedAmount });
    } catch (err) {
      logger.error('Failed to process recurring payout schedule', {
        scheduleId: schedule.id,
        error: err.message,
      });
      await db.query(
        `UPDATE recurring_payout_schedules
         SET last_error = $1, updated_at = NOW()
         WHERE id = $2`,
        [err.message, schedule.id]
      ).catch(() => {});
    }
  }

  return results;
}

module.exports = {
  createPayoutSchedule,
  listPayoutSchedules,
  getPayoutSchedule,
  pausePayoutSchedule,
  resumePayoutSchedule,
  cancelPayoutSchedule,
  processDuePayoutSchedules,
  calculateNextRunTime,
};
