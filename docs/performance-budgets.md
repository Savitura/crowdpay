# Performance budgets

CrowdPay enforces latency, error-rate and JavaScript payload budgets for its two
primary user paths (campaign discovery and contribution checkout). The budgets
live in [`load-tests/performance-budgets.json`](../load-tests/performance-budgets.json),
the accepted baseline in
[`load-tests/performance-baseline.json`](../load-tests/performance-baseline.json),
and the checker is [`load-tests/budget-check.js`](../load-tests/budget-check.js).

## What is checked

| Check                   | Source of the measured value         | Fails when                                                             |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| Config validation       | `performance-budgets.json`           | A budget is missing, non-positive, `p99 < p95`, or an exception is bad |
| API `p95_ms` / `p99_ms` | K6 summary (`--summary`)             | Value exceeds the budget **or** grows past the baseline allowance      |
| API `error_rate`        | K6 summary (`--summary`)             | Value exceeds the budget **or** grows past the baseline allowance      |
| `js_payload_kb`         | Built `assets/*.js` files (`--dist`) | Total JS size (rounded up to KB) exceeds the budget                    |

The baseline allowance is `baseline * (1 + max_increase_percent / 100) + min_absolute_ms`
(currently +20% plus a 25 ms noise floor). For example a 400 ms baseline allows
up to 505 ms.

`lcp_ms` and `interaction_ms` are validated as positive numbers but are not yet
measured in CI.

## Running the checks locally

All commands run from the repository root. Node 20+ is required; K6 is only
needed to produce a summary (see [`load-tests/README.md`](../load-tests/README.md)
for installing it).

```bash
# 1. Validate budgets and exception ownership/expiry (no K6 needed)
node load-tests/budget-check.js --validate

# 2. Run the K6 budget scenario against a seeded local backend
PERF_PROFILE=ci k6 run --summary-export /tmp/k6-summary.json \
  -e BASE_URL=http://localhost:3001 load-tests/performance-budgets.js

# 3. Compare the K6 summary with the budgets and the committed baseline
node load-tests/budget-check.js \
  --summary /tmp/k6-summary.json \
  --config load-tests/performance-budgets.json \
  --baseline load-tests/performance-baseline.json

# 4. Check the production JS payload after `npm run build --prefix frontend`
node load-tests/budget-check.js --validate --dist frontend/dist
```

The checker prints a table (path, metric, budget, baseline, actual, status) and
exits `1` with a `[perf-budget] FAILED:` list when anything is over budget.
Status is `OK`, `FAIL`, or `EXCEPTION` (waived by a live exception).

## Running the checker's unit tests

The checker itself has unit tests (no K6, database or network needed):

```bash
node --test load-tests/__tests__/budget-check.test.js
```

They cover argument parsing, config validation, budget and regression
comparison, exception handling, JS payload measurement, and the CLI exit codes.
CI runs them in the `performance-budgets` job before validating the budgets.

## Where it runs in CI

The `performance-budgets` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

1. Unit tests the checker.
2. Validates the budget config and exceptions.
3. Starts the backend on the seeded dataset and runs the K6 scenario.
4. Compares the K6 summary with the budgets and baseline (the job fails on a regression).

On failure the K6 summary and backend log are uploaded as the
`performance-summary` artifact.

## Changing budgets, baselines and exceptions

- **Raise or lower a budget** by editing `performance-budgets.json` in the same PR
  that justifies it.
- **Update the baseline** deliberately, after an accepted performance change,
  by re-running the CI profile and copying the new p95/p99/error-rate values into
  `performance-baseline.json`.
- **Temporarily waive a metric** with an entry in `exceptions`. Each needs `path`,
  `metric` (`p95_ms`, `p99_ms` or `error_rate`), `owner`, `reason` and a future
  ISO 8601 `expires_at`. Expired exceptions fail validation so they cannot become permanent.
