# Operations: automatic Stellar trustlines and custodial funding

CrowdPay hides trustline and reserve mechanics from contributors. The backend ensures custodial accounts can hold every **configured credit asset** (for example USDC and any entries in `STELLAR_EXTRA_ASSETS`) before money moves on-chain.

## When trustlines and funding run

1. **User registration (`POST /api/auth/register`)**  
   After the user row is stored, the API schedules **asynchronous** provisioning (same process, `setImmediate`):  
   - The generated custodial Stellar seed is envelope-encrypted before it is written to `users.wallet_secret_encrypted`.  
   - If the Stellar account does not exist yet, the **platform** submits `createAccount` with enough XLM for reserves plus all trustlines.  
   - The custodial **user master key** signs a `changeTrust` transaction for each missing configured credit asset.  
   Registration **always** returns `201` with a token even if Horizon is temporarily unavailable; failures are logged as `[users] Background Stellar funding/trustlines failed`.

2. **Contribution (`POST /api/contributions`)**  
   Before building or submitting a payment, the route **awaits** `ensureCustodialAccountFundedAndTrusted`. That repeats the same checks so a user who registered during an outage or before new assets were added still succeeds without manual trustline work. If setup fails, the API responds **`503`*** with:  
   `Wallet setup is still completing; please retry in a few seconds.`

3. **Campaign wallet creation (`createCampaignWallet` in `stellarService`)**  
   The funded campaign account receives **`changeTrust`** for **every** configured credit asset in one setup transaction (before multisig locks the account). Starting XLM on `createAccount` is sized from the number of those assets.

## Code entry points (for on-call / debugging)

| Routine | File | Role |
|--------|------|------|
| `ensureCustodialAccountFundedAndTrusted` | `src/services/stellarService.js` | Single entry used by contributions; runs funding then trustlines. |
| `fundCustodialAccountFromPlatformIfNeeded` | same | `createAccount` from `PLATFORM_SECRET_KEY` when the pubkey is not on the ledger. |
| `submitMissingTrustlinesForCustodialAccount` | same | Idempotent `changeTrust` batch for missing lines only. |
| `listCreditAssetCodes` | same | All supported codes except `XLM`. |
| Background hook | `src/routes/auth.js` | `setImmediate` after successful register. |

## Configuration

- **`USDC_ISSUER`** — required for USDC trustlines (same as today).  
- **`STELLAR_EXTRA_ASSETS`** — optional JSON map of additional `CODE → issuer`; each becomes a required trustline on new custodial and campaign accounts.  
- **`PLATFORM_SECRET_KEY`** — must hold enough XLM on the active network to pay `createAccount` and fees for expected signup volume.

## Monitoring

- Search logs for `[users] Background Stellar` and `[contributions] Custodial account setup failed`.  
- Spikes in contribution **503** responses with the wallet-setup message usually mean Horizon issues or an under-funded platform account.

## What end users do

Nothing. The product does not expose trustline or reserve steps in onboarding or contribution flows.

## Tamper-evident audit event hashes

Financial audit events are hashed so tampering with the audit trail can be detected. This applies to events written by the custodial funding and trustline routines described above.

- Every financial audit event records a deterministic SHA-256 hash over its canonicalized content (event type, actor, amount, asset, account ids, timestamp, and the previous event hash).
- The hash chain is append-only: each event includes the prior event's hash, so editing or removing any record breaks verification of all later events.
- Hashes are stored alongside the event and exposed on the audit trail read endpoints for external verification; the existing API/UI response shape is preserved with the hash fields added as additive properties.
- Verification is available to operators to detect tampering; a mismatch is reported as a security incident and requires review of the affected audit segment.

## Security and privacy notes

- Audit hashes are derived from event content already stored by the backend; no additional personally identifiable information is introduced.
- Hash computation is server-side and deterministic, so existing audit records can be verified without requiring access to secrets.
- No new public endpoints are added; hash fields are only returned to callers already authorized to read the audit trail.
