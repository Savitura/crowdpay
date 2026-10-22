# Health checks and deployment probes

CrowdPay exposes three health endpoints. They have deliberately different
contracts so a dependency outage cannot trigger a restart loop.

| Endpoint                     | Purpose                   | External dependencies                                                     | Success                               | Failure                                    |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| `GET /health/live`           | Liveness probe            | None                                                                      | `200 {"status":"ok"}`                 | Never fails because of a dependency        |
| `GET /health/ready`          | Readiness probe           | PostgreSQL, Redis, Horizon, required config (and optional email)          | `200 {"status":"ok"}`                 | `503 {"status":"degraded","failed":[...]}` |
| `GET /health/ready/:service` | Subsystem readiness probe | Dedicated check: `database`, `horizon`, `rpc`, `email`, `redis`, `config` | `200 {"status":"ok",...}`             | `503 {"status":"degraded",...}`            |
| `GET /health`                | Legacy aggregate check    | PostgreSQL                                                                | `200` with pool stats and email state | `503`                                      |

## Readiness contract

`GET /health/ready` checks each dependency independently and concurrently:

- `database` — `SELECT 1`
- `redis` — `PING`
- `horizon` — `GET <STELLAR_HORIZON_URL>/fee_stats`
- `soroban` (or `rpc`) — JSON-RPC `getHealth` when `SOROBAN_RPC_URL` (or `STELLAR_SOROBAN_RPC_URL`) is configured
- `email` — verifies connectivity and authentication with configured SMTP transport (or `disabled: true` when `DISABLE_EMAILS=true`)
- `config` — required environment variables from `src/config/env.js`

### Separate readiness checks

To probe individual subsystems independently without coupling orchestrator probes or synthetic monitors:

| Subsystem Endpoint                                 | Target          | Check description                                                             |
| -------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `GET /health/ready/database` (alias `/db`)         | PostgreSQL      | Executes `SELECT 1`                                                           |
| `GET /health/ready/horizon`                        | Stellar Horizon | Roundtrip `GET /fee_stats`                                                    |
| `GET /health/ready/rpc` (alias `/soroban`)         | Soroban RPC     | JSON-RPC `getHealth` request                                                  |
| `GET /health/ready/email` (alias `/smtp`, `/mail`) | Email provider  | Transport connection and credential verification via `verifyEmailTransport()` |
| `GET /health/ready/redis`                          | Redis cache     | `PING`                                                                        |
| `GET /health/ready/config`                         | Configuration   | Required environment variables check                                          |

You can also filter aggregate readiness checks via query parameter:
`GET /health/ready?check=database,rpc` or `GET /health/ready?check=email`.

Every check is bounded by `HEALTH_CHECK_TIMEOUT_MS` (default `2000`). A timeout
is reported as `"error":"timeout"`; other failures are reported as
`"error":"unavailable"` or `"error":"http_error"` with a safe HTTP status. Raw
exception messages, credentials and connection strings are never returned.

`failed` lists the names of the failing checks so a probe can distinguish a
database outage from a cache, RPC, or Horizon outage.

## Deployment probes

| Platform                 | Liveness                        | Readiness                        |
| ------------------------ | ------------------------------- | -------------------------------- |
| Kubernetes               | `httpGet /health/live`          | `httpGet /health/ready`          |
| Docker Compose / systemd | `curl -f $BASE_URL/health/live` | `curl -f $BASE_URL/health/ready` |
| Load balancer            | `GET /health/live`              | `GET /health/ready`              |

Use readiness for deployment gates and traffic admission. Use liveness only to
decide whether the process must be restarted. Do not point liveness at
`/health/ready`: a Redis or Horizon outage would otherwise restart healthy
application processes and amplify the outage.
