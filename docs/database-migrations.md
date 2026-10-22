# Database Migrations: Ordering, Rollback Limits, and Recovery Procedure

This guide specifies the migration architecture in CrowdPay, documenting the migration ordering model, rollback limits, and step-by-step recovery procedures for operational teams and contributors.

---

## 1. Migration Architecture & Components

CrowdPay uses a strict, forward-only SQL migration runner located in `backend/db/`. Schema state is tracked in the database and validated against committed filesystem scripts.

| Component | Path | Purpose |
|---|---|---|
| **Migration Runner** | `backend/db/migrate.js` | Executes migrations (`up`), displays status (`status`), and handles advisory locking. |
| **Migration Library** | `backend/db/migrateLib.js` | Pure helpers for discovery, file parsing, SHA-256 hashing, format validation, and lock management. |
| **Migration Scripts** | `backend/db/migrations/*.sql` | Strictly ordered, immutable SQL migration scripts. |
| **Canonical Base Schema** | `backend/db/schema.sql` | Baseline DDL snapshot used for local development bootstrap (`npm run migrate:fresh`). |
| **Tracking Table** | `schema_migrations` | Database table recording applied migration filenames, execution timestamps (`applied_at`), and SHA-256 checksums (`file_hash`). |

---

## 2. Migration Ordering

### 2.1 Lexicographical Chronological Ordering

Migrations are discovered by `listUpMigrationFilenames()` in `backend/db/migrateLib.js`. Files are filtered by `isUpMigration` (`.sql` extension, excluding `.down.sql`) and sorted in ascending ASCII lexicographical order via standard `Array.prototype.sort()`:

```text
backend/db/migrations/
├── 20250601000000_add_velocity_alert_threshold.sql
├── 20260401_users_campaigns_contributions.sql
├── 20260402_add_campaign_wallet_secrets.sql
├── ...
└── 20261020_wallet_submission_idempotency.sql
```

1. **Naming Convention**: Files must begin with a date or timestamp prefix in UTC (`YYYYMMDD_*` or `YYYYMMDDHHMMSS_*`), followed by a descriptive lowercase snake_case label.
2. **Determinism**: The lexical sort ensures identical execution order across all platforms (Linux, macOS, Windows) and environments (local, CI, staging, production).
3. **Collision Avoidance**: If multiple migrations share the same date prefix, the subsequent description string determines lexical order. Contributors should use full timestamps (`YYYYMMDDHHMMSS`) or coordinate branch sequencing when working in parallel.

### 2.2 Concurrency Control via Advisory Locks

To prevent concurrent deployment jobs or parallel container replicas from running migrations simultaneously and causing race conditions or deadlocks:

1. Before reading or executing migrations, `runUp()` acquires a PostgreSQL session-level advisory lock using the dedicated lock ID `894721`:
   ```sql
   SELECT pg_advisory_lock(894721);
   ```
2. Any concurrent migration process will block until the lock is released.
3. The runner guarantees that `SELECT pg_advisory_unlock(894721)` is called in a `finally` block, ensuring the lock is released whether the migration succeeds, fails, or aborts.

### 2.3 Discrete Transaction Isolation

Each migration script is executed within its own discrete database transaction:

```sql
BEGIN;
-- <SQL statements from migration file>
INSERT INTO schema_migrations (filename, file_hash) VALUES ($1, $2);
COMMIT;
```

- **Per-file atomicity**: If migration $N$ fails, its transaction issues `ROLLBACK`. Any tables, columns, or rows altered in migration $N$ are completely reverted.
- **Progress persistence**: Previously applied migrations $1 \dots N-1$ remain committed and recorded in `schema_migrations`.
- **Non-transactional DDL exception**: Certain PostgreSQL statements cannot run inside a transaction block (e.g., `CREATE INDEX CONCURRENTLY`). When non-transactional statements are strictly required, review locking impacts and execute them via dedicated operational runbooks.

### 2.4 Immutability & Content Hash Validation

When `runUp()` runs:
1. It queries `schema_migrations` to retrieve the recorded `filename` and `file_hash` of all previously applied migrations.
2. It computes the SHA-256 digest of every migration file on disk (`fileHashFor(file)`).
3. If an applied migration file's hash on disk differs from the recorded hash in `schema_migrations`, execution immediately halts with:
   ```text
   Migration '<file>' was applied but its content has changed since then (hash mismatch).
   Do not edit an applied migration - add a new one instead.
   ```
4. **Rule**: Applied migrations are strictly immutable. Never edit a committed, applied migration file. Always author a new forward migration.

