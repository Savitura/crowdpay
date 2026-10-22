# Webhook integration for external systems

CrowdPay can `POST` JSON payloads to your HTTPS URL when lifecycle events occur. Configure endpoints and signing secrets under **Developer** in the app, or via `POST /api/webhooks` (JWT or API key with `developer` scope).

## Supported events

| Event | When it fires |
|-------|----------------|
| `campaign.funded` | A campaign’s `raised_amount` reaches `target_amount` (detected when a contribution is indexed). |
| `contribution.received` | A new contribution row is created from the ledger monitor. |
| `milestone.approved` | A milestone is approved by the platform operator (`POST /api/milestones/:id/approve`). |
| `withdrawal.completed` | A withdrawal is fully signed and submitted to Stellar (`status` becomes `submitted`). |

The full list of event names is `ALL_WEBHOOK_EVENTS` in `backend/src/services/webhookDispatcher.js`. Each event is queued once per active endpoint subscribed to it and sent right away; see [Retries and duplicate deliveries](#retries-and-duplicate-deliveries) for what happens when your endpoint does not answer with a 2xx.

## HTTP request

- **Method:** `POST`
- **Body:** compact UTF-8 JSON (the `payload` object of the event).
- **Timeout:** CrowdPay waits 9 seconds for a response. Any 2xx status marks the delivery as delivered; any other status, a network error or a timeout is a failed attempt.
- **Headers:**

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-CrowdPay-Event` | Event name, for example `campaign.funded`. |
| `X-CrowdPay-Delivery-Id` | UUID of the delivery. It is the same on every retry and manual replay of that delivery, so use it as your deduplication key. |
| `X-CrowdPay-Signature` | One or two comma separated `v<version>=<hex>` entries, described below. |

## Signature

`<hex>` is the lowercase hex **HMAC-SHA256** of the **raw request body bytes**, keyed with the endpoint's signing secret (the whole `whsec_...` string, as UTF-8). The signing code is `hmacSignature()` in `backend/src/services/webhookDispatcher.js`.

- **Only the body is signed.** The URL, the headers (including `X-CrowdPay-Event` and `X-CrowdPay-Delivery-Id`) and the time of the request are not covered by the signature, and there is no timestamp or nonce header.
- **Version label.** `<version>` is the secret version: `1` for a new endpoint, plus one on every rotation. Outside a rotation the header carries one entry, for example `v1=<hex>`. During a rotation grace period it carries the current secret first and the previous one second, separated by a comma and a space: `v3=<hex>, v2=<hex>`.
- **Body bytes.** Payloads are stored as PostgreSQL `JSONB` and the body is that stored value serialized again, so key order follows JSONB storage (shorter keys first), not the order used in the code. Always verify the bytes you received and never re-serialize the parsed JSON before checking the signature.
- **No `sha256=` prefix.** Earlier versions of this guide mentioned a `sha256=<hex>` header value. Since signing secrets became versioned, deliveries only use the `v<version>=<hex>` format.
- **Each attempt is signed when it is sent,** with the secrets that are valid at that moment. A retry that happens after a rotation therefore carries the new signatures, while the body and the delivery id stay the same.
- **The secret** is generated when the endpoint is created (`whsec_` followed by 64 hex characters, from 32 random bytes) and returned once in the `POST /api/webhooks` response. CrowdPay stores it encrypted; `GET /api/webhooks` only returns a `secret_hint`.

## Verifying the signature (Node.js)

The function below accepts the header if any entry matches any of the secrets you pass, which is what you need during a rotation. Both sides of `timingSafeEqual` are 32 bytes because the regular expression only keeps 64 character hex values.

<!-- verify-example -->
```javascript
const crypto = require('crypto');

function verifyCrowdPaySignature(rawBody, signatureHeader, secrets) {
  if (typeof signatureHeader !== 'string') return false;
  const provided = signatureHeader
    .split(',')
    .map(entry => /^v\d+=([0-9a-f]{64})$/.exec(entry.trim()))
    .filter(Boolean)
    .map(match => Buffer.from(match[1], 'hex'));
  return secrets.some(secret => {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    return provided.some(signature => crypto.timingSafeEqual(signature, expected));
  });
}
```

Use it on the **raw** body, before any JSON parsing. With Express, mount `express.raw()` on the webhook route so `req.body` is a `Buffer`:

```javascript
app.post('/crowdpay/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  const secrets = [process.env.CROWDPAY_WEBHOOK_SECRET, process.env.CROWDPAY_WEBHOOK_OLD_SECRET];
  const signature = req.get('X-CrowdPay-Signature');
  if (!verifyCrowdPaySignature(req.body, signature, secrets.filter(Boolean))) {
    return res.status(401).end();
  }
  const payload = JSON.parse(req.body.toString('utf8'));
  await handleOnce(req.get('X-CrowdPay-Delivery-Id'), req.get('X-CrowdPay-Event'), payload);
  return res.status(200).end();
});
```

`handleOnce` stands for your own code: it records the delivery id under a unique constraint in the same transaction as the work the event triggers, and does nothing when the id is already recorded. Recording the id in a separate step before the work would lose the event if the work then failed, because the retry would be skipped as a duplicate.

## Test vector

This is a delivery of `campaign.funded` sent during a rotation grace period, with two example secrets. `backend/src/services/webhookDispatcher.signing.test.js` reads this block and the verification function above and checks both against the dispatcher, so the test fails if the signing code and this guide disagree.

<!-- signing-test-vector -->
```text
previous secret (v1): whsec_example_previous_secret
current secret (v2): whsec_example_current_secret
X-CrowdPay-Event: campaign.funded
X-CrowdPay-Delivery-Id: 0b8f3c2e-6a1d-4f5e-9c7b-2d4e6f8a0b1c
body: {"campaign":{"title":"School fees for 40 pupils","status":"funded","timestamp":"2026-10-21T12:00:00.000Z","campaign_id":"5f0c7a4e-2b1d-4c3a-9e8f-1a2b3c4d5e6f","raised_amount":"5000.0000000","target_amount":"5000.0000000"}}
X-CrowdPay-Signature: v2=e8b40ac3bc1172ea4cf2fca3f7b834159298488bfec92df89cb9efe11d179a3b, v1=7448d3d45b9eb5c1be00bc6f6936b9a7b19391a4f78e9529afbac1f18df26f8b
```

The body is a single line with no trailing newline. Once the grace period has ended the same delivery is sent with `X-CrowdPay-Signature: v2=e8b40ac3bc1172ea4cf2fca3f7b834159298488bfec92df89cb9efe11d179a3b` only.

## Retries and duplicate deliveries

The same delivery (same `X-CrowdPay-Delivery-Id`, same body) can reach you more than once:

- **Retries.** A delivery is attempted up to **5 times** in total. The default waits after attempts 1 to 4 are 1 minute, 5 minutes, 30 minutes and 2 hours, so the last automatic attempt happens about 2 hours 36 minutes after the first one. A per endpoint `backoff_strategy` (`{ "base_ms", "max_ms", "multiplier" }`, set on `POST /api/webhooks` or `PATCH /api/webhooks/:id/backoff-strategy`) replaces those waits with `min(max_ms, base_ms * multiplier^(attempt - 1))`. A background poller picks up due retries every 5 seconds. After the last failed attempt the delivery is marked `failed`, recorded as a dead letter and the endpoint owner gets an email. A URL that the SSRF guard blocks fails at once, without retries.
- **Timeouts.** If your endpoint processes a request but answers after 9 seconds, CrowdPay counts the attempt as failed and sends it again.
- **Interrupted workers.** Every attempt holds a 60 second lease. If the process sending it stops before recording the outcome, another worker sends the delivery again after the lease expires.
- **Manual replay.** `POST /api/webhooks/deliveries/:id/replay` sends a `failed` or `retrying` delivery again and resets its attempt count. A delivered one cannot be replayed (409).

## Replay protection

CrowdPay does not enforce a replay window on outgoing deliveries: the signature covers the body only and never expires, so a captured request still verifies for as long as your receiver accepts the secret that signed it. Protect your endpoint as follows:

1. **Use HTTPS.** Endpoint URLs must be `https://`; plain `http://` is only accepted for `localhost` outside production.
2. **Verify the signature first,** on the raw body, and answer 401 when it does not match.
3. **Deduplicate on `X-CrowdPay-Delivery-Id`.** Store processed ids under a unique constraint, in the same transaction as the work, and answer 2xx to a duplicate without processing it again, so CrowdPay stops retrying. Keep the ids at least as long as a replay is possible: automatic retries span about 2 hours 36 minutes with the default schedule, a custom `backoff_strategy` can stretch that, and a manual replay can resend a failed delivery later.
4. **Make handlers idempotent on the business identifiers in the body** (for example `campaign_id` with the event name). The delivery id and event headers are not signed, so this is what protects you if someone resends a captured body under a new delivery id.
5. **Do not use a payload `timestamp` as a freshness check.** Some payloads (`campaign.funded`, `campaign.failed`) carry a `timestamp` field: it is the time the event was emitted, it is not present on every event, and retries and replays resend it unchanged, so rejecting old values would drop legitimate retries.
6. **Answer quickly** (well under 9 seconds) to avoid duplicates caused by timeouts. When the work is slow, record the delivery id together with a job in your own queue, answer, then run the job.

