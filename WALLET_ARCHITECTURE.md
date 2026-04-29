# Stellar Campaign Wallet Architecture

## Overview

CrowdPay implements a secure, auditable on-chain wallet architecture where each campaign has its own dedicated Stellar account. This document covers the complete wallet lifecycle from creation to recovery.

## Architecture Components

### 1. Campaign Wallet Structure

Each campaign wallet is a Stellar account with:
- **Multisig Control**: Requires both creator and platform signatures for withdrawals
- **USDC Trustline**: Pre-configured to accept USDC contributions
- **Disabled Master Key**: The original keypair is disabled after setup for security
- **Threshold Configuration**:
  - Low: 1 (allows single-signature operations like trustlines)
  - Medium: 2 (requires both signatures for payments)
  - High: 2 (requires both signatures for account changes)

### 2. Key Management

#### Encryption
- Campaign wallet secrets are encrypted using **AES-256-GCM**
- Encryption key stored in `WALLET_ENCRYPTION_KEY` environment variable
- Each encrypted secret includes: IV, auth tag, and ciphertext

#### Storage
- Encrypted secrets stored in `campaigns.wallet_secret_encrypted` column
- Public keys stored in `campaigns.wallet_public_key` column
- Database schema includes indexes for efficient wallet lookups

#### Security Best Practices
- Never log or expose private keys
- Rotate `WALLET_ENCRYPTION_KEY` periodically
- Use hardware security modules (HSM) or key management services (KMS) in production
- Implement access controls on wallet recovery endpoints

## Wallet Lifecycle

### Phase 1: Campaign Creation

When a user creates a campaign:

1. **Generate Keypair**: New Stellar keypair generated for the campaign
2. **Fund Account**: Platform account funds the new wallet with 2 XLM (base reserve)
3. **Configure Multisig**:
   - Add creator's public key as signer (weight: 1)
   - Add platform's public key as signer (weight: 1)
   - Set thresholds to require both signatures
   - Disable master key (weight: 0)
4. **Establish Trustline**: Add USDC trustline to accept contributions
5. **Encrypt & Store**: Encrypt wallet secret and store in database
6. **Start Monitoring**: Begin watching for incoming transactions

**API Endpoint**: `POST /api/campaigns`

```json
{
  "title": "My Campaign",
  "description": "Campaign description",
  "target_amount": "1000",
  "asset_type": "USDC",
  "deadline": "2026-12-31"
}
```

### Phase 2: Contribution Acceptance

Contributors send funds to the campaign wallet:

- **Direct Payments**: XLM or USDC sent directly
- **Path Payments**: Any asset converted to USDC via Stellar DEX
- **Ledger Monitoring**: Backend monitors Horizon for incoming transactions
- **Database Recording**: Contributions recorded with full audit trail

### Phase 3: Fund Management

Campaign creators can:

- **View Balance**: Check real-time on-chain balance
- **View Transactions**: Audit complete transaction history
- **View Payments**: See detailed payment operations
- **Inspect Config**: Review multisig configuration

**API Endpoints**:
- `GET /api/campaigns/:id/balance` - Current balance
- `GET /api/wallets/:campaignId/transactions` - Transaction history
- `GET /api/wallets/:campaignId/payments` - Payment operations
- `GET /api/wallets/:campaignId/config` - Multisig configuration

### Phase 4: Withdrawal

To withdraw funds:

1. **Create Request**: Creator initiates withdrawal request
2. **Build Transaction**: Backend builds unsigned XDR transaction
3. **Creator Signs**: Creator signs with their private key
4. **Platform Signs**: Platform reviews and signs
5. **Submit**: Transaction submitted to Stellar network
6. **Record**: Withdrawal recorded in database

**API Endpoint**: `POST /api/withdrawals`

```json
{
  "campaign_id": "uuid",
  "amount": "500",
  "destination_key": "GXXX..."
}
```

### Phase 5: Recovery

If wallet access is needed:

1. **Authenticate**: Verify creator identity
2. **Decrypt Secret**: Retrieve and decrypt wallet secret
3. **Recover Keypair**: Reconstruct keypair from secret
4. **Verify**: Confirm public key matches stored value

**API Endpoint**: `POST /api/wallets/:campaignId/recover`

⚠️ **Warning**: Recovery endpoint should be heavily restricted in production

## Database Schema

```sql
CREATE TABLE campaigns (
  id                      UUID PRIMARY KEY,
  creator_id              UUID NOT NULL REFERENCES users(id),
  title                   TEXT NOT NULL,
  description             TEXT,
  target_amount           NUMERIC(20, 7) NOT NULL,
  raised_amount           NUMERIC(20, 7) NOT NULL DEFAULT 0,
  asset_type              TEXT NOT NULL,
  wallet_public_key       TEXT UNIQUE NOT NULL,
  wallet_secret_encrypted TEXT,
  status                  TEXT NOT NULL DEFAULT 'active',
  deadline                DATE,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON campaigns (wallet_public_key);
```

## Security Considerations

### Encryption Key Management

