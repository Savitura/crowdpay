# Contributor Receipts with Verifiable Stellar Transaction References

## Overview

CrowdPay issues downloadable and API-accessible contributor receipts backed by on-chain Stellar ledger data. Every receipt contains a canonical `verification` block so contributors, campaign creators, auditors, and tax authorities can independently verify the payment on the Stellar network.

## Verifiable Stellar Reference Schema

Each receipt includes both top-level convenience fields and a structured `verification` object:

```json
{
  "id": "contrib-101",
  "receipt_id": "contrib-101",
  "campaign_id": "11111111-2222-3333-4444-555555555555",
  "campaign_title": "Solar Microgrid for Clinics",
  "campaign_status": "active",
  "contributor_name": "Ada Lovelace",
  "contributor_email": "ada@example.com",
  "sender_public_key": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  "destination_public_key": "GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM",
  "amount": "125.5000000",
  "asset": "USDC",
  "payment_type": "payment",
  "platform_fee_amount": "2.5100000",
  "network_fee": "0.0000100",
  "total_charged": "125.5000000",
  "tx_hash": "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
  "memo": "cp-1111111122223333444455555",
  "ledger_sequence": 543210,
  "paging_token": "2333071950241792",
  "stellar_status": "indexed",
  "stellar_network": "testnet",
  "network_passphrase": "Test SDF Network ; September 2015",
  "explorer_url": "https://stellar.expert/explorer/testnet/tx/a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
  "horizon_tx_url": "https://horizon-testnet.stellar.org/transactions/a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
  "verification": {
    "verifiable": true,
    "tx_hash": "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
    "network": "testnet",
    "network_passphrase": "Test SDF Network ; September 2015",
    "explorer_url": "https://stellar.expert/explorer/testnet/tx/a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
    "horizon_tx_url": "https://horizon-testnet.stellar.org/transactions/a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
    "sender_public_key": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    "sender_explorer_url": "https://stellar.expert/explorer/testnet/account/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    "destination_public_key": "GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM",
    "destination_explorer_url": "https://stellar.expert/explorer/testnet/account/GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM",
    "contract_id": null,
    "memo": "cp-1111111122223333444455555",
    "ledger_sequence": 543210,
    "paging_token": "2333071950241792"
  },
  "created_at": "2026-10-20T14:30:00.000Z"
}
```

## API Endpoints

- `GET /api/contributions/tax-receipts`: Lists all verifiable contributor receipts for the authenticated user.
- `GET /api/contributions/tax-receipts/download`: Downloads a combined PDF receipt document for all of the authenticated user's verifiable contributions (`404` if none).
- `GET /api/contributions/tax-receipts/:id/download`: Downloads a PDF receipt for a single contribution owned by the authenticated user (`404` if not found).
- `GET /api/contributions/:id/receipt`: Returns the JSON receipt and Stellar verification block for an authorized viewer (contributor, campaign creator with privacy/PII redaction, or admin). Returns `403` for unauthorized viewers, `404` when missing, and `422 UNVERIFIABLE_TRANSACTION` if the record has no verifiable on-chain transaction hash (e.g., synthetic reconciliation adjustments).
- `GET /api/contributions/:id/receipt/pdf`: Downloads the PDF receipt for an authorized viewer.

## Operational, Privacy, Accessibility, and Security Considerations

- **Verification Integrity**: Only 64-character hexadecimal Stellar transaction hashes from non-system accounts are marked `verifiable: true`. Synthetic reconciliation rows (`sender_public_key = 'system'` or missing `tx_hash`) are excluded from user receipt lists and rejected with `422 UNVERIFIABLE_TRANSACTION` on direct receipt lookup.
- **Privacy & PII Protection**: When a campaign creator (who is not the contributor or an admin) views a contribution receipt via `GET /api/contributions/:id/receipt`, the contributor's email address is redacted (`null`), and if the contributor selected `anonymous` or `amount_only` privacy, `contributor_name` is replaced with `"Anonymous Contributor"` and `sender_public_key` is omitted.
- **Accessibility**: Receipt verification blocks in the UI use semantic landmarks (`aria-label`), keyboard-accessible copy buttons, and high-contrast `<code>` elements for transaction hashes and memos.
