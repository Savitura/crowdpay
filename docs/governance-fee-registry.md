# Fee registry and governance

The platform fee and the creator revenue share live on-chain in the Soroban fee
registry contract (`contracts/soroban/contracts/fee_registry/`) instead of in
backend config. Token holders propose changes, vote during a fixed window, and
an executed proposal becomes the active fee. The backend reads the fee, caches
it, and uses it for contribution and withdrawal math.

## Contract interface

| Function | Auth | Notes |
|---|---|---|
| `initialize(admin, governance_token, initial_platform_fee_bps, initial_creator_share_bps)` | `admin` signs | One-shot; a second call panics |
| `get_fee()` / `get_creator_share()` | read-only | `0` if unset |
| `propose_change(proposer, new_fee_bps, new_creator_share_bps)` | `proposer` signs | Requires `MIN_TOKEN_BALANCE` of the governance token |
| `vote(voter, proposal_id, in_favor)` | `voter` signs | One vote per address per proposal, weighted by token balance |
| `execute_proposal(proposal_id)` | none | Only after the deadline; passes on majority **and** quorum |
| `admin_set_fee(admin, new_fee_bps, new_creator_share_bps)` | stored admin signs | Emergency path, see below |
| `get_vote_status(proposal_id, voter)` | read-only | |

### Fee bounds

Every path that stores a fee — `initialize`, `propose_change`, `admin_set_fee` —
runs the same validation:

- platform fee `<= MAX_FEE_BPS` (1000 BPS / 10%), matching the escrow contract,
  which rejects anything above that cap anyway
- creator share `<= MAX_CREATOR_SHARE_BPS` (10000 BPS / 100%), since the share is
  a percentage of collected platform fees

### `admin_set_fee` and its auth

`admin_set_fee` takes the admin address as an argument, but that argument is only
a claim. If it does not match the admin in storage the call panics, and when it
does match the stored admin still has to sign. Earlier revisions checked
`if admin != stored_admin { admin.require_auth() }`, which let anyone set the fee:
passing the real admin address skipped the auth check entirely, and passing the
caller's own address was satisfied by the caller signing for itself. The
regressions are covered in `contracts/soroban/contracts/fee_registry/src/test.rs`.

### Voting constants

- `PROPOSAL_VOTING_PERIOD` — 7 days from proposal creation
- `MIN_TOKEN_BALANCE` — 1000 governance tokens to propose
- `QUORUM_THRESHOLD` — 1000 tokens of `votes_for` (10% of a 10,000 token supply)
- One active proposal at a time; a proposal that fails quorum is recorded as
  `Failed` and leaves the fees untouched

## Backend

`backend/src/services/feeRegistry.js` reads `get_fee` / `get_creator_share` from
the contract, caches both for 5 minutes, and exposes `calculatePlatformFee()` and
`calculateCreatorShare()` to the contribution and withdrawal flows. If
`FEE_REGISTRY_CONTRACT_ID` is unset it logs and falls back to the compiled
defaults (250 BPS platform fee, 500 BPS creator share), so a backend without a
deployed registry is **not** reading fees from chain. A cron job refreshes the
cache every 5 minutes, and `invalidateFeeCache()` clears it after an on-chain
fee change.

`backend/src/services/governance.js` + `backend/src/routes/governance.js`
(mounted at `/api/governance`) handle proposal metadata, votes, delegations and
on-chain-to-database sync. Routes:

- `GET /proposals`, `GET /proposals/:id`
- `POST /proposals`, `POST /proposals/submit-signed`
- `POST /proposals/:id/vote`, `POST /proposals/:id/vote/submit-signed`
- `POST /proposals/:id/execute`
- `GET /fee`, `GET /user/token-balance`, `GET /user/vote-weight`
- `GET /delegations`, `POST /delegations`
- `POST /sync` plus the sync-run endpoints described in
  [governance-sync-runs.md](governance-sync-runs.md)

Freighter wallets get an unsigned XDR and a `prepare_token` back and finalize
with the `submit-signed` routes; custodial wallets are signed inline by the
backend.

Environment variables (`backend/.env.example`):

| Variable | Purpose |
|---|---|
| `FEE_REGISTRY_CONTRACT_ID` | Deployed fee registry contract; unset means default fees |
| `GOVERNANCE_TOKEN_ID` | Issuer address of the `CROWD` governance token, used for balance and vote weight |

Database side, `backend/db/migrations/20260818_governance_tables.sql` creates
`governance_proposals_meta` and `governance_votes_log`; delegations live in
`20260830_governance_delegations.sql`.

## Frontend

`frontend/src/pages/Governance.jsx` (route `/governance`) shows the current fee
and creator share, the caller's token balance, the active proposal with its
deadline and outcome projection, proposal history, and forms to vote and to
create a proposal.

## Known limits

- Quorum is a fixed `QUORUM_THRESHOLD` constant, not a function of the live
  circulating supply.
- The emergency admin path is a single signature; a multisig or timelock is the
  intended replacement.
- Creator share is calculated and logged at withdrawal time; the platform fee
  wallet does not yet pay it out as a separate transfer.
