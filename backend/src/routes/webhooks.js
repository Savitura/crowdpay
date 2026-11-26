const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const {
  ALL_WEBHOOK_EVENTS,
  processDelivery,
  isValidBackoffStrategy,
} = require('../services/webhookDispatcher');
const {
  processIncomingWebhook,
  verifyWebhookSignature,
  WebhookError,
} = require('../services/webhookService');
const asyncHandler = require('../utils/asyncHandler');
const { isSafeUrl } = require('../utils/ssrfGuard');
const { logCredentialEvent } = require('../services/auditService');
const {
  encryptIntegrationSecret,
  isEncryptedIntegrationSecret,
  withDecryptedIntegrationSecret,
} = require('../services/integrationSecrets');

const isTest = process.env.NODE_ENV === 'test';

// Per-IP: 30 req/min on the public webhook ingress endpoint. This route has
// no auth (any caller with a valid webhook id + signature can post to it),
// so it's a DoS vector without its own limiter — the global 100 req/15min
// limit is far too permissive for a single public endpoint.
const incomingWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 30,
  message: { error: 'Too many webhook deliveries from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

async function isValidWebhookUrl(urlString) {
  const result = await isSafeUrl(urlString);
  return result.safe;
}

function normalizeEvents(events) {
  if (!events || !Array.isArray(events)) return [];
  const allowed = new Set(ALL_WEBHOOK_EVENTS);
  return [...new Set(events.filter(e => typeof e === 'string' && allowed.has(e)))];
}

// KYC webhooks are handled at POST /api/webhooks/kyc (raw body + Persona signature verification).

router.post(
  '/incoming/:id',
  incomingWebhookLimiter,
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT id, user_id, secret, previous_secret, previous_secret_expires_at FROM webhooks WHERE id = $1 AND revoked_at IS NULL`,
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      const webhook = rows[0];
      const rawBody = req.body;

      // Some services might use variations like X-Signature-256 or x-signature
      const headerSig = req.headers['x-signature-256'] || req.headers['x-signature'];

      if (!headerSig) {
        return res.status(401).json({ error: 'Missing signature header' });
      }

      // Constant-time HMAC-SHA256 comparison (tolerates a `sha256=` prefix).
      async function tryVerifySecret(secretValue) {
        if (!secretValue) return false;
        let ok = false;
        if (isEncryptedIntegrationSecret(secretValue)) {
          await withDecryptedIntegrationSecret(
            secretValue,
            { type: 'webhook', id: webhook.user_id },
            decryptedSecret => {
              ok = verifyWebhookSignature(decryptedSecret, rawBody, headerSig);
            }
          );
        } else {
          ok = verifyWebhookSignature(secretValue, rawBody, headerSig);
        }
        return ok;
      }

      let verified = await tryVerifySecret(webhook.secret);

      // If current secret fails, try previous secret during grace period
      if (
        !verified &&
        webhook.previous_secret &&
        webhook.previous_secret_expires_at &&
        new Date(webhook.previous_secret_expires_at) > new Date()
      ) {
        verified = await tryVerifySecret(webhook.previous_secret);
      }

      if (!verified) {
        logger.warn('Failed webhook signature verification', { webhookId: req.params.id });
        return res.status(401).json({ error: 'Invalid signature' });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch (err) {
        return res.status(400).json({ error: 'Invalid JSON payload' });
      }

      const result = await processIncomingWebhook(webhook.id, payload, {
        ownerUserId: webhook.user_id,
      });

      res.status(200).json({ success: true, ...result });
    } catch (err) {
      if (err instanceof WebhookError) {
        logger.warn('Rejected incoming webhook', {
          webhookId: req.params.id,
          status: err.status,
          error: err.message,
        });
        return res.status(err.status).json({ error: err.message });
      }
      logger.error('Error processing incoming webhook', {
        error: err.message,
        webhookId: req.params.id,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Public webhook ingress is POST-only. Reject every other method (GET/HEAD/
// DELETE/...) with an explicit 405 instead of letting it fall through to the
// 404 handler — senders and scanners probing during setup get a clearer answer (#799).
// Registered after the POST handler above so valid POSTs are never affected.
router.all('/incoming/:id', (req, res) => {
  res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
});

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, url, events, secret_hint,
            created_at, revoked_at
     FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json(rows);
  })
);

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { url, events, backoff_strategy } = req.body || {};
    if (!url || !events) {
      return res.status(400).json({ error: 'url and events array are required' });
    }
    if (!(await isValidWebhookUrl(url))) {
      return res
        .status(400)
        .json({ error: 'url must be https, or http://localhost for development' });
    }
    const ev = normalizeEvents(events);
    if (!ev.length) {
      return res
        .status(400)
        .json({ error: `events must include at least one of: ${ALL_WEBHOOK_EVENTS.join(', ')}` });
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

    const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
    const secret_hint = `${secret.slice(0, 10)}…${secret.slice(-4)}`;
    const encryptedSecret = await encryptIntegrationSecret(secret, {
      type: 'webhook',
      id: req.user.userId,
    });
    const { rows } = await db.query(
      `INSERT INTO webhooks (user_id, url, events, secret, secret_hint, backoff_strategy)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, url, events, secret_hint, backoff_strategy, created_at`,
      [
        req.user.userId,
        url,
        ev,
        encryptedSecret,
        secret_hint,
        backoff_strategy ? JSON.stringify(backoff_strategy) : null,
      ]
    );

    await logCredentialEvent({
      actorId: req.user.userId,
      action: 'webhook_create',
      resourceType: 'webhook',
      resourceId: rows[0].id,
      req,
      metadata: { url, events: ev },
    });

    res.status(201).json({
      ...rows[0],
      secret,
      message: 'Store the signing secret; it is only shown once.',
    });
  })
);

router.patch(
  '/:id/backoff-strategy',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { backoff_strategy } = req.body || {};
    if (backoff_strategy !== null && !isValidBackoffStrategy(backoff_strategy)) {
      return res.status(400).json({
        error:
          'backoff_strategy must be { base_ms, max_ms, multiplier } with positive numbers, or null to reset to defaults',
      });
    }

    const { rows } = await db.query(
      `UPDATE webhooks SET backoff_strategy = $1::jsonb
     WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL
     RETURNING id, url, events, backoff_strategy`,
      [backoff_strategy ? JSON.stringify(backoff_strategy) : null, req.params.id, req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Webhook not found' });
    res.json(rows[0]);
  })
);

router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, url FROM webhooks WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [req.params.id, req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Webhook not found' });
    await db.query(`UPDATE webhooks SET revoked_at = NOW() WHERE id = $1`, [req.params.id]);
    await logCredentialEvent({
      actorId: req.user.userId,
      action: 'webhook_revoke',
      resourceType: 'webhook',
      resourceId: rows[0].id,
      req,
      metadata: { url: rows[0].url },
    });
    res.json({ revoked: true, id: rows[0].id });
  })
);

router.post(
  '/:id/rotate',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Grace period in hours (default 24h)
    const gracePeriodHours = Math.max(
      1,
      Math.min(72, parseInt(req.body.grace_period_hours || '24', 10))
    );
    const expiresAt = new Date(Date.now() + gracePeriodHours * 60 * 60 * 1000);

    const { rows: existingRows } = await db.query(
      `SELECT id, url, secret, secret_hint, secret_version FROM webhooks WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [req.params.id, req.user.userId]
    );

    if (!existingRows.length) return res.status(404).json({ error: 'Webhook not found' });

    const existing = existingRows[0];
    const newSecret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
    const newHint = `${newSecret.slice(0, 10)}…${newSecret.slice(-4)}`;
    const encryptedNewSecret = await encryptIntegrationSecret(newSecret, {
      type: 'webhook',
      id: req.user.userId,
    });

    const { rows: updatedRows } = await db.query(
      `UPDATE webhooks
     SET secret = $1, secret_hint = $2, secret_version = secret_version + 1,
         previous_secret = $3, previous_secret_hint = $4, previous_secret_version = secret_version,
         previous_secret_expires_at = $5
     WHERE id = $6
     RETURNING id, secret_version, previous_secret_expires_at`,
      [encryptedNewSecret, newHint, existing.secret, existing.secret_hint, expiresAt, existing.id]
    );

    await logCredentialEvent({
      actorId: req.user.userId,
      action: 'webhook_rotate',
      resourceType: 'webhook',
      resourceId: existing.id,
      req,
      metadata: { version: updatedRows[0].secret_version, expires_at: expiresAt },
    });

    res.status(201).json({
      id: existing.id,
      secret: newSecret,
      secret_hint: newHint,
      version: updatedRows[0].secret_version,
      previous_secret_expires_at: expiresAt,
      message: 'Store the new signing secret; it is only shown once.',
    });
  })
);

