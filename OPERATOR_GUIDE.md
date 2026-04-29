# Campaign Wallet Operator Guide

## Overview

This guide provides step-by-step instructions for platform operators managing the CrowdPay campaign wallet infrastructure. Follow these procedures for setup, monitoring, and maintenance.

## Prerequisites

- Node.js 18+ installed
- PostgreSQL 14+ running
- Access to Stellar testnet/mainnet
- Environment variables configured
- Platform operator credentials

## Initial Setup

### 1. Generate Encryption Key

Generate a secure 256-bit encryption key for wallet secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add to `.env`:
```
WALLET_ENCRYPTION_KEY=<generated_key>
```

⚠️ **Critical**: Back up this key securely. Loss means encrypted secrets cannot be recovered.

### 2. Setup Platform Account

The platform account funds new campaign wallets and acts as a multisig co-signer.

**On Testnet**:
```bash
cd contracts/stellar
node campaignWallet.js --setup-platform
```

This will:
- Generate a new Stellar keypair
- Fund it via Friendbot (10,000 XLM)
- Display public and secret keys

**On Mainnet**:
1. Generate keypair manually or use existing account
2. Fund with sufficient XLM (recommend 1000+ XLM for reserves)
3. Verify account is active on Stellar Expert

Add to `.env`:
```
PLATFORM_PUBLIC_KEY=GXXX...
PLATFORM_SECRET_KEY=SXXX...
```

### 3. Database Setup

Run migrations to add wallet secret storage:

```bash
cd backend
psql $DATABASE_URL -f db/schema.sql
psql $DATABASE_URL -f db/migrations/001_add_campaign_wallet_secrets.sql
```

Verify schema:
```bash
psql $DATABASE_URL -c "\d campaigns"
```

Should show `wallet_secret_encrypted` column.

### 4. Start Backend Services

```bash
cd backend
npm install
npm run dev
```

Verify services:
- Backend API: http://localhost:3001/health
- Ledger monitor: Check console for "Monitoring ledger..." messages

## Daily Operations

### Monitor Campaign Wallet Creation

Check logs for successful wallet creation:

```bash
tail -f backend/logs/app.log | grep "Campaign wallet created"
```

Verify on Stellar:
```bash
node contracts/stellar/campaignWallet.js --inspect <wallet_public_key>
```

Expected output:
- Balance: ~2 XLM (base reserve)
- Signers: 2 (creator + platform)
- Thresholds: low=1, med=2, high=2
- Trustlines: USDC established

### Monitor Contributions

View incoming contributions in real-time:

```bash
# Database query
psql $DATABASE_URL -c "
  SELECT c.title, co.amount, co.asset, co.created_at 
  FROM contributions co 
  JOIN campaigns c ON c.id = co.campaign_id 
  ORDER BY co.created_at DESC 
  LIMIT 10;
"
```

Check ledger monitor status:
```bash
curl http://localhost:3001/api/monitor/status
```

### Process Withdrawal Requests

List pending withdrawals:

```bash
psql $DATABASE_URL -c "
  SELECT id, campaign_id, amount, destination_key, creator_signed, platform_signed 
  FROM withdrawal_requests 
  WHERE status = 'pending';
"
```

Review and approve withdrawal:

1. **Verify Request**:
   - Check campaign has sufficient balance
   - Verify destination address is valid
   - Confirm creator has signed

2. **Platform Sign**:
```bash
curl -X POST http://localhost:3001/api/withdrawals/:id/platform-sign \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN"
```

3. **Verify Submission**:
```bash
# Check transaction on Stellar
curl "https://horizon.stellar.org/transactions/<tx_hash>"
```

## Maintenance Tasks

### Weekly: Verify Platform Account Balance

```bash
node contracts/stellar/campaignWallet.js --inspect $PLATFORM_PUBLIC_KEY
```

Ensure sufficient XLM for:
- Creating new campaign accounts (2 XLM each)
- Transaction fees (0.00001 XLM per operation)

**Recommended minimum**: 100 XLM

### Monthly: Audit Wallet Secrets

Verify encrypted secrets are intact:

```bash
psql $DATABASE_URL -c "
  SELECT id, title, 
    CASE WHEN wallet_secret_encrypted IS NOT NULL THEN 'ENCRYPTED' ELSE 'MISSING' END as secret_status
  FROM campaigns 
  WHERE created_at > NOW() - INTERVAL '30 days';
"
```

All campaigns should show `ENCRYPTED`.

### Monthly: Database Backup

Backup database including encrypted secrets:

```bash
pg_dump $DATABASE_URL | gzip > backup_$(date +%Y%m%d).sql.gz
```