**Development**:
```bash
# Generate a secure 256-bit key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Production**:
- Use AWS KMS, Google Cloud KMS, or Azure Key Vault
- Implement key rotation policies
- Store keys in secure vaults, never in code or version control

### Access Control

- Wallet recovery endpoints require authentication
- Only campaign creators can access their wallet data
- Platform operators need separate admin authentication
- Implement rate limiting on sensitive endpoints

### Audit Trail

All wallet operations are logged:
- Campaign creation events
- Contribution transactions
- Withdrawal requests and approvals
- Recovery attempts

### Network Security

- Use HTTPS for all API communications
- Implement CORS policies
- Validate all transaction XDRs before signing
- Monitor for suspicious activity patterns

## Monitoring & Observability

### Ledger Monitor

The backend runs a continuous ledger monitor that:
- Watches for new transactions on campaign wallets
- Records contributions in the database
- Updates campaign raised amounts
- Triggers notifications for large contributions

### Health Checks

Monitor these metrics:
- Wallet creation success rate
- Transaction submission failures
- Encryption/decryption errors
- Horizon API availability

## Disaster Recovery

### Backup Procedures

1. **Database Backups**: Regular encrypted backups of PostgreSQL
2. **Key Backups**: Secure offline backup of `WALLET_ENCRYPTION_KEY`
3. **Configuration Backups**: Environment variables and deployment configs

### Recovery Procedures

If database is lost:
1. Restore from latest backup
2. Verify encryption key matches
3. Test wallet recovery on sample campaign
4. Reconcile on-chain state with database

If encryption key is lost:
- **Critical**: Encrypted secrets cannot be recovered
- Campaign wallets remain accessible via multisig (creator + platform)
- New campaigns can be created with new encryption key

## Testing

### Unit Tests

Test wallet service functions:
```bash
npm test src/services/walletService.test.js
```

### Integration Tests

Test complete wallet lifecycle:
```bash
npm test src/routes/campaigns.test.js
npm test src/routes/wallets.test.js
```

### Manual Testing on Testnet

```bash
# 1. Setup platform account
node contracts/stellar/campaignWallet.js --setup-platform

# 2. Create test campaign via API
curl -X POST http://localhost:3001/api/campaigns \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","target_amount":"100","asset_type":"USDC"}'

# 3. Inspect wallet
node contracts/stellar/campaignWallet.js --inspect GXXX...
```

## API Reference

### Campaign Wallet Endpoints

#### Create Campaign
```
POST /api/campaigns
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "string",
  "description": "string",
  "target_amount": "number",
  "asset_type": "XLM|USDC",
  "deadline": "YYYY-MM-DD"
}

Response: 201 Created
{
  "id": "uuid",
  "wallet_public_key": "GXXX...",
  ...
}
```

#### Get Wallet Balance
```
GET /api/campaigns/:id/balance

Response: 200 OK
{
  "XLM": "1.5000000",
  "USDC": "250.0000000"
}
```

#### Get Wallet Configuration
```
GET /api/wallets/:campaignId/config
Authorization: Bearer <token>

Response: 200 OK
{
  "thresholds": {
    "low_threshold": 1,
    "med_threshold": 2,
    "high_threshold": 2
  },
  "signers": [
    {
      "key": "GXXX...",
      "weight": 1,
      "type": "ed25519_public_key"
    },
    ...
  ]
}
```

#### Get Transaction History
```
GET /api/wallets/:campaignId/transactions?limit=50
Authorization: Bearer <token>

Response: 200 OK
[
  {
    "hash": "abc123...",
    "created_at": "2026-04-24T09:30:00Z",
    "source_account": "GXXX...",
    "fee_charged": "100",
    "operation_count": 1,
    "memo": "crowdpay"
  },
  ...
]
```

#### Get Payment History
```
GET /api/wallets/:campaignId/payments?limit=100
Authorization: Bearer <token>

Response: 200 OK
[
  {
    "id": "123456789",
    "type": "payment",
    "created_at": "2026-04-24T09:30:00Z",
    "transaction_hash": "abc123...",
    "from": "GXXX...",
    "to": "GYYY...",
    "amount": "50.0000000",
    "asset_type": "USDC"
  },
  ...
]
```

#### Recover Wallet
```
POST /api/wallets/:campaignId/recover
Authorization: Bearer <token>

Response: 200 OK
{
  "publicKey": "GXXX..."
}
```

## Troubleshooting

### Common Issues

**Issue**: Campaign creation fails with "Account not found"
- **Cause**: Platform account not funded or incorrect credentials
- **Solution**: Run `--setup-platform` script and verify `.env` configuration

**Issue**: Encryption/decryption errors
- **Cause**: Missing or incorrect `WALLET_ENCRYPTION_KEY`
- **Solution**: Generate new key and update environment variables

**Issue**: Withdrawal requires both signatures but only one provided
- **Cause**: Multisig threshold not met
- **Solution**: Ensure both creator and platform sign the transaction XDR

**Issue**: Trustline not established
- **Cause**: Insufficient XLM balance for reserve
- **Solution**: Increase starting balance in `createCampaignWallet` function

## Future Enhancements

- **Key Rotation**: Implement periodic re-encryption with new keys
- **Hardware Wallet Support**: Allow creators to use hardware wallets for signing
- **Multi-Asset Support**: Extend beyond USDC to other Stellar assets
- **Automated Withdrawals**: Smart contract-based automatic disbursements
- **Threshold Customization**: Allow campaigns to set custom signature requirements

## References

- [Stellar Documentation](https://developers.stellar.org/)
- [Stellar SDK for JavaScript](https://github.com/stellar/js-stellar-sdk)
- [Multisig Guide](https://developers.stellar.org/docs/encyclopedia/signatures-multisig)
- [Node.js Crypto Module](https://nodejs.org/api/crypto.html)