const SYNTHETIC_TEST_PAYLOADS = {
  'campaign.funded': {
    event: 'campaign.funded',
    campaign_id: '11111111-1111-4111-8111-111111111111',
    title: 'Solar Community Grid',
    target_amount: '10000.00',
    raised_amount: '10000.00',
    asset: 'USDC',
    test: true,
  },
  'contribution.received': {
    event: 'contribution.received',
    contribution_id: '22222222-2222-4222-8222-222222222222',
    campaign_id: '11111111-1111-4111-8111-111111111111',
    amount: '150.00',
    asset: 'USDC',
    tx_hash: 'tx_test_stellar_hash_00000000000000000000000000000000000000000000001',
    donor_wallet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    test: true,
  },
  'milestone.approved': {
    event: 'milestone.approved',
    campaign_id: '11111111-1111-4111-8111-111111111111',
    milestone_id: '33333333-3333-4333-8333-333333333333',
    title: 'Phase 1 Delivery',
    release_percentage: '30.00',
    test: true,
  },
  'withdrawal.completed': {
    event: 'withdrawal.completed',
    campaign_id: '11111111-1111-4111-8111-111111111111',
    withdrawal_id: '44444444-4444-4444-8444-444444444444',
    amount: '3000.00',
    asset: 'USDC',
    stellar_tx_hash: 'tx_test_stellar_hash_00000000000000000000000000000000000000000000002',
    test: true,
  },
};