Store backups:
- Encrypted at rest
- Geographically distributed
- Retained for 90 days minimum

### Quarterly: Key Rotation

Rotate encryption key for enhanced security:

1. **Generate New Key**:
```bash
NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo $NEW_KEY
```

2. **Re-encrypt Secrets** (run migration script):
```bash
node scripts/rotate-encryption-key.js --old-key $OLD_KEY --new-key $NEW_KEY
```

3. **Update Environment**:
```
WALLET_ENCRYPTION_KEY=$NEW_KEY
```

4. **Restart Services**:
```bash
pm2 restart crowdpay-backend
```

## Troubleshooting

### Issue: Campaign Wallet Creation Fails

**Symptoms**: API returns 500 error, logs show "Account not found"

**Diagnosis**:
```bash
# Check platform account exists
curl "https://horizon.stellar.org/accounts/$PLATFORM_PUBLIC_KEY"

# Check platform account balance
node contracts/stellar/campaignWallet.js --inspect $PLATFORM_PUBLIC_KEY
```

**Resolution**:
- If account not found: Re-run platform setup
- If balance too low: Fund platform account
- If secret key wrong: Update `.env` with correct key

### Issue: Encrypted Secret Cannot Be Decrypted

**Symptoms**: Recovery endpoint returns 500 error, logs show decryption failure

**Diagnosis**:
```bash
# Verify encryption key in environment
echo $WALLET_ENCRYPTION_KEY | wc -c  # Should be 65 (64 hex chars + newline)

# Test encryption/decryption
node -e "
  const {encryptSecret, decryptSecret} = require('./backend/src/services/walletService');
  const test = 'SXXX...';
  const enc = encryptSecret(test);
  const dec = decryptSecret(enc);
  console.log(dec === test ? 'OK' : 'FAIL');
"
```

**Resolution**:
- If key wrong: Restore from backup
- If key lost: Secrets cannot be recovered (wallets still accessible via multisig)

### Issue: Ledger Monitor Not Recording Contributions

**Symptoms**: Contributions visible on Stellar but not in database

**Diagnosis**:
```bash
# Check monitor is running
curl http://localhost:3001/api/monitor/status

# Check last processed ledger
psql $DATABASE_URL -c "SELECT * FROM ledger_cursor;"

# Manually check for transactions
curl "https://horizon.stellar.org/accounts/<campaign_wallet>/transactions?limit=10"
```

**Resolution**:
```bash
# Restart ledger monitor
pm2 restart crowdpay-backend

# If cursor stuck, reset to recent ledger
psql $DATABASE_URL -c "UPDATE ledger_cursor SET last_ledger = <recent_ledger>;"
```

### Issue: Withdrawal Stuck in Pending

**Symptoms**: Withdrawal request has both signatures but not submitted

**Diagnosis**:
```bash
# Check withdrawal status
psql $DATABASE_URL -c "
  SELECT id, creator_signed, platform_signed, status, tx_hash 
  FROM withdrawal_requests 
  WHERE id = '<withdrawal_id>';
"

# Verify XDR has both signatures
node -e "
  const {Transaction} = require('@stellar/stellar-sdk');
  const xdr = '<unsigned_xdr>';
  const tx = new Transaction(xdr, 'TESTNET');
  console.log('Signatures:', tx.signatures.length);
"
```

**Resolution**:
```bash
# Manually submit transaction
curl -X POST http://localhost:3001/api/withdrawals/:id/submit \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN"
```

## Security Procedures

### Access Control

**Operator Access Levels**:
- **Level 1 (Read-Only)**: View campaigns, contributions, balances
- **Level 2 (Operator)**: Approve withdrawals, monitor systems
- **Level 3 (Admin)**: Access encrypted secrets, rotate keys

**Authentication**:
```bash
# Generate operator token
curl -X POST http://localhost:3001/api/auth/operator-login \
  -H "Content-Type: application/json" \
  -d '{"username":"operator","password":"<secure_password>"}'
```

### Incident Response

**If Platform Secret Key Compromised**:

1. **Immediate Actions**:
   - Rotate platform keypair
   - Update all campaign wallet signers
   - Notify affected campaign creators

2. **Recovery Steps**:
```bash
# Generate new platform keypair
node contracts/stellar/campaignWallet.js --setup-platform

# For each campaign, update signers (requires creator cooperation)
# This is a manual process requiring coordination
```

**If Encryption Key Compromised**:

1. **Immediate Actions**:
   - Generate new encryption key
   - Re-encrypt all wallet secrets
   - Audit access logs for unauthorized recovery attempts

2. **Recovery Steps**:
```bash
# Run key rotation script
node scripts/rotate-encryption-key.js --emergency
```

