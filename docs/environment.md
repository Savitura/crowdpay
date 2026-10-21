# Environment configuration

The backend reads its configuration from environment variables and checks it
once at startup. This page lists the templates, every rule the startup check
enforces, and how the templates are kept in line with those rules.

## Templates

| File | Use |
|---|---|
| `backend/.env.example` | Default backend template. Copy it to `backend/.env`. `docker-compose.yml` and `docker-compose.prod.yml` load `backend/.env` into the backend container (`env_file`), and `npm run migrate` reads it with dotenv. |
| `backend/.env.demo.template` | Variant for the Soroban demo (`SOROBAN_ENABLED=true`). Copy it to `backend/.env` instead of the default template. |
| `frontend/.env.example` | Optional frontend overrides. The frontend has no startup validation. |
| `.env.example` (repository root) | Pointer only. It defines no variables; the backend does not read a root `.env`. |

Both backend templates set every variable the startup check requires. Values
marked `GENERATE` are placeholders that fail the check on purpose, so a copied
template never starts with a key that was published in the repository:

| Variable | Expected value | Generate with |
|---|---|---|
| `PLATFORM_SECRET_KEY` | Stellar secret seed: `S` followed by 55 characters from `A-Z` and `2-7` | [Stellar Laboratory](https://laboratory.stellar.org/#account-creator), then fund the account on testnet with `https://friendbot.stellar.org?addr=<PUBLIC_KEY>` |
| `ARBITRATOR_SECRET_KEY` | Same format, for the arbitrator account | Same as above |
| `WALLET_ENCRYPTION_KEY` | Exactly 32 bytes, as 64 hex characters or base64 | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `WALLET_SECRET_LOCAL_KEK` | Exactly 32 bytes, as 64 hex characters or base64 | Same command, a second time |

The other secrets (`JWT_SECRET`, `API_KEY_PEPPER`, `OPS_API_KEY`,
`UNSUBSCRIBE_SECRET`, `IMPACT_SIGNING_SECRET`) have placeholders that pass the
check, so a local setup starts with them. Replace them everywhere except on a
developer machine, for example with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
`INTEGRATION_SECRET_LOCAL_KEK` is not part of the startup check, but its
placeholder makes the first API key or webhook creation fail until it is
replaced with a 32-byte key.

## When the check runs

`backend/src/index.js` calls `validateEnv()` (`backend/src/config/env.js`)
before it mounts any route, unless `NODE_ENV=test`. `npm test` and the CI test
jobs run with `NODE_ENV=test`, so they never trigger it.

When a rule fails, the server prints `[crowdpay] Cannot start: ...` to stderr
and exits with code 1. Warnings are printed and startup continues.
`GET /health/ready` also reports the required variables that are missing, in
its `config` check.

## Rules in every environment

| Variable | Rule | When it fails |
|---|---|---|
| `DATABASE_URL`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `API_KEY_PEPPER`, `PLATFORM_SECRET_KEY`, `ARBITRATOR_SECRET_KEY`, `STELLAR_NETWORK`, `STELLAR_HORIZON_URL`, `WALLET_ENCRYPTION_KEY`, `OPS_API_KEY`, `UNSUBSCRIBE_SECRET`, `IMPACT_SIGNING_SECRET` | Set and not empty (the `REQUIRED` list in `env.js`) | Exit, listing every missing name |
| `API_KEY_PEPPER` | Different from `JWT_SECRET` | Exit |
| `JWT_SECRET` | At least 32 characters | Warning only |
| `STELLAR_NETWORK` | `testnet` or `mainnet` | Exit |
| `PLATFORM_SECRET_KEY`, `ARBITRATOR_SECRET_KEY` | Match `^S[A-Z2-7]{55}$` | Exit |
| `PORT` | When set, an integer from 1 to 65535 | Exit |
| `STORAGE_BUCKET`, `STORAGE_ENDPOINT` | Both set or both unset | Exit |
| `WALLET_SECRET_PROVIDER` | `local` (default outside production) or `aws-kms` | Exit on any other value |
| `WALLET_SECRET_LOCAL_KEK` | With the `local` provider: 64 hex characters, or base64 that decodes to exactly 32 bytes | Exit |
| `AWS_REGION`, `WALLET_SECRET_KMS_KEY_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | With the `aws-kms` provider: all set (`AWS_SESSION_TOKEN` is optional) | Exit |
| `WALLET_ENCRYPTION_KEY` | 64 hex characters, or base64 that decodes to exactly 32 bytes | Exit |
| `GEOIP_PROVIDER` | Unset, `none`, `off`, `disabled`, `maxmind` (`geolite2`), `ip-api` (`ipapi`, `ip-api.com`) or `ipinfo` (`ipinfo.io`) | Exit |
| `GEOIP_TIMEOUT_MS`, `GEOIP_CACHE_TTL_MS`, `GEOIP_CACHE_MAX_ENTRIES` | When set, a positive number | Exit |
| `GEOIP_MAXMIND_DB_PATH` | With `maxmind`: set to an existing file, and the optional `maxmind` package installed | Exit |
| `GEOIP_IPINFO_TOKEN` | With `ipinfo`: set | Exit |
| `PLATFORM_APPROVER_USER_ID` | Set, otherwise every authenticated user can approve withdrawals | Warning only |
| `JWT_EXPIRES_IN` | Set, otherwise access tokens use `15m` | Warning only |

## Rules with `NODE_ENV=production`

| Variable | Rule | When it fails |
|---|---|---|
| `SMTP_HOST`, `EMAIL_SERVICE_API_KEY` | At least one set, unless `DISABLE_EMAILS=true` | Exit; with `DISABLE_EMAILS=true`, a warning instead |
| `WALLET_SECRET_PROVIDER` | `aws-kms`, which is also the default in production | Exit |

## Checked outside `validateEnv()`

These values are not part of the startup check, but a wrong value still stops
the server or a feature:

- `USDC_ISSUER`: `backend/src/config/stellar.js` builds the USDC asset when it
  is loaded, which throws unless the value is a valid public key (`G...`).
- `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`: when set,
  `backend/src/config/database.js` throws unless they are positive integers.
- `INTEGRATION_SECRET_PROVIDER`, `INTEGRATION_SECRET_LOCAL_KEK`,
  `INTEGRATION_SECRET_KMS_KEY_ID`: checked when an integration secret (API key,
  webhook secret) is first stored. Production requires
  `INTEGRATION_SECRET_PROVIDER=aws-kms` with `AWS_REGION`,
  `INTEGRATION_SECRET_KMS_KEY_ID` and the AWS credentials above.

## Keeping the templates in sync

`backend/src/config/envTemplates.test.js` parses both backend templates with
dotenv and runs them through the real `validateEnv()`:

1. every name in `REQUIRED` is set in the template;
2. with the `GENERATE` values replaced by test values, the template passes the
   check without a `Cannot start` message;
3. each `GENERATE` placeholder on its own makes the check exit with code 1 and
   name the variable.

Adding a variable to `REQUIRED`, or a format rule that a template value
breaks, fails this test until both templates are updated.