function buildSyntheticPayload(eventType, webhook) {
  const base = SYNTHETIC_TEST_PAYLOADS[eventType] || {
    event: eventType,
    test: true,
    data: { message: `Synthetic test event for ${eventType}` },
  };
  return {
    ...base,
    webhook_id: webhook.id,
    timestamp: new Date().toISOString(),
  };
}

router.post(
  '/:id/test',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, url, events, secret, user_id FROM webhooks WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [req.params.id, req.user.userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const webhook = rows[0];
    let eventType = req.body?.event_type || req.body?.event;
    if (!eventType) {
      eventType = (webhook.events && webhook.events[0]) || 'contribution.received';
    }

    if (!ALL_WEBHOOK_EVENTS.includes(eventType) && !eventType.startsWith('test.')) {
      return res.status(400).json({
        error: `event_type must be one of: ${ALL_WEBHOOK_EVENTS.join(', ')}`,
      });
    }

    const payload = buildSyntheticPayload(eventType, webhook);

    const { rows: inserted } = await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending')
       RETURNING id, webhook_id, event_type, status, created_at`,
      [webhook.id, eventType, JSON.stringify(payload)]
    );

    const deliveryId = inserted[0].id;
    const startTime = Date.now();
    try {
      await processDelivery(deliveryId);
    } catch (dispatchErr) {
      logger.error('Failed to process test webhook delivery', {
        deliveryId,
        error: dispatchErr.message,
      });
    }
    const latencyMs = Math.max(1, Date.now() - startTime);

    const { rows: deliveryRows } = await db.query(
      `SELECT d.id, d.webhook_id, d.event_type, d.status, d.response_status,
              d.response_body_snippet, d.attempt_count, d.last_error, d.next_retry_at,
              d.delivered_at, d.created_at, d.updated_at, d.payload,
              w.url AS webhook_url
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.id = $1`,
      [deliveryId]
    );

    const delivery = deliveryRows[0] || inserted[0];

    try {
      await db.query(`UPDATE webhook_deliveries SET latency_ms = $1 WHERE id = $2`, [
        latencyMs,
        deliveryId,
      ]);
    } catch {
      // Ignore if latency_ms column is not present
    }

    await logCredentialEvent({
      actorId: req.user.userId,
      action: 'webhook_test_event',
      resourceType: 'webhook',
      resourceId: webhook.id,
      req,
      metadata: {
        eventType,
        deliveryId,
        status: delivery.status,
        responseStatus: delivery.response_status,
        latencyMs,
      },
    });

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

router.get(
  '/deliveries',
  requireAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const offset =
      req.query.offset !== undefined
        ? Math.max(0, parseInt(req.query.offset, 10) || 0)
        : req.query.page !== undefined
          ? Math.max(0, (parseInt(req.query.page, 10) || 1) - 1) * limit
          : 0;

    const webhookId = req.query.webhook_id || null;
    const status = req.query.status || null;
    const eventType = req.query.event_type || null;

    const conditions = ['w.user_id = $1'];
    const params = [req.user.userId];

    if (webhookId) {
      params.push(webhookId);
      conditions.push(`w.id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`d.status = $${params.length}`);
    }
    if (eventType) {
      params.push(eventType);
      conditions.push(`d.event_type = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       ${whereClause}`,
      params
    );
    const total = countRows[0]?.total || 0;

    const queryParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT d.id, d.webhook_id, d.event_type, d.status, d.response_status,
              d.response_body_snippet, d.attempt_count, d.last_error, d.next_retry_at,
              d.delivered_at, d.created_at, d.updated_at, d.signature_versions,
              d.payload,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(d.delivered_at, d.updated_at) - d.created_at)) * 1000)::int AS latency_ms,
              w.url AS webhook_url
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       ${whereClause}
       ORDER BY d.created_at DESC
       LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams
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

    if (
      req.query.paginate === 'true' ||
      req.query.page !== undefined ||
      req.query.offset !== undefined
    ) {
      return res.json({
        total,
        page,
        limit,
        offset,
        total_pages: totalPages,
        items: rows,
        deliveries: rows,
      });
    }

    res.json(rows);
  })
);