## Secret rotation

Rotate a secret with `POST /api/webhooks/:id/rotate` (same authentication as the other `/api/webhooks` routes). The optional body `{ "grace_period_hours": 24 }` sets how long the previous secret keeps signing: 24 hours when omitted, clamped between 1 and 72. The Developer page rotates with a 24 hour grace period. The `201` response contains `id`, the new `secret` (shown only once), `secret_hint`, `version` and `previous_secret_expires_at`.

What happens:

- The new secret becomes current with `version` incremented. The secret that was current is kept as the previous secret until `previous_secret_expires_at`.
- Until then every attempt is signed with both secrets (`v<new>=<hex>, v<old>=<hex>`). From the first attempt after that time, only `v<new>=<hex>` is sent. The check uses the backend server clock at the time of each attempt.
- Only one previous secret is kept. Rotating again inside a grace period makes the secret that was current the previous one and drops the older one at once; the grace period restarts from the new rotation.
- Deleting the endpoint (`DELETE /api/webhooks/:id`) stops its pending deliveries as well as future ones: they are closed as `failed` with `webhook revoked`.

Recommended procedure:

1. Call the rotate endpoint and store the new secret next to the current one in your receiver's configuration.
2. Deploy the receiver so that it accepts a signature made with either secret, as `verifyCrowdPaySignature` does with a list of secrets.
3. After `previous_secret_expires_at`, remove the old secret from the receiver.

