# Payout beneficiary allowlists

Apply migrations before enabling `PAYOUT_BENEFICIARY_ALLOWLIST_ENABLED=true` on every API and worker process. The opt-in flag preserves existing integrations; when enabled, absent, revoked, unapproved and delayed destinations fail closed. Existing schedules are checked on each run and withdrawal destinations are checked again at platform approval before signing.

Authorized database operators manage entries using `node scripts/payout-beneficiaries.js request|approve|revoke <campaign-id> <Stellar-public-key> <actor-user-id>`. Request requires the campaign creator; approval requires a different administrator. Approval starts a fixed 24-hour activation delay. Re-requesting resets approval and restarts the process; revocation is immediate. Only provisioned operator database credentials may invoke this tool; actor IDs are audit identities, not authentication tokens.

Seed and approve existing beneficiaries, wait 24 hours, then enable enforcement. This controls the primary withdrawal recipient; separately configured platform fees and referral commission recipients retain their existing policies. On-chain milestone releases are outside this custodial payout policy. No funds are transferred by the management tool.