router.get(
  '/:id/deliveries',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: webhookRows } = await db.query(
      `SELECT id, url, events, revoked_at FROM webhooks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );

    if (!webhookRows.length) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const offset =
      req.query.offset !== undefined
        ? Math.max(0, parseInt(req.query.offset, 10) || 0)
        : req.query.page !== undefined
          ? Math.max(0, (parseInt(req.query.page, 10) || 1) - 1) * limit
          : 0;

    const status = req.query.status || null;
    const eventType = req.query.event_type || null;

    const conditions = ['d.webhook_id = $1'];
    const params = [req.params.id];

    if (status) {
      params.push(status);
      conditions.push(`d.status = $${params.length}`);
    }
    if (eventType) {
      params.push(eventType);
      conditions.push(`d.event_type = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total FROM webhook_deliveries d ${whereClause}`,
      params
    );
    const total = countRows[0]?.total || 0;

    const queryParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT d.id, d.webhook_id, d.event_type, d.status, d.response_status,
              d.response_body_snippet, d.attempt_count, d.last_error, d.next_retry_at,
              d.delivered_at, d.created_at, d.updated_at, d.signature_versions,
              d.payload,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(d.delivered_at, d.updated_at) - d.created_at)) * 1000)::int AS latency_ms,
              w.url AS webhook_url
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       ${whereClause}
       ORDER BY d.created_at DESC
       LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams
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
      webhook_id: req.params.id,
      webhook_url: webhookRows[0].url,
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

router.get(
  '/deliveries/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: deliveryRows } = await db.query(
      `SELECT d.id, d.webhook_id, d.event_type, d.status, d.response_status,
              d.response_body_snippet, d.attempt_count, d.last_error, d.next_retry_at,
              d.delivered_at, d.created_at, d.updated_at, d.signature_versions,
              d.payload,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(d.delivered_at, d.updated_at) - d.created_at)) * 1000)::int AS latency_ms,
              w.url AS webhook_url
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.id = $1 AND w.user_id = $2`,
      [req.params.id, req.user.userId]
    );

    if (!deliveryRows.length) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const { rows: attemptRows } = await db.query(
      `SELECT id, attempt_number, started_at, finished_at, response_status,
              succeeded, error_message,
              ROUND(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::int AS latency_ms
       FROM webhook_delivery_attempts
       WHERE delivery_kind = 'user' AND delivery_id = $1
       ORDER BY attempt_number ASC`,
      [req.params.id]
    );

    res.json({
      ...deliveryRows[0],
      attempts: attemptRows,
    });
  })
);

// Replay is a conditional state transition, so it serializes with the
// dispatcher's atomic claim (#838): a delivery can only be reset while it is
// terminal-failed or waiting for a retry, never while a worker holds it. The
// actual send still goes through the claim, so a replay racing the poller (or
// a double-clicked replay) results in exactly one attempt.
router.post(
  '/deliveries/:id/replay',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE webhook_deliveries d
     SET status = 'pending', attempt_count = 0, last_error = NULL,
         response_status = NULL, response_body_snippet = NULL,
         next_retry_at = NULL, delivered_at = NULL,
         lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
     FROM webhooks w
     WHERE d.id = $1 AND d.webhook_id = w.id AND w.user_id = $2
       AND w.revoked_at IS NULL
       AND d.status IN ('failed', 'retrying')
     RETURNING d.id`,
      [req.params.id, req.user.userId]
    );

    if (!rows.length) {
      const { rows: current } = await db.query(
        `SELECT d.id AS delivery_id, d.status
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.id = $1 AND w.user_id = $2`,
        [req.params.id, req.user.userId]
      );
      const existing = current[0];
      // Already queued or in flight (e.g. a repeated replay request): no-op.
      if (existing && (existing.status === 'pending' || existing.status === 'delivering')) {
        return res.json({ message: 'Replay already in progress', id: existing.delivery_id });
      }
      if (existing && existing.status === 'delivered') {
        return res
          .status(409)
          .json({ error: 'Delivery already succeeded', id: existing.delivery_id });
      }
      return res.status(404).json({ error: 'Failed delivery not found or not replayable' });
    }

    setImmediate(() => {
      processDelivery(rows[0].id).catch(err => {
        logger.error('Failed to replay webhook delivery', { err });
      });
    });

    res.json({ message: 'Replay queued', id: rows[0].id });
  })
);

module.exports = router;
