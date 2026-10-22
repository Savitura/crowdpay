const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const {
  processCampaignWebhookDelivery,
  isValidBackoffStrategy,
} = require('../services/webhookDispatcher');
const asyncHandler = require('../utils/asyncHandler');
const { isSafeUrl } = require('../utils/ssrfGuard');

async function isValidWebhookUrl(urlString) {
  const result = await isSafeUrl(urlString);
  return result.safe;
}

const requireCampaignCreator = asyncHandler(async (req, res, next) => {
  const campaignId = req.params.id;
  if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

  const { rows } = await db.query('SELECT id, creator_id FROM campaigns WHERE id = $1', [
    campaignId,
  ]);
  if (!rows.length) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const isOwner = rows[0].creator_id === req.user.userId || req.user.role === 'admin';
  if (!isOwner) {
    // Check campaign_members if exists
    try {
      const { rows: memberRows } = await db.query(
        'SELECT role FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
        [campaignId, req.user.userId]
      );
      if (
        memberRows.length &&
        (memberRows[0].role === 'owner' || memberRows[0].role === 'manager')
      ) {
        return next();
      }
    } catch {
      // Table may not exist or query failed
    }
    return res.status(403).json({ error: 'Forbidden: only campaign owner can manage webhooks' });
  }

  next();
});

// Register a webhook for a campaign
router.post(
  '/:id/webhooks',
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { url, events, backoff_strategy } = req.body || {};
    const campaignId = req.params.id;

    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    if (!(await isValidWebhookUrl(url))) {
      return res
        .status(400)
        .json({ error: 'url must be https, or http://localhost for development' });
    }

    // Limit to 5 active webhooks per campaign
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int as count FROM campaign_webhooks WHERE campaign_id = $1 AND active = TRUE',
      [campaignId]
    );
    if ((countRows[0]?.count || 0) >= 5) {
      return res.status(429).json({ error: 'Webhooks limited to 5 per campaign' });
    }

    if (
      backoff_strategy !== undefined &&
      backoff_strategy !== null &&
      !isValidBackoffStrategy(backoff_strategy)
    ) {
      return res.status(400).json({
        error: 'backoff_strategy must be { base_ms, max_ms, multiplier } with positive numbers',
      });
    }

    let eventList = events ? [events].flat() : ['contribution.indexed'];
    eventList = [...new Set(eventList.filter(e => typeof e === 'string'))];
    if (!eventList.length) eventList = ['contribution.indexed'];

    const secret = crypto.randomBytes(32).toString('hex');
    const secret_hint = `${secret.slice(0, 10)}…${secret.slice(-4)}`;

    const { rows } = await db.query(
      `INSERT INTO campaign_webhooks (campaign_id, url, secret, events, active, backoff_strategy)
       VALUES ($1, $2, $3, $4, TRUE, $5::jsonb)
       RETURNING id, campaign_id, url, events, active, created_at`,
      [
        campaignId,
        url,
        secret,
        eventList,
        backoff_strategy ? JSON.stringify(backoff_strategy) : null,
      ]
    );

    res.status(201).json({
      ...rows[0],
      secret_hint,
      secret,
      message: 'Store the signing secret; it is only shown once.',
    });
  })
);

// List webhooks for a campaign
router.get(
  '/:id/webhooks',
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;

    const { rows } = await db.query(
      `SELECT id, campaign_id, url, events, active, created_at, backoff_strategy,
              CONCAT(LEFT(secret, 10), '…', RIGHT(secret, 4)) AS secret_hint
       FROM campaign_webhooks
       WHERE campaign_id = $1
       ORDER BY created_at DESC`,
      [campaignId]
    );

    res.json(rows);
  })
);

// Delete/deactivate a campaign webhook
router.delete(
  '/:id/webhooks/:wid',
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { id: campaignId, wid: webhookId } = req.params;

    const { rows } = await db.query(
      `UPDATE campaign_webhooks
       SET active = FALSE
       WHERE id = $1 AND campaign_id = $2
       RETURNING id`,
      [webhookId, campaignId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.json({ revoked: true, id: rows[0].id });
  })
);

