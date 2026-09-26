const crypto = require('crypto');
const db = require('../config/database');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('../config/logger');

function createStorageClient() {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET;

  if (!endpoint || !bucket) {
    throw new Error('Object storage is not configured. Set STORAGE_ENDPOINT and STORAGE_BUCKET.');
  }

  return new S3Client({
    endpoint,
    region: process.env.STORAGE_REGION || 'auto',
    forcePathStyle: true,
    credentials:
      process.env.STORAGE_ACCESS_KEY && process.env.STORAGE_SECRET_KEY
        ? {
            accessKeyId: process.env.STORAGE_ACCESS_KEY,
            secretAccessKey: process.env.STORAGE_SECRET_KEY,
          }
        : undefined,
  });
}

async function generateUserExport(userId, exportId) {
  try {
    const [
      profileRes, sessionsRes, contributionsRes,
      preferencesRes, referralsRes, disputesRes, subscriptionsRes, credentialsRes
    ] = await Promise.all([
      db.query(`SELECT id, email, name, role, created_at, wallet_public_key FROM users WHERE id = $1`, [userId]),
      db.query(`SELECT id, created_at, ip_address, user_agent, location_region FROM user_sessions WHERE user_id = $1`, [userId]),
      db.query(`SELECT id, campaign_id, amount, asset, status, created_at FROM contributions WHERE sender_public_key = (SELECT wallet_public_key FROM users WHERE id = $1)`, [userId]),
      db.query(`SELECT * FROM notification_preferences WHERE user_id = $1`, [userId]),
      db.query(`SELECT id, campaign_id, referral_code, created_at FROM campaign_referrals WHERE referrer_id = $1`, [userId]),
      db.query(`SELECT id, campaign_id, reason, status, created_at FROM disputes WHERE raised_by = $1`, [userId]),
      db.query(`SELECT id, campaign_id, amount, interval, active, created_at FROM recurring_contributions WHERE user_id = $1`, [userId]),
      db.query(`SELECT id, label, scopes, expires_at, created_at FROM api_keys WHERE user_id = $1`, [userId])
    ]);

    let notificationsRes = { rows: [] };
    try {
        notificationsRes = await db.query(`SELECT id, type, title, body, is_read, created_at FROM notifications WHERE user_id = $1`, [userId]);
    } catch(err) {
        // Table might not exist or schema might be different
        logger.warn('Failed to fetch notifications for export', { error: err.message });
    }

    const exportData = {
      profile: profileRes.rows[0],
      sessions: sessionsRes.rows,
      contributions: contributionsRes.rows,
      preferences: preferencesRes.rows[0],
      notifications: notificationsRes.rows,
      referrals: referralsRes.rows,
      disputes: disputesRes.rows,
      subscriptions: subscriptionsRes.rows,
      credentials: credentialsRes.rows,
      exported_at: new Date().toISOString()
    };

    const buffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
    const hash = crypto.randomBytes(16).toString('hex');
    const key = `exports/${userId}/${hash}.json`;

    const client = createStorageClient();
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: 'application/json',
      })
    );

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await db.query(
      `UPDATE user_data_exports SET status = 'completed', file_url = $1, expires_at = $2, updated_at = NOW() WHERE id = $3`,
      [key, expiresAt, exportId]
    );
  } catch (err) {
    logger.error('Data export failed', { userId, exportId, error: err.message });
    await db.query(
      `UPDATE user_data_exports SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [exportId]
    );
  }
}

async function getExportDownloadUrl(key) {
  const client = createStorageClient();
  const command = new GetObjectCommand({
    Bucket: process.env.STORAGE_BUCKET,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: 3600 });
}

module.exports = { generateUserExport, getExportDownloadUrl };