### Audit Logging

Enable comprehensive audit logs:

```bash
# Log all wallet operations
export AUDIT_LOG_LEVEL=verbose

# Review audit logs
tail -f backend/logs/audit.log | grep "wallet_operation"
```

Log entries should include:
- Timestamp
- Operator ID
- Operation type (create, recover, withdraw)
- Campaign ID
- Result (success/failure)

## Monitoring & Alerts

### Key Metrics to Monitor

1. **Platform Account Balance**:
   - Alert if < 50 XLM
   - Critical if < 10 XLM

2. **Campaign Wallet Creation Rate**:
   - Track daily creation count
   - Alert on unusual spikes

3. **Withdrawal Processing Time**:
   - Target: < 1 hour from request to submission
   - Alert if > 24 hours

4. **Ledger Monitor Lag**:
   - Target: < 5 ledgers behind current
   - Alert if > 100 ledgers behind

### Setup Monitoring

**Using Prometheus + Grafana**:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'crowdpay'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/metrics'
```

**Using CloudWatch** (AWS):

```bash
# Install CloudWatch agent
aws cloudwatch put-metric-data \
  --namespace CrowdPay \
  --metric-name PlatformBalance \
  --value $(curl -s http://localhost:3001/api/platform/balance | jq .XLM)
```

## Emergency Procedures

### Platform Account Depleted

**Immediate Action**:
```bash
# Fund platform account
# Testnet: Use Friendbot
curl "https://friendbot.stellar.org?addr=$PLATFORM_PUBLIC_KEY"

# Mainnet: Transfer from reserve account
# (requires manual intervention)
```

### Database Corruption

**Recovery Steps**:
1. Stop backend services
2. Restore from latest backup
3. Verify encryption key matches backup
4. Test wallet recovery on sample campaign
5. Restart services
6. Reconcile on-chain state with database

### Stellar Network Outage

**Monitoring**:
```bash
# Check Horizon status
curl https://horizon.stellar.org/

# Check Stellar status page
curl https://status.stellar.org/api/v2/status.json
```

**Actions**:
- Queue withdrawal requests for later processing
- Notify users of temporary service disruption
- Monitor Stellar status page for updates

## Best Practices

1. **Never expose private keys in logs or error messages**
2. **Always verify transaction XDRs before signing**
3. **Maintain offline backups of encryption keys**
4. **Test recovery procedures quarterly**
5. **Document all manual interventions**
6. **Use separate accounts for testnet and mainnet**
7. **Implement rate limiting on sensitive endpoints**
8. **Review withdrawal requests before platform signing**
9. **Monitor for unusual activity patterns**
10. **Keep Stellar SDK and dependencies updated**

## Support Contacts

- **Stellar Network Issues**: https://stellar.stackexchange.com/
- **SDK Issues**: https://github.com/stellar/js-stellar-sdk/issues
- **Platform Issues**: [Internal support channel]

## Appendix

### Useful Commands

```bash
# Check campaign wallet details
psql $DATABASE_URL -c "SELECT id, title, wallet_public_key, status FROM campaigns WHERE id = '<campaign_id>';"

# View recent contributions
psql $DATABASE_URL -c "SELECT * FROM contributions ORDER BY created_at DESC LIMIT 10;"

# Check pending withdrawals
psql $DATABASE_URL -c "SELECT * FROM withdrawal_requests WHERE status = 'pending';"

# Verify encryption key
echo $WALLET_ENCRYPTION_KEY | wc -c

# Test Stellar connection
curl https://horizon.stellar.org/

# Check backend health
curl http://localhost:3001/health
```

### Environment Variables Reference

```bash
# Stellar Configuration
STELLAR_NETWORK=testnet|mainnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
PLATFORM_PUBLIC_KEY=GXXX...
PLATFORM_SECRET_KEY=SXXX...
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/crowdpay

# Security
JWT_SECRET=<random_string>
WALLET_ENCRYPTION_KEY=<64_hex_chars>

# Server
PORT=3001
NODE_ENV=production
```

### Migration Checklist (Testnet → Mainnet)

- [ ] Generate new mainnet platform account
- [ ] Fund platform account with sufficient XLM
- [ ] Generate new production encryption key
- [ ] Update environment variables
- [ ] Deploy database schema
- [ ] Configure monitoring and alerts
- [ ] Test wallet creation on mainnet
- [ ] Test contribution flow
- [ ] Test withdrawal flow
- [ ] Document mainnet-specific procedures
- [ ] Train operators on mainnet procedures

---

**Document Version**: 1.0  
**Last Updated**: 2026-04-24  
**Next Review**: 2026-07-24
