# Security

## Wallet secret handling

Custodial Stellar wallet secrets in `users.wallet_secret_encrypted` must never be stored as plaintext.

- Registration encrypts each wallet secret before the row is inserted.
- The database stores a versioned envelope (`cpws:v1:...`), not the raw Stellar seed.
- Decryption happens only in application memory immediately before a signing operation such as trustline setup, contribution signing, or creator-side withdrawal approval.
- The logger redacts secret-like fields and Stellar secret seeds before structured metadata is emitted.

## Providers

CrowdPay supports envelope encryption providers through `backend/src/services/walletSecrets.js`.

- `WALLET_SECRET_PROVIDER=aws-kms`
  Production mode requirement. The app generates a one-time data key with AWS KMS, encrypts the wallet secret locally with AES-256-GCM, and stores the encrypted data key plus ciphertext envelope in Postgres.
- `WALLET_SECRET_PROVIDER=local`
  Development and test fallback. Uses a 32-byte `WALLET_SECRET_LOCAL_KEK` to wrap per-secret data keys with AES-256-GCM.

Production startup is blocked unless:

- `WALLET_SECRET_PROVIDER=aws-kms`
- `AWS_REGION` is set
- `WALLET_SECRET_KMS_KEY_ID` is set
- AWS credentials are available through `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- No legacy plaintext wallet secrets remain in the `users` table

## Rotating legacy plaintext secrets

Any environments that ever stored plaintext Stellar seeds must rotate them before deployment.

1. Dry run:

```bash
cd backend
DRY_RUN=1 npm run rotate-wallet-secrets
```

2. Rotate in place:

```bash
cd backend
npm run rotate-wallet-secrets
```

The rotation script rewrites only legacy plaintext `users.wallet_secret_encrypted` values. Already-encrypted rows are left unchanged.

## Operational guidance

- Do not log request bodies or database rows containing `wallet_secret_encrypted`.
- Do not copy decrypted secrets into metrics, traces, or webhook payloads.
- Treat any failed production boot caused by plaintext-secret detection as a release blocker until rotation succeeds.
