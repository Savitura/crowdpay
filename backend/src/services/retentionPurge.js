const db = require('../config/database');
const logger = require('../config/logger');

const DEFAULT_RETENTION_DAYS = {
  KYC: 365,
  WEBHOOK_DELIVERIES: 90,
  CAMPAIGN_WEBHOOK_DELIVERIES: 90,
  WEBHOOKS: 365,
  PUSH_SUBSCRIPTIONS: 90,
  REVOKED_SESSIONS: 90,
  LOGIN_ATTEMPTS: 365,
  LOGIN_ALERTS: 365,
  NOTIFICATIONS: 180,
  FLUSHED_NOTIFICATION_QUEUE: 30,
};

async function purgeKycData({ retentionDays = DEFAULT_RETENTION_DAYS.KYC } = {}) {
  const { rows } = await db.query(
    `DELETE FROM users
     WHERE kyc_retention_expires_at < NOW()::timestamp
       AND kyc_legal_hold != 'active'
       AND kyc_retention_expires_at IS NOT NULL
     RETURNING id, kyc_status, kyc_completed_at`
  );
  if (rows.length) {
    logger.info('retention: purged expired KYC data', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

async function purgeWebhookDeliveries({
  retentionDays = DEFAULT_RETENTION_DAYS.WEBHOOK_DELIVERIES,
} = {}) {
  const { rows } = await db.query(
    `DELETE FROM webhook_deliveries
     WHERE expires_at < NOW()::timestamp
       AND legal_hold != 'active'
       AND expires_at IS NOT NULL
     RETURNING id, event_type, webhook_id`
  );
  if (rows.length) {
    logger.info('retention: purged expired webhook deliveries', {
      deleted: rows.length,
      retentionDays,
    });
  }
  return rows.length;
}

async function purgeCampaignWebhookDeliveries({
  retentionDays = DEFAULT_RETENTION_DAYS.CAMPAIGN_WEBHOOK_DELIVERIES,
} = {}) {
  const { rows } = await db.query(
    `DELETE FROM campaign_webhook_deliveries
     WHERE expires_at < NOW()::timestamp
       AND legal_hold != 'active'
       AND expires_at IS NOT NULL
     RETURNING id, event, campaign_id`
  );
  if (rows.length) {
    logger.info('retention: purged expired campaign webhook deliveries', {
      deleted: rows.length,
      retentionDays,
    });
  }
  return rows.length;
}

async function purgeWebhooks({ retentionDays = DEFAULT_RETENTION_DAYS.WEBHOOKS } = {}) {
  const { rows } = await db.query(
    `DELETE FROM webhooks
     WHERE retention_expires_at < NOW()::timestamp
       AND legal_hold != 'active'
       AND retention_expires_at IS NOT NULL
     RETURNING id, user_id, events`
  );
  if (rows.length) {
    logger.info('retention: purged expired webhooks', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

async function purgeExpiredPushSubscriptions({
  retentionDays = DEFAULT_RETENTION_DAYS.PUSH_SUBSCRIPTIONS,
} = {}) {
  const { rows } = await db.query(
    `DELETE FROM push_subscriptions
     WHERE updated_at < NOW() - ($1::text || ' days')::interval
     RETURNING id, user_id`,
    [String(retentionDays)]
  );
  if (rows.length) {
    logger.info('retention: purged expired push subscriptions', {
      deleted: rows.length,
      retentionDays,
    });
  }
  return rows.length;
}

/**
 * Purge sessions that were revoked more than `retentionDays` ago.
 * Active (unrevoked) sessions are never removed here.
 */
async function purgeRevokedSessions({
  retentionDays = DEFAULT_RETENTION_DAYS.REVOKED_SESSIONS,
} = {}) {
  const { rows } = await db.query(
    `DELETE FROM user_sessions
     WHERE revoked_at IS NOT NULL
       AND revoked_at < NOW() - ($1::text || ' days')::interval
     RETURNING id, user_id`,
    [String(retentionDays)]
  );
  if (rows.length) {
    logger.info('retention: purged revoked sessions', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

/** Purge login attempts (audit trail) older than `retentionDays`. */
async function purgeLoginAttempts({
  retentionDays = DEFAULT_RETENTION_DAYS.LOGIN_ATTEMPTS,
} = {}) {
  const { rows } = await db.query(
    `DELETE FROM login_attempts
     WHERE created_at < NOW() - ($1::text || ' days')::interval
     RETURNING id`,
    [String(retentionDays)]
  );
  if (rows.length) {
    logger.info('retention: purged login attempts', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

/** Purge login alerts (audit trail) older than `retentionDays`. */
async function purgeLoginAlerts({ retentionDays = DEFAULT_RETENTION_DAYS.LOGIN_ALERTS } = {}) {
  const { rows } = await db.query(
    `DELETE FROM login_alerts
     WHERE created_at < NOW() - ($1::text || ' days')::interval
     RETURNING id`,
    [String(retentionDays)]
  );
  if (rows.length) {
    logger.info('retention: purged login alerts', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

/** Purge in-app notifications older than `retentionDays`. */
async function purgeNotifications({ retentionDays = DEFAULT_RETENTION_DAYS.NOTIFICATIONS } = {}) {
  const { rows } = await db.query(
    `DELETE FROM notifications
     WHERE created_at < NOW() - ($1::text || ' days')::interval
     RETURNING id`,
    [String(retentionDays)]
  );
  if (rows.length) {
    logger.info('retention: purged notifications', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

/**
 * Purge already-flushed digest queue rows. Unflushed rows are never removed
 * because they still represent undelivered notifications.
 */
async function purgeFlushedNotificationQueue({
  retentionDays = DEFAULT_RETENTION_DAYS.FLUSHED_NOTIFICATION_QUEUE,
} = {}) {
  const { rows } = await db.query(
    `DELETE FROM notification_queue
     WHERE flushed_at IS NOT NULL
       AND flushed_at < NOW() - ($1::text || ' days')::interval
     RETURNING id`,
    [String(retentionDays)]
  );
  if (rows.length) {
    logger.info('retention: purged flushed notification queue rows', {
      deleted: rows.length,
      retentionDays,
    });
  }
  return rows.length;
}

/**
 * Run all purge jobs.
 * @returns {Promise<object>} Counts of deleted rows per category.
 */
async function runAllPurges() {
  const results = {
    kyc: await purgeKycData(),
    webhookDeliveries: await purgeWebhookDeliveries(),
    campaignWebhookDeliveries: await purgeCampaignWebhookDeliveries(),
    webhooks: await purgeWebhooks(),
    pushSubscriptions: await purgeExpiredPushSubscriptions(),
    revokedSessions: await purgeRevokedSessions(),
    loginAttempts: await purgeLoginAttempts(),
    loginAlerts: await purgeLoginAlerts(),
    notifications: await purgeNotifications(),
    flushedNotificationQueue: await purgeFlushedNotificationQueue(),
  };
  logger.info('retention: completed all purge runs', results);
  return results;
}

module.exports = {
  purgeKycData,
  purgeWebhookDeliveries,
  purgeCampaignWebhookDeliveries,
  purgeWebhooks,
  purgeExpiredPushSubscriptions,
  purgeRevokedSessions,
  purgeLoginAttempts,
  purgeLoginAlerts,
  purgeNotifications,
  purgeFlushedNotificationQueue,
  runAllPurges,
  DEFAULT_RETENTION_DAYS,
};
