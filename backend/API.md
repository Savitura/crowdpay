# CrowdPay Backend API

## Interactive Swagger UI

In development, browse the interactive API docs at `GET /api/docs`.

## Important Notes

### Timestamps
All timestamps (like campaign deadlines) **must be in ISO 8601 format with a UTC timezone indicator (Z suffix)**, e.g., 2026-12-31T23:59:59.999Z. The server will treat all timestamps as UTC for validation and storage.

### Public API lifecycle
`GET /api/v1/changelog` returns the v1 changelog without authentication. To announce a sunset, configure both `PUBLIC_API_DEPRECATION_DATE` and `PUBLIC_API_SUNSET_DATE` as ISO 8601 timestamps, with the sunset later than the deprecation date. The v1 API will then include the RFC 9745 `Deprecation` header, the HTTP-date `Sunset` header, and a `Link` to the changelog on every response. Leave either variable unset to avoid announcing a deprecation.

## Recurring contribution architecture

The canonical subsystem for recurring contributions uses Stellar Claimable Balance schedules (`/api/campaigns/:id/subscriptions`). Complete architectural specifications, worker retry semantics, data model diagrams, and migration plans for superseded paths are documented in [`docs/recurring-contributions-architecture.md`](../docs/recurring-contributions-architecture.md).

### Subscriptions endpoints
- `POST /api/campaigns/:id/subscriptions` - Enable a recurring pledge on a campaign.
- `POST /api/campaigns/:id/subscriptions/prepare` - Prepare unsigned XDR for Freighter signing.
- `POST /api/campaigns/:id/subscriptions/submit` - Submit signed XDR from Freighter.
- `DELETE /api/campaigns/:id/subscriptions/:subscriptionId` - Cancel future installments (> 7 days out).
- `GET /api/subscriptions/mine` - List authenticated contributor's subscriptions and claim status.

> **Note on Deprecated Paths**: Legacy recurring contribution cron endpoints under `/api/users/me/recurring-contributions` (`recurring_contributions` table) are superseded and planned for deprecation. See the migration plan in `docs/recurring-contributions-architecture.md`.

## Contribution conversion model

- Campaigns define a default settlement asset via `campaigns.asset_type` (`USDC` or `XLM`).
- Contributors can pay using `send_asset`.
- If `send_asset !== campaign.asset_type`, the backend uses Stellar `pathPaymentStrictReceive` so the campaign receives the exact requested `amount` in its settlement asset.
- Conversion path discovery uses Stellar Horizon `strictReceivePaths` and applies a `5% `slippage buffer when computing `sendMax`.
- Additional credit assets can be enabled through `STELLAR_EXTRA_ASSETS` in `.env` as a JSON object (`{"CODE":"ISSUER"}`).

## Endpoints

### `GET /api/users/me`

Authenticated. Returns the current profile, including `email_verified` (boolean), `kyc_status` (`unverified`, `pending`, `verified`, `rejected`) and `kyc_completed_at`.

### Account data export

Authenticated users can request a portable JSON archive of their own records.

- `POST /api/users/me/exports` — queue an export. Returns `202` with the export
  id/status. A user may have only one `pending` export at a time (`409`).
- `GET /api/users/me/exports` — list the caller's exports and their status.
- `GET /api/users/me/exports/:id/download` — return a short-lived signed
  download URL for a completed export. The export id is always scoped to the
  authenticated user, so another user's export returns `404`. Completed
  archives expire after 24 hours (`410` after expiry) and download URLs expire
  after one hour.

The archive includes the scopes below. It never includes password hashes,
wallet secret ciphertext, API key hashes, device fingerprints, session IP
addresses/user agents, or any row belonging to another user.

