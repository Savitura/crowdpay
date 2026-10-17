const db = require('../config/database');
const logger = require('../config/logger');
const { sendEmail, isEmailConfigured } = require('./emailService');
const { createNotification } = require('./notifications');

const CLAIM_LIMIT = 20;
const STALE_CLAIM_MINUTES = 5;

async function claimPending() {
  const { rows } = await db.query(
    `WITH candidates AS (
       SELECT id
       FROM contribution_gift_notifications
       WHERE next_attempt_at <= NOW()
         AND (status = 'pending' OR
              (status = 'sending' AND claimed_at < NOW() - ($2 * INTERVAL '1 minute')))
       ORDER BY next_attempt_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE contribution_gift_notifications AS notification
     SET status = 'sending', attempts = attempts + 1, claimed_at = NOW()
     FROM candidates
     WHERE notification.id = candidates.id
     RETURNING notification.*`,
    [CLAIM_LIMIT, STALE_CLAIM_MINUTES]
  );
  return rows;
}

function retryDelaySeconds(attempts) {
  return Math.min(24 * 60 * 60, 60 * 2 ** Math.min(Math.max(attempts - 1, 0), 10));
}

async function deliverOne(notification) {
  if (!isEmailConfigured()) {
    await db.query(
      `UPDATE contribution_gift_notifications
       SET status = 'pending', claimed_at = NULL,
           next_attempt_at = NOW() + INTERVAL '1 hour',
           last_error = 'Email delivery is not configured'
       WHERE id = $1`,
      [notification.id]
    );
    return false;
  }

  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const campaignUrl = `${frontendUrl}/campaigns/${notification.campaign_id}`;
  const message = notification.message ? `\n\nTheir message: ${notification.message}` : '';
  await sendEmail({
    to: notification.recipient_email,
    subject: 'A contribution was made in your honor',
    text: `${notification.recipient_name},\n\nA supporter contributed ${notification.amount} ${notification.asset} to "${notification.campaign_title}" in your honor.${message}\n\nView the campaign: ${campaignUrl}`,
  });

  const { rows: users } = await db.query(
    'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [notification.recipient_email]
  );
  if (users.length) {
    await createNotification(users[0].id, {
      type: 'gift_contribution',
      title: 'A contribution was made in your honor',
      body: `${notification.amount} ${notification.asset} was contributed to ${notification.campaign_title}.`,
      link: `/campaigns/${notification.campaign_id}`,
    });
  }

  await db.query(
    `UPDATE contribution_gift_notifications
     SET status = 'sent', sent_at = NOW(), claimed_at = NULL, last_error = NULL
     WHERE id = $1`,
    [notification.id]
  );
  return true;
}

async function processPendingGiftNotifications() {
  const notifications = await claimPending();
  for (const notification of notifications) {
    try {
      await deliverOne(notification);
    } catch (error) {
      const delay = retryDelaySeconds(notification.attempts);
      await db.query(
        `UPDATE contribution_gift_notifications
         SET status = 'pending', claimed_at = NULL,
             next_attempt_at = NOW() + ($2 * INTERVAL '1 second'),
             last_error = $3
         WHERE id = $1`,
        [notification.id, delay, String(error.message || 'Delivery failed').slice(0, 500)]
      );
      logger.error('Gift contribution notification delivery failed', {
        notification_id: notification.id,
        attempt: notification.attempts,
        error_code: error.code || 'DELIVERY_FAILED',
      });
    }
  }
}

let workerTimer;
function startGiftNotificationWorker() {
  if (workerTimer) return workerTimer;
  processPendingGiftNotifications().catch(error =>
    logger.error('Gift notification worker failed', { error: error.message })
  );
  workerTimer = setInterval(() => {
    processPendingGiftNotifications().catch(error =>
      logger.error('Gift notification worker failed', { error: error.message })
    );
  }, 60_000);
  workerTimer.unref?.();
  return workerTimer;
}

module.exports = {
  processPendingGiftNotifications,
  retryDelaySeconds,
  startGiftNotificationWorker,
};
