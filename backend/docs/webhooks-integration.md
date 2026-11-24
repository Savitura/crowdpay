# Webhook integration for external systems

CrowdPay can `POST` JSON payloads to your HTTPS URL when lifecycle events occur. Configure endpoints and signing secrets under **Developer** in the app, or via `POST /api/webhooks` (JWT or API key with `developer` scope).

## Supported events

| Event | When it fires |
|-------|----------------|
| `campaign.funded` | A campaign’s `raised_amount` reaches `target_amount` (detected when a contribution is indexed). |
| `contribution.received` | A new contribution row is created from the ledger monitor. |
| `milestone.approved` | A milestone is approved by the platform operator (`POST /api/milestones/:id/approve`). |
| `withdrawal.completed` | A withdrawal is fully signed and submitted to Stellar (`status` becomes `submitted`). |

Deliveries are attempted immediately and, on failure, retried **up to 5 times** with exponential backoff (1s, 2s, 4s, … capped at 30s). A background poller also picks up due retries every 5 seconds.

## HTTP request

- **Method:** `POST`
- **Body:** UTF-8 JSON (the `payload` object documented per event).
- **Headers:**
  - `Content-Type: application/json`
  - `X-CrowdPay-Event`: event name (e.g. `contribution.received`)
  - `X-CrowdPay-Delivery-Id`: unique delivery UUID (for idempotency on your side)
  - `X-CrowdPay-Signature`: `v1=<hex>` or `v1=<hex1>, v2=<hex2>` during a secret rotation overlap. (Legacy endpoints may still receive `sha256=<hex>`). `<hex>` is the **HMAC-SHA256** of the **raw request body bytes** using your endpoint’s **webhook secret**.

## Verifying the signature (Node.js)

```javascript
const crypto = require('crypto');

function verifyCrowdPayWebhook(rawBodyBuffer, signatureHeader, secret) {
  if (!signatureHeader) return false;
  
  // Extract all signature hashes (vX=... or sha256=...)
  const signatures = signatureHeader.split(',').map(s => {
    const parts = s.trim().split('=');
    return parts.length === 2 ? parts[1] : null;
  }).filter(Boolean);

  if (signatures.length === 0) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBodyBuffer).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  // Verify if ANY of the provided signatures match our expected signature
  return signatures.some(sigHex => {
    try {
      const sigBuffer = Buffer.from(sigHex, 'hex');
      return sigBuffer.length === expectedBuffer.length && 
             crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
      return false;
    }
  });
}
```

Use the **raw** body string (before JSON parsing) so the signature matches what CrowdPay signed.

## Testing webhooks (test events)

Creators and developers can dispatch synthetic test events to verify their endpoint configuration, firewall rules, and signature verification logic before handling live payments.

### Trigger a test event

- **Endpoint:** `POST /api/webhooks/:id/test`
- **Auth:** Bearer JWT or API key with `developer` or `full` scope.
- **Request body (optional):**
  ```json
  {
    "event_type": "contribution.received"
  }
  ```
  If `event_type` is omitted, the test event defaults to the first configured event for the webhook.

- **Response:**
  ```json
  {
    "success": true,
    "message": "Test event delivered successfully",
    "latency_ms": 48,
    "delivery": {
      "id": "7b52ea74-4b9b-4b17-b715-0ddc7d23f462",
      "webhook_id": "060d4d8c-0f9c-48ae-8a4b-9e2c694f71a9",
      "event_type": "contribution.received",
      "status": "delivered",
      "response_status": 200,
      "response_body_snippet": "{\"received\":true}",
      "attempt_count": 1,
      "latency_ms": 48,
      "delivered_at": "2026-10-22T14:30:00.000Z",
      "created_at": "2026-10-22T14:29:59.950Z",
      "payload": {
        "event": "contribution.received",
        "contribution_id": "22222222-2222-4222-8222-222222222222",
        "campaign_id": "11111111-1111-4111-8111-111111111111",
        "amount": "150.00",
        "asset": "USDC",
        "test": true
      }
    }
  }
  ```

All test events pass through the standard delivery pipeline (`safeFetch`, HMAC signing with current/previous secrets, SSRF guards, latency measurement, and attempt persistence), so the logs accurately reflect real network and application behavior.

---

## Webhook delivery logs & pagination