| Scope | Contents |
|---|---|
| `profile` | Account id, email, name, role, wallet public key, created timestamp |
| `creator_campaigns` | Campaigns created by the caller |
| `creator_milestones` | Milestones belonging to the caller's campaigns |
| `campaign_updates` | Updates authored by the caller |
| `contributions` | Contributions sent from the caller's wallet |
| `notification_preferences` | Account-level notification settings |
| `category_follows` | Followed campaign categories |
| `notifications` | In-app notifications addressed to the caller |
| `referrals` | Referral links created by the caller |
| `disputes` | Disputes raised by the caller |
| `subscriptions` | Recurring contribution records |
| `credentials` | API-key metadata (never the key hash or secret) |
| `sessions` | Session id/timestamps and coarse region only |
| `campaign_budget_line_items` | Budget line items on the caller's campaigns |

Export requests and downloads are written to the append-only `audit_logs`
table as `user_data_export_requested` and `user_data_export_downloaded`.

### `GET /api/users/verify-email`

Public. Validates a verification token and marks the associated user's email as verified.

Query params:
- `token` (required): The UUID token sent via email.

Returns `200` on success or `400/410` the token is invalid or expired (> 24 hours).

### `POST /api/users/resend-verification`

Authenticated. Generates a new verification token and sends a new email.
Rate-limited to 3 requests per hour per user.

### `POST /api/users/me/kyc/start`

Authenticated. Creates a hosted KYC session with the configured provider and marks the user `pending`.

Response includes `redirect_url` or `session_token`, plus the updated user. Persona is used when `KYC_PROVIDER=persona`, `PERSONA_API_KEY`, and `PERSONA_TEMPLATE_ID` are configured; otherwise local development returns a dev redirect URL.

### `POST /api/webhooks/kyc`

KYC provider callback. Updates the matched user to `verified` or `rejected` from provider status. The campaign creation gate is controlled by `KYC_REQUIRED_FOR_CAMPAIGNS` and defaults to enabled; set it to `false` for testnet/dev.

### `POST /api/campaigns`

Authenticated creator/admin endpoint. The user must have `email_verified=true`. Additionally, when `KYC_REQUIRED_FOR_CAMPAIGNS` is not `false`, the user must have `kyc_status=verified`; otherwise the API returns `403` with `code=KYC_REQUIRED` or `code=EMAIL_NOT_VERIFIED`.

### Campaign budget line items

Campaign owners (and admins) can break a campaign's budget into line items and
track planned versus actual spending. All amounts are decimal strings in the
campaign's settlement asset (`campaigns.asset_type`), with up to 7 decimal places.
Line items are scoped to the campaign and authorized to the campaign owner or an
admin; other authenticated users receive `404`.

Line item object:

```json
{
  "id": "3f1a8c2e-2f44-45c7-8b1a-5e7d9c2a1b0f",
  "campaigin_id": "0f3f...",
  "category": "marketing",
  "description": "Paid social campaign",
  "planned_amount": "1500.0000000",
  "actual_amount": "1250.5000000",
  "variance": "-249.5000000",
  "utilization_percent": "83.3666667",
  "currency": "USDC",
  "created_at": "2026-01-15T12:00:00.000Z",
  "updated_at": "2026-02-01T09:00:00.000Z"
}
```

- `planned_amount` is required and must be greater than or equal to zero.
- `actual_amount` defaults to `0.0000000` when omitted.
- `variance` is `actual_amount - planned_amount` (negative means under budget).
- `utilization_percent` is `actual_amount / planned_amount * 100`, or `null` when
  `planned_amount` is zero.
- `currency` always mirrors the campaign's asset_type.

#### `GET /api/campaigns/:id/budget-line-items`

Authenticated. Returns the campaign's line items plus a rollup total.

```json
{
  "items": [/* line item objects */],
  "totals": {
    "planned_amount": "1500.0000000",
    "actual_amount": "1250.5000000",
    "variance": "-249.5000000",
    "utilization_percent": "83.3666667",
    "currency": "USDC"
  }
}
```

#### `POST /api/campaigns/:id/budget-line-items`

Authenticated campaign owner/admin. Creates a budget line item.

