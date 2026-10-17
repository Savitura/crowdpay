# Stellar Transaction Templates & Examples

> [!NOTE]
> **EXAMPLE / REFERENCE CODE ONLY**:
> The scripts in this directory are standalone developer examples and reference CLI tools for demonstrating Stellar SDK functionality (such as path payments, asset trustlines, and multi-signature transactions).
>
> They are **not** production smart contracts and are **not** imported during backend runtime.
>
> Production Stellar campaign wallet multisig configuration, dispute freeze policies, and transaction lifecycle management are implemented in `backend/src/services/` (see `backend/src/services/campaignMultisig.js` and `backend/src/services/stellarService.js`).
> On-chain smart contracts are written in Rust for Soroban and live in `contracts/soroban/`.

## Available Example Scripts

- **`multiSig.js`**: CLI utility demonstrating how to construct, sign, and submit multi-signature withdrawal transactions.
- **`pathPayment.js`**: CLI utility demonstrating cross-currency path payments via the Stellar DEX.
- **`trustlines.js`**: CLI utility demonstrating how to check and establish Stellar asset trustlines.

## Example CLI Usage

Ensure `backend/.env` is configured with testnet credentials:

```bash
# Check or add asset trustlines:
node contracts/stellar/trustlines.js --check <accountPublicKey> USDC
node contracts/stellar/trustlines.js --add <accountSecret> USDC <issuerPublicKey>

# Path payment quote:
node contracts/stellar/pathPayment.js --quote XLM 10 USDC

# Build and sign multi-signature withdrawal:
node contracts/stellar/multiSig.js --build <walletPublicKey> <destPublicKey> <amount> <asset>
node contracts/stellar/multiSig.js --sign <xdr> <signerSecret>
node contracts/stellar/multiSig.js --submit <xdr>
```
