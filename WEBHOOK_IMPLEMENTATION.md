# Campaign Webhook Notifications Implementation

## Overview
This document describes the implementation of webhook notifications for CrowdPay campaigns (Issue #177). Campaign creators can now register webhook URLs to receive real-time notifications when contributions arrive, enabling them to integrate CrowdPay into their own systems.

## Architecture

### Database Schema
Created new tables to support campaign-level webhooks:

```sql
CREATE TABLE campaign_webhooks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,   -- HMAC signing secret
  events        TEXT[] NOT NULL DEFAULT ARRAY['contribution.indexed'],
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE campaign_webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID NOT NULL REFERENCES campaign_webhooks(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  response_status INT,
  delivered_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  error           TEXT,
  attempt_count   INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  last_error      TEXT,
  next_retry_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

**Migration file**: `backend/db/migrations/20260602_campaign_webhooks.sql`

### API Endpoints

#### Register a Webhook
```http
POST /api/campaigns/:id/webhooks
Authorization: Bearer {token}
Content-Type: application/json

{
  "url": "https://example.com/webhooks/crowdpay",
  "events": ["contribution.indexed"]
}

Response (201):
{
  "id": "wh-uuid",
  "campaign_id": "campaign-uuid",
  "url": "https://example.com/webhooks/crowdpay",
  "events": ["contribution.indexed"],
  "created_at": "2026-06-02T00:00:00Z",
  "secret": "hex-string-shown-only-once",
  "message": "Store the signing secret; it is only shown once."
}
```

#### List Webhooks
```http
GET /api/campaigns/:id/webhooks
Authorization: Bearer {token}

Response (200):
[
  {
    "id": "wh-uuid",
    "url": "https://example.com/webhooks/crowdpay",
    "events": ["contribution.indexed"],
    "active": true,
    "created_at": "2026-06-02T00:00:00Z",
    "secret_hint": "1234567890…abcdef"
  }
]
```

#### Delete a Webhook
```http
DELETE /api/campaigns/:id/webhooks/:wid
Authorization: Bearer {token}

Response (200):
{
  "revoked": true,
  "id": "wh-uuid"
}
```

#### View Delivery History
```http
GET /api/campaigns/:id/webhooks/:wid/deliveries?limit=50&offset=0
Authorization: Bearer {token}

Response (200):
{
  "total": 42,
  "limit": 50,
  "offset": 0,
  "deliveries": [
    {
      "id": "del-uuid",
      "event": "contribution.indexed",
      "status": "delivered",
      "response_status": 200,
      "attempt_count": 1,
      "last_error": null,
      "delivered_at": "2026-06-02T10:30:00Z",
      "failed_at": null,
      "created_at": "2026-06-02T10:29:00Z",
      "updated_at": "2026-06-02T10:30:00Z"
    }
  ]
}
```

### Webhook Payload

When a contribution is indexed, a POST request is sent to the webhook URL:

```http
POST {webhook_url}
Content-Type: application/json
X-CrowdPay-Signature: sha256={hmac_hex}
X-CrowdPay-Event: contribution.indexed
X-CrowdPay-Delivery-Id: {delivery_uuid}

{
  "campaign_id": "uuid",
  "tx_hash": "hash-string",
  "amount": "100.5000000",
  "asset": "USDC",
  "sender": "GXXXXXXX...",
  "timestamp": "2026-06-02T10:29:00Z"
}
```

### Signature Verification

Each webhook delivery includes an `X-CrowdPay-Signature` header containing an HMAC-SHA256 signature of the JSON payload using the webhook's secret:

```javascript
// Verification example in Node.js
const crypto = require('crypto');
const payload = JSON.stringify(req.body);
const secret = process.env.CROWDPAY_WEBHOOK_SECRET;
const signature = crypto
  .createHmac('sha256', secret)
  .update(payload, 'utf8')
  .digest('hex');
const isValid = signature === req.headers['x-crowdpay-signature'].replace('sha256=', '');
```

### Retry Logic

Failed deliveries are automatically retried up to 3 times with exponential backoff:

- **Attempt 1**: Immediate delivery
- **Attempt 2**: 5 seconds delay
- **Attempt 3**: 30 seconds delay
- **Attempt 4**: 5 minutes (300 seconds) delay

After 3 retries, the delivery is marked as failed. Webhook failures do not block contribution indexing.

### Implementation Details

#### Files Modified/Created

1. **Database Migration**
   - `backend/db/migrations/20260602_campaign_webhooks.sql`
   - Creates campaign_webhooks and campaign_webhook_deliveries tables with proper indexes

2. **Webhook Dispatcher Service**
   - `backend/src/services/webhookDispatcher.js`
   - Added `emitWebhookEventForCampaign()` function for campaign-level webhook dispatch
   - Added `processCampaignWebhookDelivery()` for processing individual deliveries
   - Added `scheduleCampaignWebhookRetry()` for retry scheduling
   - Added `backoffMsForCampaign()` for campaign-specific exponential backoff
   - Updated `startWebhookRetryPoller()` to also process campaign webhook retries
   - Exports: `emitWebhookEventForCampaign`, `processCampaignWebhookDelivery`, `MAX_CAMPAIGN_DELIVERY_ATTEMPTS`

3. **Campaign Routes**
   - `backend/src/routes/campaigns.js`
   - Added POST `/api/campaigns/:id/webhooks` - Register webhook
   - Added GET `/api/campaigns/:id/webhooks` - List webhooks
   - Added DELETE `/api/campaigns/:id/webhooks/:wid` - Disable webhook
   - Added GET `/api/campaigns/:id/webhooks/:wid/deliveries` - Delivery history
   - URL validation ensures HTTPS or localhost HTTP only
   - Enforces 5 webhook limit per campaign

4. **Ledger Monitor Integration**
   - `backend/src/services/ledgerMonitor.js`
   - Updated to import `emitWebhookEventForCampaign`
   - Added call to dispatch `WEBHOOK_EVENTS.CONTRIBUTION_INDEXED` after contribution indexing
   - Payload includes: campaign_id, tx_hash, amount, asset, sender, timestamp

5. **Test Suite**
   - `backend/src/routes/campaigns.test.js`
   - Added comprehensive tests for webhook registration
   - Added tests for webhook listing
   - Added tests for webhook deletion
   - Added tests for delivery history retrieval
   - Added tests for URL validation
   - Added tests for webhook limit enforcement

## Acceptance Criteria - Verification

✅ **Creators can register up to 5 webhook URLs per campaign**
- Enforced in POST `/api/campaigns/:id/webhooks` (returns 429 if limit exceeded)

✅ **Every indexed contribution triggers a POST to all registered webhooks**
- Dispatched in `ledgerMonitor.js` after contribution is committed
- Queries active webhooks subscribed to `contribution.indexed` event

✅ **Payload includes tx_hash, amount, asset, sender public key, and timestamp**
- Payload structure: `{ campaign_id, tx_hash, amount, asset, sender, timestamp }`

✅ **X-CrowdPay-Signature HMAC-SHA256 header is included in every delivery**
- Generated using `hmacSignature(secret, payloadJson)` 
- Header format: `X-CrowdPay-Signature: sha256={hex_signature}`

✅ **Failed deliveries are retried up to 3 times**
- Retries: immediate, 5s, 30s, 5min delays
- MAX_CAMPAIGN_DELIVERY_ATTEMPTS = 3

✅ **Delivery history (status, response code, timestamp) is viewable by the creator**
- GET `/api/campaigns/:id/webhooks/:wid/deliveries` endpoint
- Returns: status, response_status, attempt_count, delivered_at, failed_at, created_at, etc.

✅ **Webhook sending failure does not affect the contribution indexing transaction**
- Webhook dispatch happens in `setImmediate()` after COMMIT
- Uses `.catch()` to handle errors gracefully

## Security Considerations

1. **Secret Storage**: The webhook secret is stored in plaintext in the database. In production, consider hashing the secret and providing it only during creation.

2. **URL Validation**: Only HTTPS URLs are allowed (except localhost for development).

3. **Rate Limiting**: Consider adding rate limiting to webhook dispatch to prevent cascading failures.

4. **Payload Size**: Payloads are limited by the existing `express.json()` middleware (50kb limit).

## Testing

Run the test suite to verify webhook functionality:

```bash
cd backend
npm test
```

Test cases cover:
- Webhook registration with valid/invalid URLs
- Webhook listing
- Webhook deletion
- Delivery history retrieval
- Webhook limit enforcement
- Error handling

## Future Enhancements

1. **Secret Rotation**: Implement automatic secret rotation
2. **Event Filtering**: Allow creators to filter by event type or amount threshold
3. **Webhook Signing**: Support additional signing algorithms (RS256, etc.)
4. **Retry Strategies**: Allow creators to configure retry behavior
5. **Webhook Testing**: Add ability to send test webhook events
6. **Webhook Analytics**: Dashboard showing delivery success rates and latency