Every webhook delivery attempt is recorded with its response status code, latency (in milliseconds), error messages, and payload snippets.

### List all deliveries

- **Endpoint:** `GET /api/webhooks/deliveries`
- **Query parameters:**
  - `limit`: number of items per page (1–200, default 50).
  - `offset`: zero-based offset (default 0).
  - `page`: 1-based page number (alternative to offset).
  - `webhook_id`: filter by specific webhook endpoint.
  - `status`: filter by status (`pending`, `delivering`, `delivered`, `failed`, `retrying`).
  - `event_type`: filter by event name (e.g. `contribution.received`).
  - `paginate`: set to `true` (or supply `page`/`offset`) to receive an enveloped response with pagination metadata.

- **Response envelope (`?paginate=true` or `?page=1`):**
  ```json
  {
    "total": 128,
    "page": 1,
    "limit": 50,
    "offset": 0,
    "total_pages": 3,
    "deliveries": [
      {
        "id": "7b52ea74-4b9b-4b17-b715-0ddc7d23f462",
        "webhook_id": "060d4d8c-0f9c-48ae-8a4b-9e2c694f71a9",
        "event_type": "contribution.received",
        "status": "delivered",
        "response_status": 200,
        "latency_ms": 48,
        "attempt_count": 1,
        "created_at": "2026-10-22T14:29:59.950Z",
        "webhook_url": "https://example.com/crowdpay-webhook"
      }
    ]
  }
  ```
  *(Legacy requests without `page`, `offset`, or `paginate` receive a direct array with pagination response headers: `X-Total-Count`, `X-Page`, `X-Total-Pages`, `X-Limit`, `X-Offset`)*.

### Scoped endpoint delivery logs

- **Endpoint:** `GET /api/webhooks/:id/deliveries`
  Returns the paginated delivery trail scoped strictly to webhook `:id`.

### Single delivery details

- **Endpoint:** `GET /api/webhooks/deliveries/:id`
  Returns the complete delivery object, full payload, response body snippet, and individual attempt timestamps and latencies from `webhook_delivery_attempts`.

### Replay a delivery

- **Endpoint:** `POST /api/webhooks/deliveries/:id/replay`
  Resets a `failed` or `retrying` delivery back to `pending` and immediately re-enqueues it for dispatch through the safe worker pipeline.

---

## Campaign-level webhooks

Campaign creators can also register webhooks scoped to specific campaigns (such as notifying their own e-commerce or ticketing systems when contributions are indexed on Stellar):

- `POST /api/campaigns/:id/webhooks`: Register endpoint (up to 5 active per campaign).
- `GET /api/campaigns/:id/webhooks`: List active campaign webhooks and secret hints.
- `DELETE /api/campaigns/:id/webhooks/:wid`: Deactivate webhook endpoint.
- `POST /api/campaigns/:id/webhooks/:wid/test`: Dispatch synthetic test event to verify endpoint.
- `GET /api/campaigns/:id/webhooks/:wid/deliveries`: Paginated delivery logs for campaign webhook.
- `POST /api/campaigns/:id/webhooks/:wid/deliveries/:deliveryId/replay`: Replay failed delivery.

---

## Retention & operational policies

- **Delivery logs:** Delivery records and attempt histories are retained for observability. Delivered records are immutable.
- **Dead letters:** Deliveries that fail after all maximum retries are recorded in `webhook_dead_letters`, and notification emails are sent to the creator.
- **SSRF protection:** Private and cloud metadata IP ranges (e.g., `10.0.0.0/8`, `169.254.169.254`, `192.168.0.0/16`) and DNS rebinding attacks are blocked at both endpoint registration and network execution.

---

## API keys (server-to-server)

Create keys with `POST /api/api-keys`. Send `Authorization: Bearer cp_live_<secret>` on CrowdPay API requests.

**Scopes:**

- `read` — all `GET`/`HEAD` authenticated routes (and public routes stay public).
- `write` — create/update resources except withdrawal **mutations** and developer routes.
- `withdrawals` — withdrawal actions (`POST` under `/api/withdrawals` except pure reads).
- `developer` — manage API keys and webhooks (`/api/api-keys`, `/api/webhooks`).
- `full` — equivalent to all of the above.

Set `API_KEY_PEPPER` in production (falls back to `JWT_SECRET` only for local dev).
