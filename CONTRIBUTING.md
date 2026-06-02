# Contributing to CrowdPay

Thanks for your interest in contributing! This guide covers everything you need to get from zero to a merged PR.

---

## Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **PostgreSQL 14+** — [postgresql.org](https://www.postgresql.org/download/)
- **A free Stellar testnet account** — [Stellar Laboratory](https://laboratory.stellar.org)
- **Docker** *(optional)* — simplest way to run the full stack; see [docker-compose.yml](docker-compose.yml)

---

## Local Setup

### Option A — Docker (recommended for a quick start)

```bash
git clone https://github.com/Savitura/crowdpay.git
cd crowdpay
cp backend/.env.example backend/.env   # fill in values
docker compose up
```

| Service  | URL                   |
|----------|-----------------------|
| Frontend | http://localhost:5173 |
| Backend  | http://localhost:3001 |
| Postgres | localhost:5432        |

The database schema is applied automatically on first start.

---

### Option B — Manual setup

```bash
# 1. Fork then clone your fork
git clone https://github.com/<your-username>/crowdpay.git
cd crowdpay

# 2. Configure the backend environment
cp backend/.env.example backend/.env
# Open backend/.env and fill in: DB credentials, Stellar platform keypair, etc.

# 3. Create the database and apply migrations
cd backend
npm install
npm run migrate:fresh   # first time — creates schema + runs all migrations
# npm run migrate       # subsequent pulls — applies only new migrations

# 4. Fund your testnet platform account
node contracts/stellar/campaignWallet.js --setup-platform

# 5. Install frontend dependencies
cd ../frontend && npm install

# 6. Start both dev servers (two terminals)
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd frontend && npm run dev
```

Visit **http://localhost:5173** — backend runs on **http://localhost:3001**.

---

## Running Tests

### Backend (unit + route tests)
```bash
cd backend && npm test
```
Test files live in `backend/src/__tests__/` and cover route handlers, Stellar service helpers, and wallet lifecycle logic.

### Frontend (Vitest + React Testing Library)
```bash
cd frontend && npm test
```

### End-to-end (Playwright)
```bash
# From repo root — requires Postgres with schema + seed applied (port 5433 via docker-compose)
npm install
npx playwright install
npm run test:e2e
```

**Run all tests before opening a PR.** CI runs the same suite on every push.

---

## Branch Naming
Pattern: `<type>/<short-kebab-description>`

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):
Allowed prefixes: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`.

---

## Opening a Pull Request

1. **Link the issue** — include `Closes #123` in the PR description
2. **Run all tests** before pushing
3. **Keep PRs focused** — one issue per PR; avoid unrelated changes
4. **Describe what changed** and how a reviewer can test it locally
5. **Small PRs merge faster** — if your change is large, open an issue first to discuss the approach

PR template checklist:
- [ ] Tests pass (`npm test` in backend and frontend)
- [ ] No unrelated files changed
- [ ] Issue linked in description
- [ ] Branch follows naming conventions above

---

## Good First Issues

New to the codebase? Start here:
👉 [good first issue](https://github.com/Savitura/crowdpay/labels/good%20first%20issue)

These are scoped, well-described tasks that don't require deep knowledge of the Stellar layer.

---

## Code Style

| Layer    | Style                                      |
|----------|--------------------------------------------|
| Backend  | 2-space indentation, single quotes, semicolons |
| Frontend | Same — consistent with existing files      |

Match whatever the surrounding file already uses. A linter is not yet configured — see [#93](https://github.com/Savitura/crowdpay/issues/93) for the planned CI setup.

---

## Questions?

Open a [GitHub Discussion](https://github.com/Savitura/crowdpay/discussions) or comment on the relevant issue. Don't be shy — asking is faster than guessing.
