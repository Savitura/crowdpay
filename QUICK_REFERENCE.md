# Campaign Wallet Quick Reference

## Setup (One-Time)

```bash
# 1. Generate encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Add to .env
echo "WALLET_ENCRYPTION_KEY=<your_key>" >> backend/.env

# 3. Setup platform account (testnet)
node contracts/stellar/campaignWallet.js --setup-platform

# 4. Run migration
psql $DATABASE_URL -f backend/db/migrations/001_add_campaign_wallet_secrets.sql
```

## API Endpoints

### Create Campaign (with wallet)
```bash
POST /api/campaigns
Authorization: Bearer <token>

{
  "title": "My Campaign",
  "target_amount": "1000",
  "asset_type": "USDC"
}

# Returns: campaign with wallet_public_key
```

### Get Wallet Balance
```bash
GET /api/campaigns/:id/balance

# Returns: { "XLM": "2.0", "USDC": "100.0" }
```

### Get Wallet Config
```bash
GET /api/wallets/:campaignId/config
Authorization: Bearer <token>

# Returns: signers, thresholds
```

### Get Transaction History
```bash
GET /api/wallets/:campaignId/transactions?limit=50
Authorization: Bearer <token>

# Returns: array of transactions
```

### Get Payment History
```bash
GET /api/wallets/:campaignId/payments?limit=100
Authorization: Bearer <token>

# Returns: array of payment operations
```

### Recover Wallet
```bash
POST /api/wallets/:campaignId/recover
Authorization: Bearer <token>

# Returns: { "publicKey": "GXXX..." }
```

## Code Usage

### Encrypt Wallet Secret
```javascript
const { encryptSecret } = require('./services/walletService');
const encrypted = encryptSecret(wallet.secret);
// Store encrypted in database
```

### Decrypt Wallet Secret
```javascript
const { decryptSecret } = require('./services/walletService');
const secret = decryptSecret(encryptedData);
// Use secret to sign transactions
```

### Recover Wallet
```javascript
const { recoverWalletFromSecret } = require('./services/stellarService');
const wallet = recoverWalletFromSecret(secret);
// wallet.publicKey, wallet.secret
```

### Get Transaction History
```javascript
const { getWalletTransactionHistory } = require('./services/stellarService');
const txs = await getWalletTransactionHistory(publicKey, 50);
```

### Get Payment History
```javascript
const { getWalletPayments } = require('./services/stellarService');
const payments = await getWalletPayments(publicKey, 100);
```

## Database Queries

### Get Campaign Wallet
```sql
SELECT wallet_public_key, wallet_secret_encrypted 
FROM campaigns 
WHERE id = '<campaign_id>';
```

### List All Campaign Wallets
```sql
SELECT id, title, wallet_public_key, status 
FROM campaigns 
ORDER BY created_at DESC;
```

### Check Encrypted Secrets
```sql
SELECT id, title,
  CASE WHEN wallet_secret_encrypted IS NOT NULL 
    THEN 'ENCRYPTED' 
    ELSE 'MISSING' 
  END as secret_status
FROM campaigns;
```

## CLI Commands

### Inspect Wallet On-Chain
```bash
node contracts/stellar/campaignWallet.js --inspect <public_key>
```

### Create Test Wallet
```bash
node contracts/stellar/campaignWallet.js --create <creator_public_key>
```

## Environment Variables

```bash
# Required
WALLET_ENCRYPTION_KEY=<64_hex_chars>
PLATFORM_PUBLIC_KEY=GXXX...
PLATFORM_SECRET_KEY=SXXX...
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Optional
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

## Wallet Lifecycle

```
1. CREATE
   ↓
   Campaign created → Wallet generated → Secret encrypted → Stored in DB
   
2. CONTRIBUTE
   ↓
   User sends funds → Ledger monitor detects → DB updated
   
3. WITHDRAW
   ↓
   Creator requests → Platform approves → Both sign → Submitted
   
4. RECOVER
   ↓
   Decrypt secret → Reconstruct keypair → Verify public key
```

## Security Checklist

- [ ] Never log private keys
- [ ] Never return private keys in API responses
- [ ] Always encrypt secrets before storing
- [ ] Verify campaign creator before wallet access
- [ ] Use HTTPS in production
- [ ] Store encryption key in KMS (production)
- [ ] Rotate encryption key quarterly
- [ ] Monitor for unauthorized recovery attempts

## Troubleshooting

### "Decryption failed"
- Check WALLET_ENCRYPTION_KEY is correct
- Verify encrypted data format (iv:authTag:encrypted)

### "Account not found"
- Platform account not funded
- Wrong network (testnet vs mainnet)

### "Unauthorized"
- Missing or invalid JWT token
- User is not campaign creator

### "No encrypted secret"
- Campaign created before migration
- Encryption failed during creation

## Documentation

- **Architecture**: [WALLET_ARCHITECTURE.md](WALLET_ARCHITECTURE.md)
- **Operations**: [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md)
- **API Docs**: [backend/API.md](backend/API.md)
- **Summary**: [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)

## Support

- Stellar Docs: https://developers.stellar.org/
- Stellar SDK: https://github.com/stellar/js-stellar-sdk
- Stack Exchange: https://stellar.stackexchange.com/