// Trigger a test event for a campaign webhook
router.post(
  '/:id/webhooks/:wid/test',
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { id: campaignId, wid: webhookId } = req.params;

    const { rows: hookRows } = await db.query(
      `SELECT id, campaign_id, url, secret, events, active
       FROM campaign_webhooks
       WHERE id = $1 AND campaign_id = $2 AND active = TRUE`,
      [webhookId, campaignId]
    );

    if (!hookRows.length) {
      return res.status(404).json({ error: 'Active campaign webhook not found' });
    }

    const hook = hookRows[0];
    const eventType =
      req.body?.event_type || req.body?.event || hook.events[0] || 'contribution.indexed';

    const payload = {
      event: eventType,
      campaign_id: campaignId,
      contribution_id: 'contrib_test_00000000-0000-0000-0000-000000000001',
      amount: '50.00',
      asset: 'USDC',
      donor: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      test: true,
      timestamp: new Date().toISOString(),
    };

    const { rows: inserted } = await db.query(
      `INSERT INTO campaign_webhook_deliveries (webhook_id, event, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending')
       RETURNING id, webhook_id, event, status, created_at`,
      [hook.id, eventType, JSON.stringify(payload)]
    );

    const deliveryId = inserted[0].id;
    const startTime = Date.now();
    try {
      await processCampaignWebhookDelivery(deliveryId);
    } catch (dispatchErr) {
      logger.error('Failed to process test campaign webhook delivery', {
        deliveryId,
        error: dispatchErr.message,
      });
    }
    const latencyMs = Math.max(1, Date.now() - startTime);

    const { rows: deliveryRows } = await db.query(
      `SELECT d.id, d.webhook_id, d.event, d.status, d.response_status,
              d.attempt_count, d.last_error, d.next_retry_at,
              d.delivered_at, d.failed_at, d.created_at, d.updated_at, d.payload,
              w.url AS webhook_url
       FROM campaign_webhook_deliveries d
       JOIN campaign_webhooks w ON w.id = d.webhook_id
       WHERE d.id = $1`,
      [deliveryId]
    );

    const delivery = deliveryRows[0] || inserted[0];

    try {
      await db.query(`UPDATE campaign_webhook_deliveries SET latency_ms = $1 WHERE id = $2`, [
        latencyMs,
        deliveryId,
      ]);
    } catch {
      // Ignore if latency_ms column does not exist
    }

    res.status(200).json({
      success: delivery.status === 'delivered',
      message:
        delivery.status === 'delivered'
          ? 'Test event delivered successfully'
          : `Test event delivery failed${delivery.last_error ? `: ${delivery.last_error}` : ''}`,
      latency_ms: latencyMs,
      delivery: {
        ...delivery,
        latency_ms: latencyMs,
      },
    });
  })
);

// Get delivery history for a campaign webhook
router.get(
  '/:id/webhooks/:wid/deliveries',
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { id: campaignId, wid: webhookId } = req.params;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const offset =
      req.query.offset !== undefined
        ? Math.max(0, parseInt(req.query.offset, 10) || 0)
        : req.query.page !== undefined
          ? Math.max(0, (parseInt(req.query.page, 10) || 1) - 1) * limit
          : 0;

    const status = req.query.status || null;

    const { rows: webhookRows } = await db.query(
      'SELECT id, url FROM campaign_webhooks WHERE id = $1 AND campaign_id = $2',
      [webhookId, campaignId]
    );
    if (!webhookRows.length) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const conditions = ['d.webhook_id = $1'];
    const params = [webhookId];

    if (status) {
      params.push(status);
      conditions.push(`d.status = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int as total FROM campaign_webhook_deliveries d ${whereClause}`,
      params
    );
    const total = countRows[0]?.total || 0;

    const queryParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT d.id, d.webhook_id, d.event, d.status, d.response_status, d.attempt_count, d.last_error,
              d.delivered_at, d.failed_at, d.created_at, d.updated_at, d.payload,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(d.delivered_at, d.updated_at) - d.created_at)) * 1000)::int AS latency_ms,
              $1::text AS webhook_url
       FROM campaign_webhook_deliveries d
       ${whereClause}
       ORDER BY d.created_at DESC
       LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      [webhookRows[0].url, ...queryParams.slice(1)]
    );

    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit) || 1;

    res.set({
      'X-Total-Count': String(total),
      'X-Page': String(page),
      'X-Total-Pages': String(totalPages),
      'X-Limit': String(limit),
      'X-Offset': String(offset),
    });

    res.json({
      total,
      page,
      limit,
      offset,
      total_pages: totalPages,
      items: rows,
      deliveries: rows,
    });
  })
);

// Replay a campaign webhook delivery
router.post(
  '/:id/webhooks/:wid/deliveries/:deliveryId/replay',
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { id: campaignId, wid: webhookId, deliveryId } = req.params;

    const { rows } = await db.query(
      `UPDATE campaign_webhook_deliveries d
       SET status = 'pending', attempt_count = 0, last_error = NULL,
           response_status = NULL, next_retry_at = NULL, delivered_at = NULL,
           lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
       FROM campaign_webhooks w
       WHERE d.id = $1 AND d.webhook_id = w.id AND w.id = $2 AND w.campaign_id = $3
         AND w.active IS TRUE
         AND d.status IN ('failed', 'retrying')
       RETURNING d.id`,
      [deliveryId, webhookId, campaignId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Failed delivery not found or not replayable' });
    }

    setImmediate(() => {
      processCampaignWebhookDelivery(rows[0].id).catch(err => {
        logger.error('Failed to replay campaign webhook delivery', { err });
      });
    });

    res.json({ message: 'Replay queued', id: rows[0].id });
  })
);

module.exports = router;