Body:
- `category` (required): string, 1-100 characters.
- `description` (optional): string, 0-280 characters.
- `planned_amount` (required): decimal string, `>= 0`.
- `actual_amount` (optional): decimal string, `>= 0`.

Response (`201`): the created line item object.

Errors:
- `400` missing/invalid fields (e.g. negative amount, too many decimals)
- `404` campaign not found or caller not authorized

#### `PATCH /api/campaigns/:id/budget-line-items/:itemId`

Authenticated campaign owner/admin. Updates any subset of `category`,
`description`, `planned_amount`, `actual_amount`. Returns the updated line item.

Errors:
- `400` invalid fields
- `404` item not found or caller not authorized

#### `DELETE /api/campaigns/:id/budget-line-items/:itemId`

Authenticated campaign owner/admin. Deletes a line item. Returns `204`.

Errors:
- `404` item not found or caller not authorized

#### `GET /api/campaigns/:id/budget-report`

Authenticated campaign owner/admin. Returns the planned-versus-actual report,
grouped by category and overall.

```json
{
  "campaign_id": "0f3f...",
  "currency": "USDC",
  "overall": {
    "planned_amount": "1500.0000000",
    "actual_amount": "1250.5000000",
    "variance": "-249.5000000",
    "utilization_percent": "83.3666667"
  },
  "categories": [
    {
      "category": "marketing",
      "planned_amount": "1500.0000000",
      "actual_amount": "1250.5000000",
      "variance": "-249.5000000",
      "utilization_percent": "83.3666667"
    }
  ]
}
```

Errors:
- `404` item not found or caller not authorized

> **Compatibility note**: these endpoints are additive. Existing campaign responses
 > are unchanged; budget data is only returned from the dedicated endpoints. A
 > migration is not required for clients that do not use budget reporting.

### `GET /api/contributions/quote`

Get a DEX Quote before submitting a conversion contribution.

Query params:

- `send_asset` (required): `XLM` or `USDC`
- `gift` (optional): `{ recipient_name, recipient_email, message? }`. The
  recipient is notified only after the Stellar payment is confirmed and
  indexed. `recipient_name` is limited to 100 characters, `recipient_email`
  must be valid, and `message` is limited to 280 characters.

Gift notifications are written to a database-backed outbox in the same
transaction that records the confirmed contribution. Email delivery retries
with exponential backoff; registered recipients also receive an in-app
notification. Gift data is not added to the public contribution response.
- `dest_asset` (required): `XLM` or `USDC`
- `dest_amount` (required): amount the campaign should receive

Success response (`200`):

```json
{
  "send_asset": "XLM",
  "dest_asset": "USDC",
  "dest_amount": "9",
  "quoted_source_amount": "10.0000000",
  "max_send_amount": "10.5000000",
  "estimated_rate": "0.900000000000000",
  "path": ["AQUA"],
  "path_count": 3
}
```

Errors:

- `400` missing/invalid params
- `404` no path found on Stellar DEX

### `POST /api/contributions`

Submit a contribution through the existing custodial wallet flow (direct payment or path payment).

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign must receive in campaign asset
- `send_asset` (required): `XLM` or `USDC`

Success response (`202`):

```json
{
  "tx_hash": "c8d6...",
  "message": "Transaction submitted",
  "conversion_quote": {
    "send_asset": "XLM",
    "campaign_asset": "USDC",
    "campaign_amount": "4.5000000",
    "quoted_source_amount": "5.0000000",
    "max_send_amount": "5.2500000",
    "path": []
  }
}
```

`conversion_quote` is `null` for direct same-asset contributions.

Errors:

- `400` missing fields / unsupported assets
- `404` campaign not found or not active
- `422` no conversion path found for requested asset pair

### `POST /api/contributions/prepare`

Prepare an unsigned Stellar transaction for a Freighter contribution without submitting it.

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign must receive in campaign asset
- `send_asset` (required): `XLM` or `USDC`
- `sender_public_key` (required): contributor wallet public key from Freighter