### 2.5 Bootstrap Schema Handling (`--bootstrap-schema`)

In local development, `npm run migrate:fresh` resets the database from `db/schema.sql` and replays all migrations with `--bootstrap-schema`. Because `schema.sql` already creates base tables (like `users`, `campaigns`, `contributions`), the runner skips migrations that fail with PostgreSQL "already exists" error codes:
- `42P07` (`duplicate_table`)
- `42701` (`duplicate_column`)
- `42P04` (`duplicate_object`)
- `42710` (`duplicate_object` for constraints and indexes)

In production (`npm run migrate`), `--bootstrap-schema` is **never** used. Any duplicate object error indicates an unexpected schema conflict and aborts immediately.

---

## 3. Rollback Limits

### 3.1 Why Down Migrations Are Unsupported

CrowdPay enforces a **forward-only** database migration strategy:

1. **CLI Rejection**: Running `npm run migrate:down` (`node db/migrate.js down`) prints:
   ```text
   [migrate:down] Rollback is not supported due to lack of down migration files.
   ```
   and exits with non-zero exit code `1`.
2. **Lack of Down Files**: Across the 160+ migrations in `backend/db/migrations/`, automated `.down.sql` rollback files are not maintained.
3. **Risk of Data Loss**: In a financial and escrow application handling real-time payments, refunds, and Stellar blockchain transactions, automated down-migrations (such as dropping tables or removing columns) permanently destroy production records, user balances, audit trails, and cryptographic transaction hashes.

### 3.2 Application Rollback Limits (Zero-Downtime Compatibility)

When deploying a release that includes both application code changes and database migrations:

- **Compatible Application Rollback**: Application code can only be rolled back safely if the prior code version is fully backward-compatible with the forward-migrated schema.
- **The Expand-and-Contract Pattern**:
  - **Phase 1 (Expand)**: Add new columns as nullable or with defaults, create new tables, or add indexes concurrently. Both old and new application versions can run simultaneously.
  - **Phase 2 (Migrate Data & Code)**: Deploy new application code that writes to the new schema structures.
  - **Phase 3 (Contract)**: After verifying production stability, deploy a subsequent migration that adds `NOT NULL` constraints or drops obsolete columns.
- **Breaking Schema Changes**: If an applied migration introduced breaking changes that prevent the prior application version from running, application rollback alone is **not viable**. In this case, either deploy a forward corrective migration or follow the disaster recovery restore procedure.

### 3.3 Reversibility Guidance: Forward Corrective Migrations

If a migration must be undone or altered:
1. **Never edit `schema_migrations` or modify existing migration files.**
2. Author a new forward migration script (e.g., `YYYYMMDD_revert_<feature>.sql` or `YYYYMMDD_restore_<column>.sql`).
3. For example, when an admin column was previously dropped in error, forward migration `20260731_restore_users_is_admin_column.sql` was authored to safely restore the column without rewriting history.

---

## 4. Recovery Procedures

### 4.1 Scenario A: Migration Execution Failure During Deployment

**Symptom**: `npm run migrate` exits with code 1 and outputs an error (e.g., syntax error, constraint violation, lock acquisition timeout).

**Procedure**:
1. **Review Output**: Inspect the error log printed by `[migrate] Failed: <error message>`.
2. **Check Migration Status**:
   ```bash
   npm run migrate:status
   ```
   Verify that:
   - All migrations prior to the failing script show `APPLIED`.
   - The failing migration and all subsequent migrations show `PENDING`.
3. **Verify Atomicity**: Because each migration runs in its own transaction, the failed script was rolled back automatically and is not recorded in `schema_migrations`.
4. **Fix and Re-run**:
   - For an unapplied migration: Correct the SQL in the pending migration file.
   - Run `npm run migrate` again.
   - Verify completion with `npm run migrate:status`.

### 4.2 Scenario B: Hash Mismatch on Startup or Deploy

**Symptom**: Migration runner aborts with `Migration '<file>' was applied but its content has changed since then (hash mismatch)`.

**Cause**: A developer or hotfix modified the text of a migration file that was already executed in the target environment.

**Procedure**:
1. Check git history for changes to the offending file:
   ```bash
   git diff HEAD~1 backend/db/migrations/<filename>.sql
   ```
2. Revert the file on disk so its content matches the exact version recorded in `schema_migrations`.
3. Put any new alterations into a brand new timestamped migration file.
4. Run `npm run migrate` to apply the new migration.

### 4.3 Scenario C: Stuck Advisory Lock Recovery

