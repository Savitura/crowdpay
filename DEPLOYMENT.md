# CrowdPay Deployment Guide

This guide covers three ways to deploy CrowdPay to production:

- **[Option A — Railway](#option-a--railway)** (recommended for most contributors)
- **[Option B — Render](#option-b--render)**
- **[Option C — Self-hosted VPS (Ubuntu 22.04)](#option-c--self-hosted-vps-ubuntu-2204)**

All three options end with the same running system: a Node.js backend on port 3001, a static React frontend, and a PostgreSQL 14+ database. A [full environment variable reference](#environment-variable-reference) is at the bottom.

---

## Before You Start

### Generate required secrets

You need two secrets before deploying anything.

**JWT secret** — a random 256-bit hex string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Wallet encryption key (KEK)** — a random 32-byte base64 string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep both values safe. Losing `WALLET_SECRET_LOCAL_KEK` means losing access to all campaign wallet private keys.

### Create a Stellar platform account

The backend needs a Stellar key pair that co-signs all campaign withdrawals.

**Testnet (development)**

```bash
# Install the Stellar SDK globally or run from backend/
node -e "
const StellarSdk = require('@stellar/stellar-sdk');
const pair = StellarSdk.Keypair.random();
console.log('Public:', pair.publicKey());
console.log('Secret:', pair.secret());
"
```

Then fund it with Friendbot:

```
https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>
```

**Mainnet (production)**

Generate the key pair the same way, but fund it by sending at least 1 XLM from an exchange or another wallet. Never use Friendbot on mainnet.

---

## Option A — Railway

Railway runs the backend as a Node.js service and hosts PostgreSQL natively. Because the frontend's API client sends requests to `/api` on whatever origin it is served from, both the frontend build output and the backend must share a single origin. The approach below builds the frontend as part of the deploy and serves it from Express using the `SERVE_FRONTEND=true` environment variable.

### 1. Fork the repository

Fork `Savitura/crowdpay` on GitHub so Railway can pull from your account.

### 2. Create a Railway project

1. Go to [railway.app](https://railway.app) and sign in.
2. Click **New Project → Deploy from GitHub repo** and select your fork.
3. Railway detects the repo but do not deploy yet — configure services first.

### 3. Add a PostgreSQL service

1. Inside your project, click **+ New → Database → PostgreSQL**.
2. Once provisioned, open the PostgreSQL service and copy the **`DATABASE_URL`** value from the **Variables** tab:
   ```
   postgresql://postgres:<password>@<host>.railway.internal:5432/railway
   ```

### 4. Deploy the app service

1. Click **+ New → GitHub Repo** and select your fork.
2. In the service settings:
   - **Root directory**: leave empty (use the project root)
   - **Build command**:
     ```
     cd frontend && npm install && npm run build && cd ../backend && npm install
     ```
   - **Start command**:
     ```
     cd backend && npm start
     ```
3. Open the **Variables** tab and add every variable from the [Environment Variable Reference](#environment-variable-reference). At minimum:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Paste the value copied from the PostgreSQL service |
   | `JWT_SECRET` | The random hex string you generated |
   | `STELLAR_NETWORK` | `testnet` or `mainnet` |
   | `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` or `https://horizon.stellar.org` |
   | `PLATFORM_PUBLIC_KEY` | Your platform account public key |
   | `PLATFORM_SECRET_KEY` | Your platform account secret key |
   | `WALLET_SECRET_PROVIDER` | `local` |
   | `WALLET_SECRET_LOCAL_KEK` | The random base64 KEK you generated |
   | `USDC_ISSUER` | Testnet: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
   | `FRONTEND_URL` | Your Railway app URL (set after first deploy, e.g. `https://crowdpay.up.railway.app`) |
   | `SERVE_FRONTEND` | `true` |
   | `PORT` | `3001` |
   | `VITE_STELLAR_NETWORK` | `testnet` or `public` (used during the frontend build step) |

4. Railway will build and deploy. Note the public URL.

### 5. Run database migrations

Open the Railway shell for the service (**Deploy → Shell**) and run:

```bash
# Apply the base schema
psql $DATABASE_URL -f backend/db/schema.sql

# Apply all migrations in order
for f in backend/db/migrations/*.sql; do
  echo "Applying $f"
  psql $DATABASE_URL -f "$f"
done
```

Alternatively, from your local machine with `psql` installed:

```bash
# Export the DATABASE_URL from Railway's dashboard
export DATABASE_URL="postgresql://..."

psql $DATABASE_URL -f backend/db/schema.sql
for f in backend/db/migrations/*.sql; do psql $DATABASE_URL -f "$f"; done
```

### 6. Verify

Visit your Railway app URL. Create an account, create a campaign, and confirm that the campaign wallet is created on Stellar. Check the backend logs (**Deploy → Logs**) for any errors.

---

## Option B — Render

Render runs the app as a single Web Service with a managed PostgreSQL instance. Like Railway, the frontend and backend share one origin — the build step compiles the React app and Express serves the output via `SERVE_FRONTEND=true`.

### 1. Create a PostgreSQL instance

1. In the Render dashboard, click **New → PostgreSQL**.
2. Choose a name (e.g. `crowdpay-db`), region, and plan.
3. After provisioning, copy the **Internal Database URL** (for the app service) and the **External Database URL** (for running migrations from your laptop).

### 2. Deploy the app service

1. Click **New → Web Service** and connect your GitHub repo.
2. Configure:
   - **Root directory**: leave empty (use the project root)
   - **Runtime**: Node
   - **Build command**:
     ```
     cd frontend && npm install && npm run build && cd ../backend && npm install
     ```
   - **Start command**:
     ```
     cd backend && npm start
     ```
3. Under **Environment Variables**, add all variables from the [reference table](#environment-variable-reference). Key values:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Internal Database URL from the PostgreSQL service |
   | `JWT_SECRET` | The random hex string you generated |
   | `STELLAR_NETWORK` | `testnet` or `mainnet` |
   | `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` or `https://horizon.stellar.org` |
   | `PLATFORM_PUBLIC_KEY` | Your platform account public key |
   | `PLATFORM_SECRET_KEY` | Your platform account secret key |
   | `WALLET_SECRET_PROVIDER` | `local` |
   | `WALLET_SECRET_LOCAL_KEK` | The random base64 KEK you generated |
   | `USDC_ISSUER` | Testnet: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
   | `FRONTEND_URL` | Your Render service URL (e.g. `https://crowdpay.onrender.com`) |
   | `SERVE_FRONTEND` | `true` |
   | `VITE_STELLAR_NETWORK` | `testnet` or `public` (used during the frontend build step) |

4. Click **Create Web Service**. Note the public URL.

### 3. Run database migrations

From your local machine using the **External Database URL**:

```bash
export DATABASE_URL="postgres://..."   # External URL from Render dashboard

psql $DATABASE_URL -f backend/db/schema.sql
for f in backend/db/migrations/*.sql; do
  echo "Applying $f"
  psql $DATABASE_URL -f "$f"
done
```

Or use Render's **Shell** tab on the Web Service and run the same commands with the Internal URL.

### Note on free-tier cold starts

Render's free tier spins down Web Services after 15 minutes of inactivity. The first request after a cold start takes ~30 seconds. Use a paid plan or a keep-alive ping for production.

---

## Option C — Self-hosted VPS (Ubuntu 22.04)

This option gives you full control. The steps below install Node 20, PostgreSQL 14, nginx, and set up the backend as a systemd service with Let's Encrypt SSL.

### 1. Provision a server

Any Ubuntu 22.04 VPS works (DigitalOcean, Hetzner, Vultr, Linode). Minimum recommended spec: 1 vCPU, 1 GB RAM, 20 GB SSD. Point a domain name at the server's IP address before continuing.

### 2. Install Node 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v20.x.x
```

### 3. Install PostgreSQL 14

```bash
sudo apt-get install -y postgresql postgresql-contrib

# Create the database and user
sudo -u postgres psql <<SQL
CREATE USER crowdpay WITH PASSWORD 'strong_password_here';
CREATE DATABASE crowdpay OWNER crowdpay;
SQL
```

### 4. Clone the repository

```bash
sudo mkdir -p /opt/crowdpay
sudo chown $USER:$USER /opt/crowdpay
git clone https://github.com/Savitura/crowdpay.git /opt/crowdpay
```

### 5. Install backend dependencies

```bash
cd /opt/crowdpay/backend
npm ci --omit=dev
```

### 6. Configure environment variables

```bash
cp /opt/crowdpay/backend/.env.example /opt/crowdpay/backend/.env
nano /opt/crowdpay/backend/.env
```

Fill in every variable. See the [Environment Variable Reference](#environment-variable-reference) for descriptions. The `DATABASE_URL` for a local PostgreSQL install looks like:

```
DATABASE_URL=postgresql://crowdpay:strong_password_here@localhost:5432/crowdpay
```

### 7. Run database migrations

```bash
cd /opt/crowdpay/backend

# Export DATABASE_URL from the .env file
export DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d '=' -f2-)

# Load the base schema
psql $DATABASE_URL -f db/schema.sql

# Apply all migrations in chronological order
for f in db/migrations/*.sql; do
  echo "Applying $f"
  psql $DATABASE_URL -f "$f"
done
```

### 8. Build the frontend

```bash
cd /opt/crowdpay/frontend
npm ci

# Create frontend .env
cat > .env <<EOF
VITE_API_URL=https://api.yourdomain.com
VITE_STELLAR_NETWORK=testnet
EOF

npm run build
# Output goes to /opt/crowdpay/frontend/dist
```

### 9. Create a systemd service for the backend

```bash
sudo nano /etc/systemd/system/crowdpay-backend.service
```

Paste the following (adjust `User` and `WorkingDirectory` if needed):

```ini
[Unit]
Description=CrowdPay Backend
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/crowdpay/backend
EnvironmentFile=/opt/crowdpay/backend/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=crowdpay-backend

[Install]
WantedBy=multi-user.target
```

```bash
# Fix ownership so www-data can read the files
sudo chown -R www-data:www-data /opt/crowdpay/backend

sudo systemctl daemon-reload
sudo systemctl enable crowdpay-backend
sudo systemctl start crowdpay-backend
sudo systemctl status crowdpay-backend
```

### 10. Install nginx

```bash
sudo apt-get install -y nginx
```

### 11. Configure nginx as a reverse proxy

Create a site configuration. Replace `yourdomain.com` with your actual domain.

```bash
sudo nano /etc/nginx/sites-available/crowdpay
```

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Frontend static files
    root /opt/crowdpay/frontend/dist;
    index index.html;

    # Serve React app — fall back to index.html for client-side routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to backend
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/crowdpay /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 12. Set up Let's Encrypt SSL

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot updates the nginx config automatically and sets up auto-renewal. Verify:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

### 13. Verify the deployment

```bash
# Check backend is running
sudo systemctl status crowdpay-backend
journalctl -u crowdpay-backend -f

# Hit the health / docs endpoint
curl https://yourdomain.com/api/docs
```

---

## Database Migrations

CrowdPay uses plain SQL migrations. There is no ORM migration runner — apply files manually in alphabetical (chronological) order.

**Fresh install** — apply the base schema, then all migrations:

```bash
psql $DATABASE_URL -f backend/db/schema.sql
for f in backend/db/migrations/*.sql; do
  echo "Applying $f"
  psql $DATABASE_URL -f "$f"
done
```

**Existing install** — check which migrations have already been applied and run only the new ones. A simple way is to keep a log:

```bash
# See which migration files exist
ls backend/db/migrations/

# Apply a single migration
psql $DATABASE_URL -f backend/db/migrations/20260429_add_soroban_contract_ids.sql
```

Migration files are named with dates (`20260401_`, `20260423_`, etc.) so alphabetical order is chronological order.

---

## Testnet vs Mainnet Stellar Configuration

| Setting | Testnet (development) | Mainnet (production) |
|---|---|---|
| `STELLAR_NETWORK` | `testnet` | `mainnet` |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` |
| `USDC_ISSUER` | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| `VITE_STELLAR_NETWORK` | `testnet` | `public` |
| Platform account funding | Friendbot (`https://friendbot.stellar.org/?addr=<key>`) | Buy and send XLM from an exchange |
| KYC | Can disable with `KYC_REQUIRED_FOR_CAMPAIGNS=false` | Must be enabled for compliance |

**Never use testnet keys on mainnet.** Generate a fresh key pair for each environment.

---

## Environment Variable Reference

All variables go in `backend/.env` (or the equivalent dashboard UI for Railway/Render).

### Stellar

| Variable | Required | Description | Example |
|---|---|---|---|
| `STELLAR_NETWORK` | Yes | Network to connect to | `testnet` or `mainnet` |
| `STELLAR_HORIZON_URL` | Yes | Horizon API endpoint for the chosen network | `https://horizon-testnet.stellar.org` |
| `PLATFORM_PUBLIC_KEY` | Yes | Public key of the platform co-signer account | `GDWUL...` |
| `PLATFORM_SECRET_KEY` | Yes | Secret key of the platform co-signer account. Keep this out of version control. | `SCVMQ...` |
| `USDC_ISSUER` | Yes | Public key of the USDC issuer on the chosen network | `GBBD47...` (testnet) |
| `STELLAR_EXTRA_ASSETS` | No | JSON map of additional accepted assets `{"CODE":"ISSUER_KEY"}` | `{"AQUA":"GBNZ..."}` |

### Wallet Secret Management

| Variable | Required | Description | Example |
|---|---|---|---|
| `WALLET_SECRET_PROVIDER` | Yes | Where to store encrypted campaign wallet secrets | `local` (default) or `aws-kms` |
| `WALLET_SECRET_LOCAL_KEK` | Yes (if `local`) | Base64-encoded 32-byte key-encryption key for AES-256-GCM. Changing this value breaks all existing campaign wallets. | `+tLlh7nd...` |
| `KMS_KEY_ID` | Yes (if `aws-kms`) | AWS KMS key ARN used to encrypt wallet secrets in production | `arn:aws:kms:us-east-1:...` |

### Database

| Variable | Required | Description | Example |
|---|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@host:5432/crowdpay` |

### Auth

| Variable | Required | Description | Example |
|---|---|---|---|
| `JWT_SECRET` | Yes | Random secret for signing JWT access tokens. Use at least 32 random bytes. | `a3f9...` (hex) |
| `JWT_EXPIRES_IN` | No | Access token lifetime (default `15m`) | `15m` |
| `REFRESH_TOKEN_EXPIRES_IN` | No | Refresh token lifetime (default `7d`) | `7d` |

### Server

| Variable | Required | Description | Example |
|---|---|---|---|
| `PORT` | No | Port the Express server listens on (default `3001`) | `3001` |
| `FRONTEND_URL` | Yes | Origin of the frontend app. Used for CORS and email links. | `https://app.yourdomain.com` |
| `SERVE_FRONTEND` | No | When `true`, Express serves the built frontend from `frontend/dist/` and handles SPA routing. Set this on Railway/Render where both are deployed as a single service. Not needed on VPS (nginx handles it). | `true` |
| `LOG_LEVEL` | No | Winston log verbosity (default `info`) | `info`, `debug`, `warn`, `error` |

### Platform Behaviour

| Variable | Required | Description | Example |
|---|---|---|---|
| `PLATFORM_FEE_BPS` | No | Platform fee in basis points (100 bps = 1%). Defaults to `0`. | `150` (1.5%) |
| `PLATFORM_APPROVER_USER_ID` | No | UUID of the user who may approve withdrawal requests. When unset, any authenticated user can call the approval endpoint. | `00000000-0000-0000-0000-000000000000` |

### KYC

| Variable | Required | Description | Example |
|---|---|---|---|
| `KYC_REQUIRED_FOR_CAMPAIGNS` | No | Set to `false` to skip KYC checks on testnet | `true` |
| `KYC_PROVIDER` | No | KYC provider integration | `persona` |
| `PERSONA_API_KEY` | No (if Persona) | Persona API key | `persona_sandbox_...` |
| `PERSONA_TEMPLATE_ID` | No (if Persona) | Persona inquiry template ID | `itmpl_...` |
| `APP_BASE_URL` | No (if Persona) | Public base URL of the backend, used for Persona callbacks | `https://api.yourdomain.com` |

### Email

| Variable | Required | Description | Example |
|---|---|---|---|
| `EMAIL_FROM` | No | Sender address for transactional emails | `"CrowdPay" <noreply@yourdomain.com>` |
| `SMTP_HOST` | No | SMTP server hostname | `smtp.sendgrid.net` |
| `SMTP_PORT` | No | SMTP port | `587` |
| `SMTP_USER` | No | SMTP username | `apikey` |
| `SMTP_PASS` | No | SMTP password or API key | `SG.abc...` |
| `EMAIL_SERVICE_API_KEY` | No | Provider-level API key (SendGrid / Mailgun) | `SG.abc...` |

### Alerting

| Variable | Required | Description | Example |
|---|---|---|---|
| `ALERT_WEBHOOK_URL` | No | Slack-compatible incoming webhook URL for platform alerts. When unset, alerts are silently skipped. | `https://hooks.slack.com/services/...` |

### Frontend variables (set in `frontend/.env`)

| Variable | Required | Description | Example |
|---|---|---|---|
| `VITE_API_URL` | Yes (production) | Full URL of the deployed backend. Not needed in local dev (proxied by Vite). | `https://api.yourdomain.com` |
| `VITE_STELLAR_NETWORK` | No | Network label for Stellar explorer links | `testnet` or `public` |
| `VITE_KYC_REQUIRED_FOR_CAMPAIGNS` | No | Mirror of backend KYC setting for conditional UI | `true` or `false` |

---

## Checklist

Before going live, confirm each item:

- [ ] `JWT_SECRET` is a unique random value not shared between environments
- [ ] `WALLET_SECRET_LOCAL_KEK` is backed up securely — losing it loses all wallet keys
- [ ] `PLATFORM_SECRET_KEY` is stored in a secrets manager, not in a `.env` file committed to git
- [ ] `STELLAR_NETWORK=mainnet` and `STELLAR_HORIZON_URL` points to `https://horizon.stellar.org`
- [ ] `USDC_ISSUER` is set to the mainnet USDC issuer key
- [ ] `FRONTEND_URL` matches the actual frontend origin (CORS will block otherwise)
- [ ] All database migrations have been applied in order
- [ ] SSL certificate is installed and auto-renewal is configured
- [ ] `LOG_LEVEL=info` (use `debug` only in development)
- [ ] KYC is enabled (`KYC_REQUIRED_FOR_CAMPAIGNS=true`) for mainnet