If a secret leaks, rotate twice in a row (for example with `{ "grace_period_hours": 1 }` on the second call). After the second rotation CrowdPay no longer signs with the leaked secret. Configure your receiver with the newest secret, plus the intermediate one for the short grace period, and remove the leaked secret from it right away.

### Campaign webhooks

Campaign level endpoints (the `campaign_webhooks` table, used for events such as `contribution.indexed`) are sent with the same headers and the same HMAC-SHA256 over the raw body, but always with a single `v1=<hex>` entry: they have no versioned secrets and no rotation endpoint. They are attempted at most 3 times, 5 seconds and 30 seconds apart by default. There is no public API to register them today.

## Inbound webhooks are verified differently

`POST /api/webhooks/incoming/:id`, where external systems push updates **to** CrowdPay, uses the same endpoint secret but a different header: `X-Signature-256` (or `X-Signature`) holding a single hex HMAC-SHA256 of the raw body, optionally prefixed with `sha256=`, rather than the `v<version>=` list. It accepts the current secret, or the previous one during a rotation grace period, does not check a timestamp either, and is rate limited to 30 requests per minute per IP. The KYC webhook (`/api/webhooks/kyc`) and the SEP-24 anchor callbacks (`/api/anchor/callbacks`) follow their providers' own signature schemes and are not covered here.

## API keys (server-to-server)

Create keys with `POST /api/api-keys`. Send `Authorization: Bearer cp_live_<secret>` on CrowdPay API requests.

**Scopes:**

- `read` — all `GET`/`HEAD` authenticated routes (and public routes stay public).
- `write` — create/update resources except withdrawal **mutations** and developer routes.
- `withdrawals` — withdrawal actions (`POST` under `/api/withdrawals` except pure reads).
- `developer` — manage API keys and webhooks (`/api/api-keys`, `/api/webhooks`).
- `full` — equivalent to all of the above.

Set `API_KEY_PEPPER` in production (falls back to `JWT_SECRET` only for local dev).
