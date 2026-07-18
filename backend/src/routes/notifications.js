const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { CHANNELS } = require('../services/notificationChannels');

const EXTERNAL_CHANNELS = CHANNELS.filter((c) => c !== 'in_app');

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, type, title, body, link, read_at, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.user.userId]
  );
  res.json(rows);
});

router.patch('/read-all', requireAuth, async (req, res) => {
  await db.query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
    [req.user.userId]
  );
  res.json({ ok: true });
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

// ── Multi-channel settings (issue #429) ────────────────────────────────────

// Per-user channel destinations + quiet-hours window.
router.get('/channel-settings', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT push_token, slack_webhook_url, discord_webhook_url, sms_phone_number,
            quiet_hours_start, quiet_hours_end
     FROM notification_channel_settings
     WHERE user_id = $1`,
    [req.user.userId]
  );
  res.json(
    rows[0] || {
      push_token: null,
      slack_webhook_url: null,
      discord_webhook_url: null,
      sms_phone_number: null,
      quiet_hours_start: null,
      quiet_hours_end: null,
    }
  );
});

function validQuietHour(value) {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 23);
}

router.put('/channel-settings', requireAuth, async (req, res) => {
  const {
    push_token = null,
    slack_webhook_url = null,
    discord_webhook_url = null,
    sms_phone_number = null,
    quiet_hours_start = null,
    quiet_hours_end = null,
  } = req.body || {};

  if (!validQuietHour(quiet_hours_start) || !validQuietHour(quiet_hours_end)) {
    return res.status(400).json({ error: 'quiet_hours must be an integer 0-23 or null' });
  }

  const { rows } = await db.query(
    `INSERT INTO notification_channel_settings
       (user_id, push_token, slack_webhook_url, discord_webhook_url,
        sms_phone_number, quiet_hours_start, quiet_hours_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       push_token = EXCLUDED.push_token,
       slack_webhook_url = EXCLUDED.slack_webhook_url,
       discord_webhook_url = EXCLUDED.discord_webhook_url,
       sms_phone_number = EXCLUDED.sms_phone_number,
       quiet_hours_start = EXCLUDED.quiet_hours_start,
       quiet_hours_end = EXCLUDED.quiet_hours_end,
       updated_at = NOW()
     RETURNING push_token, slack_webhook_url, discord_webhook_url, sms_phone_number,
               quiet_hours_start, quiet_hours_end`,
    [
      req.user.userId,
      push_token,
      slack_webhook_url,
      discord_webhook_url,
      sms_phone_number,
      quiet_hours_start,
      quiet_hours_end,
    ]
  );
  res.json(rows[0]);
});

// Per-event-type, per-channel enable/disable overrides.
router.get('/preferences', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT event_type, channel, enabled
     FROM notification_preferences
     WHERE user_id = $1
     ORDER BY event_type, channel`,
    [req.user.userId]
  );
  res.json(rows);
});

router.put('/preferences', requireAuth, async (req, res) => {
  const { event_type, channel, enabled } = req.body || {};
  if (!event_type || typeof event_type !== 'string') {
    return res.status(400).json({ error: 'event_type is required' });
  }
  if (!EXTERNAL_CHANNELS.includes(channel) && channel !== 'in_app') {
    return res.status(400).json({ error: `channel must be one of ${CHANNELS.join(', ')}` });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  await db.query(
    `INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, event_type, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [req.user.userId, event_type, channel, enabled]
  );
  res.json({ ok: true });
});

module.exports = router;