Success response (`200`):

```json
{
  "unsigned_xdr": "AAAAAgAAA...",
  "prepare_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "conversion_quote": null,
  "sender_public_key": "G...",
  "network_passphrase": "Test SDF Network ; September 2015",
  "network_name": "TESTNET"
}
```

`prepare_token` is short-lived and must be returned with the signed XDR to `/api/contributions/submit-signed`.

Errors:

- `400` missing fields / invalid Stellar public key / unsupported asset
- `404` campaign not found or not active
- `422` no conversion path found for requested asset pair

### `POST /api/contributions/submit-signed`

Submit a Freighter-signed contribution transaction after backend validation.

Body:

- `prepare_token` (required): opaque token returned by `/prepare`
- `signed_xdr` (required): transaction signed in Freighter

Success response (`202`):

```json
{
  "tx_hash": "c8d6...",
  "stellar_transaction_id": "0f3f...",
  "message": "Transaction submitted",
  "conversion_quote": null
}
```

Validation performed before submission:

- signed transaction source account must match `sender_public_key`
- signed transaction body hash must match the prepared unsigned XDR exactly
- signed transaction must contain a valid signature for the contributor public key

Errors:

- `400` missing fields / invalid prepare token
- `403` prepare token belongs to a different authenticated user
- `422` signed XDR does not match the prepared transaction
- `502` Stellar rejected the signed transaction

### `GET /api/anchor/info`

Returns the configured fiat on-ramp anchors and the CrowdPay asset codes currently enabled on Stellar.

### `POST /api/anchor/deposits/start`

Authenticated. Starts a SEP-24 hosted deposit session for the chosen anchor after backend SEP-10 authentication.

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign should ultimately receive
- `anchor_id` (required): anchor identifier from `/api/anchor/info`

Success response includes:

- anchor session `id`
- `interactive_url`
- `anchor_transaction_id`
- `anchor_asset` / `anchor_amount`
- `conversion_quote` when the eventual contribution needs a path payment

### `GET /api/anchor/deposits/:id`

Authenticated. Polls the anchor transaction, updates the local anchor session, and once the deposit completes automatically submits the normal Stellar contribution from the user’s custodial wallet.

## Anchor environment configuration

Anchor deposit support requires a configured backend anchor signing wallet and an enabled anchor.
Set `ANCHOR_WALLET_HOME_DOMAIN` and `ANCHOR_WALLET_SIGNING_SECRET` in the backend environment.
MoneyGram anchor support is enabled by default unless `ANCHOR_MONEYGRAM_ENABLED=false`.
Use `ANCHOR_MONEYGRAM_ENV=sandbox|preview|production` to select the MoneyGram deployment.

For a custom anchor, configure `ANCHOR_CUSTOM_ID`, `ANCHOR_CUSTOM_NAME`, `ANCHOR_CUSTOM_HOME_DOMAIN`, `ANCHOR_CUSTOM_WEB_AUTH_ENDPOINT`, `ANCHOR_CUSTOM_SEP24_ENDPOINT`, `ANCHOR_CUSTOM_SIGNING_KEY`, `ANCHOR_CUSTOM_ASSET_CODE`, and `ANCHOR_CUSTOM_ASSET_ISSUER`.

### `GET /api/contributions/campaign/:campaignId`

Fetch indexed contributions with conversion audit fields.

Success response (`200`):

```json
[
  {
    "id": "0f3f...",
    "sender_public_key": "G...",
    "amount": "4.5000000",
    "asset": "USDC",
    "payment_type": "path_payment_strict_receive",
    "source_amount": "4.9973210",
    "source_asset": "XLM",
    "conversion_rate": "0.900482150000000",
    "path": ["AQUA"],
    "tx_hash": "c8d6...",
    "created": "2026-01-15T12:00:00.000Z"
  }
]
```