**Symptom**: `npm run migrate` hangs indefinitely on `SELECT pg_advisory_lock(894721)`.

**Cause**: A previous migration process was terminated abruptly (e.g., via `kill -9` or an infrastructure container crash) while an active connection pool kept the PostgreSQL session open.

**Procedure**:
1. Identify the session holding the lock:
   ```sql
   SELECT l.pid, a.usename, a.client_addr, a.query, a.state, a.query_start
   FROM pg_locks l
   JOIN pg_stat_activity a ON l.pid = a.pid
   WHERE l.objid = 894721;
   ```
2. If the process is dead or orphaned:
   - Option 1 (Graceful unlock if on same session):
     ```sql
     SELECT pg_advisory_unlock(894721);
     ```
   - Option 2 (Terminate orphaned connection):
     ```sql
     SELECT pg_terminate_backend(<pid>);
     ```
3. Re-run `npm run migrate`.

### 4.4 Scenario D: Production Disaster Recovery (Database Restore)

**Symptom**: A forward migration caused severe data corruption, table lock deadlock, or catastrophic application incompatibility requiring a database rollback.

**Procedure**:
1. **Declare Maintenance & Halt Writers**:
   - Put application into maintenance mode.
   - Stop backend writer services and disable background workers (`WORKER_ENABLED=false`).
   - Preserve the failed database for forensic analysis (do not drop or overwrite it).
2. **Select Restore Source**:
   - Determine the recovery target: the latest verified pre-migration logical backup (`pg_dump`) or provider Point-in-Time Recovery (PITR) timestamp immediately prior to the migration execution.
3. **Restore into an Isolated Target Instance**:
   - For logical dumps:
     ```bash
     createdb -h db.internal -U crowdpay_owner crowdpay_restored
     pg_restore --clean --if-exists --no-owner --dbname="$TARGET_DATABASE_URL" crowdpay-pre-migration.dump
     ```
   - For managed databases (e.g., AWS RDS, GCP Cloud SQL): Trigger a PITR restore to a new instance name.
4. **Validate Schema & Business Integrity**:
   - Verify migration status on restored target:
     ```bash
     psql "$TARGET_DATABASE_URL" -c 'SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 10;'
     ```
   - Verify critical business table counts:
     ```sql
     SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM campaigns) AS campaigns,
       (SELECT COUNT(*) FROM contributions) AS contributions,
       (SELECT COUNT(*) FROM withdrawal_requests) AS withdrawals;
     ```
5. **Reconcile Stellar Blockchain Activity**:
   - Inspect Horizon and Soroban event logs for transactions that occurred during the incident window.
   - Run the reconciliation worker (`npm run dev` with reconciliation triggers or manual reconciliation script) to re-sync any contributions or payout balance updates from the blockchain into the restored database.
6. **Switch Endpoints & Verify Health**:
   - Update `DATABASE_URL` in backend deployment secrets to point to the restored, validated database.
   - Start backend replicas and verify `GET /health/ready` reports green status for PostgreSQL, Redis, and Horizon.
   - Disable maintenance mode and monitor application metrics.

---

## 5. Operational, Security, Privacy, and Accessibility Impacts

### 5.1 Operational Considerations
- **Maintenance Windows**: High-traffic tables (`contributions`, `campaigns`) must be altered with minimal locks. Avoid table-locking operations without statement timeouts.
- **Pre-flight Testing**: Test every migration against an isolated, production-like database snapshot (e.g., `npm run test:migration-upgrade`) before running in production.
- **Monitoring**: Scrape `schema_migrations` and alert on migration failure logs (`[migrate] Failed:`).

### 5.2 Security & Least Privilege
- **Role Separation**:
  - `crowdpay_owner`: Used exclusively for migrations (`npm run migrate`). Has DDL privileges (`CREATE`, `ALTER`, `DROP`).
  - `crowdpay_app`: Used by backend API instances at runtime. Restricted to DML (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) with no DDL permissions.
- **Zero Secrets in Migrations**:
  - Never commit API keys, wallet secret keys, seed phrases, or private credentials in migration files.
  - `db/seed.sql` contains placeholder test secrets and must **never** be run in production.

### 5.3 Privacy & Data Protection
- Migrations must never log or export sensitive personal identifiable information (PII).
- When creating tables that store IP addresses, device fingerprints, or contact info, ensure compliance with the repository's data retention and purge policies (`20261020_retention_and_purge_policies.sql`).

### 5.4 Accessibility
- Documentation follows clear semantic Markdown hierarchy (`h1` through `h3`), structured comparison tables, and fenced code blocks for maximum screen-reader readability.
