# Credential verification

Every secret that CrowdPay compares against a caller-supplied value is
compared in **constant time**. The rule is simple: a comparison that decides
whether a request is authenticated must not reveal how much of the guess was
correct.

## Why

A byte-by-byte comparison (`a === b`) stops at the first difference, so the
time it takes tells an attacker how many leading characters of a secret they
guessed correctly. Repeating the request and measuring the response turns
that into an oracle. Constant-time comparison removes the oracle: the same
number of bytes is always compared, no matter where the first difference is.

Only the _length_ of a value remains observable, which is unavoidable for any
fixed-size comparison. Signatures and hashes are therefore always compared
against a digest of a fixed length, and a length mismatch is treated as a
mismatch rather than as an early exit.

## The shared helper

All of these comparisons live in `backend/src/utils/constantTime.js`:

| Helper                                         | Use                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `timingSafeEqualStrings(a, b)`                 | UTF-8 string comparison (CSRF double-submit token).                |
| `timingSafeEqualHex(expected, provided)`       | Hex digest comparison (idempotency request hash, API key digests). |
| `verifyHmacSha256(secret, payload, signature)` | HMAC-SHA256 signature verification (webhooks).                     |
| `hmacSha256Hex(secret, payload)`               | Computes the expected digest for the helpers above.                |

All of them are built on Node's `crypto.timingSafeEqual`. Malformed input
(missing values, non-hex characters, unsupported hash formats) is rejected
without leaking a comparison result, and the comparison never throws.

## API key hashes

`backend/src/services/apiKeyService.js` verifies a presented key against the
stored hash in `verifyApiKeyHash()`:

- **bcrypt digests** (`$2a$`/`$2b$/`$2y$`) are verified with
`bcrypt.compare()`, which compares the derived key and the stored digest in
  constant time by construction. A digest that cannot be parsed fails closed
  instead of surfacing as a server error.
- **hex SHA-256 digests** are compared byte-for-byte with
  `crypto.timingSafeEqual`.
- Any other stored format is a mismatch: an unrecognised hash never
  authenticates a key.

Stored hashes are additionally encrypted at rest (see
`services/integrationSecrets.js`); the hash is decrypted inside the
verification call and never leaves the process.

## Webhook signatures

`backend/src/services/webhookService.js` exposes
`verifyWebhookSignature(secret, rawBody, headerSig)`, which computes the
expected HMAC-SHA256 digest of the exact signed bytes and compares it with
`crypto.timingSafeEqual`. A `sha256=` prefix and surrounding whitespace are
tolerated, because both are common sender conventions.

KYC provider callbacks (`POST /api/webhooks/kyc`) use the same helper through
`verifyPersonaWebhookSignature()` in `backend/src/services/kycProvider.js`.

## Related checks

- The CSRF double-submit token in `backend/src/middleware/csrf.js` is
  compared with `timingSafeEqualStrings()`.
- The idempotency request digest in `backend/src/middleware/idempotency.js` is
  compared with `timingSafeEqualHex()`.

## Adding a new secret comparison

Use the helpers above instead of `===`, `!==` or `localeCompare`. If a
comparison cannot be expressed with them, add a new helper to
`backend/src/utils/constantTime.js` and cover it with tests in
`backend/src/utils/constantTime.test.js`.
