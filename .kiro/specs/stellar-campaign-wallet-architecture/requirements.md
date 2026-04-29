# Requirements Document

## Introduction

This document specifies the requirements for implementing a secure, auditable Stellar on-chain architecture where each campaign has its own dedicated Stellar account for fund management. The system must handle account creation, secure key storage, multisignature escrow, and provide comprehensive documentation for developers and operators managing the wallet lifecycle.

CrowdPay is a crowdfunding platform built on Stellar blockchain. The platform uses a custodial model where the backend manages Stellar accounts on behalf of users and campaigns. Each campaign requires a dedicated Stellar account configured with multisignature controls to ensure funds are held in escrow until both the campaign creator and platform approve withdrawals.

## Glossary

- **Campaign_Wallet**: A Stellar account created specifically for a single campaign to receive and hold contributions
- **Platform_Account**: The master Stellar account controlled by the CrowdPay platform, used to fund new campaign wallets and cosign withdrawals
- **Creator_Account**: The Stellar account belonging to the campaign creator, used as a cosigner for campaign wallet operations
- **Multisig_Escrow**: A Stellar account configuration requiring multiple signatures (creator + platform) to authorize fund movements
- **Trustline**: A Stellar protocol mechanism that allows an account to hold and receive a specific asset beyond XLM
- **Horizon**: Stellar's REST API server for submitting transactions and querying ledger state
- **XDR**: External Data Representation format used by Stellar to encode transactions
- **Friendbot**: Stellar testnet service that funds new accounts with test XLM
- **Base_Reserve**: Minimum XLM balance required for a Stellar account to exist (currently 1 XLM on mainnet)
- **Keypair**: A public/private key pair used for Stellar account identity and transaction signing
- **Ledger_Monitor**: Backend service that streams Stellar ledger events to detect incoming contributions
- **KMS**: Key Management Service for encrypting and storing private keys securely

## Requirements

### Requirement 1: Campaign Wallet Creation

**User Story:** As a campaign creator, I want a dedicated Stellar account created automatically when I create a campaign, so that contributions are held in a secure, auditable on-chain wallet.

#### Acceptance Criteria

1. WHEN a new campaign is created, THE Campaign_Wallet_Service SHALL generate a new Stellar Keypair
2. WHEN a new campaign is created, THE Campaign_Wallet_Service SHALL fund the new Campaign_Wallet with sufficient XLM to cover the Base_Reserve and trustline reserves
3. WHEN a Campaign_Wallet is funded, THE Campaign_Wallet_Service SHALL establish a trustline to USDC on the Campaign_Wallet
4. WHEN a Campaign_Wallet trustline is established, THE Campaign_Wallet_Service SHALL configure the Campaign_Wallet with multisignature controls requiring both Creator_Account and Platform_Account signatures
5. WHEN multisignature configuration is complete, THE Campaign_Wallet_Service SHALL set the Campaign_Wallet master key weight to 0
6. WHEN a Campaign_Wallet is successfully created, THE Campaign_Wallet_Service SHALL return the public key to the caller
7. WHEN a Campaign_Wallet is successfully created, THE Campaign_Wallet_Service SHALL store the encrypted private key in the database
8. IF Campaign_Wallet creation fails at any step, THEN THE Campaign_Wallet_Service SHALL return a descriptive error and roll back any partial Stellar operations

### Requirement 2: Secure Key Management

**User Story:** As a platform operator, I want campaign wallet private keys encrypted and stored securely, so that funds are protected from unauthorized access.

#### Acceptance Criteria

1. THE Key_Storage_Service SHALL encrypt all Campaign_Wallet private keys before storing them in the database
2. THE Key_Storage_Service SHALL use a KMS or environment-based encryption key for private key encryption
3. THE Key_Storage_Service SHALL never return unencrypted private keys in API responses
4. THE Key_Storage_Service SHALL never log private keys in plaintext
5. WHERE the system is running in production, THE Key_Storage_Service SHALL use a hardware security module or cloud KMS for encryption key storage
6. WHEN a Campaign_Wallet private key is needed for signing, THE Key_Storage_Service SHALL decrypt it in memory and clear it immediately after use
7. THE Database_Schema SHALL store encrypted private keys in a dedicated column separate from public keys

### Requirement 3: Multisignature Escrow Configuration

**User Story:** As a platform operator, I want campaign wallets configured with multisignature controls, so that funds cannot be withdrawn without both creator and platform approval.

#### Acceptance Criteria

1. WHEN a Campaign_Wallet is configured, THE Campaign_Wallet_Service SHALL add the Creator_Account public key as a signer with weight 1
2. WHEN a Campaign_Wallet is configured, THE Campaign_Wallet_Service SHALL add the Platform_Account public key as a signer with weight 1
3. WHEN signers are added, THE Campaign_Wallet_Service SHALL set the medium threshold to 2
4. WHEN signers are added, THE Campaign_Wallet_Service SHALL set the high threshold to 2
5. WHEN thresholds are set, THE Campaign_Wallet_Service SHALL set the master key weight to 0
6. THE Campaign_Wallet_Service SHALL verify that payment operations require weight 2 after configuration
7. IF multisignature configuration fails, THEN THE Campaign_Wallet_Service SHALL return an error indicating which configuration step failed

### Requirement 4: Withdrawal Transaction Signing

**User Story:** As a campaign creator, I want to initiate withdrawals that require platform approval, so that funds are released through a secure multisignature process.

#### Acceptance Criteria

1. WHEN a withdrawal is requested, THE Withdrawal_Service SHALL build an unsigned Stellar payment transaction in XDR format
2. WHEN an unsigned transaction is built, THE Withdrawal_Service SHALL store the XDR in the withdrawal_requests table
3. WHEN a creator requests to sign a withdrawal, THE Withdrawal_Service SHALL load the unsigned XDR and add the creator signature
4. WHEN a platform operator approves a withdrawal, THE Withdrawal_Service SHALL load the partially signed XDR and add the platform signature
5. WHEN both signatures are collected, THE Withdrawal_Service SHALL submit the fully signed transaction to Horizon
6. WHEN a withdrawal transaction is submitted, THE Withdrawal_Service SHALL update the withdrawal request status to 'submitted'
7. IF a withdrawal transaction submission fails, THEN THE Withdrawal_Service SHALL update the withdrawal request status to 'failed' and store the error message
8. THE Withdrawal_Service SHALL verify that the transaction has exactly 2 signatures before submission

### Requirement 5: Account Balance Monitoring

**User Story:** As a campaign creator, I want to see the current balance of my campaign wallet, so that I can track contributions in real time.

#### Acceptance Criteria

1. WHEN a balance query is requested, THE Balance_Service SHALL load the Campaign_Wallet account from Horizon
2. WHEN a Campaign_Wallet account is loaded, THE Balance_Service SHALL extract all asset balances
3. WHEN asset balances are extracted, THE Balance_Service SHALL return balances as a map of asset code to amount
4. THE Balance_Service SHALL normalize native asset balances to the asset code 'XLM'
5. THE Balance_Service SHALL normalize non-native asset balances to their asset code
6. IF a Campaign_Wallet account does not exist on the ledger, THEN THE Balance_Service SHALL return an error indicating the account is not found

### Requirement 6: Contribution Detection and Indexing

**User Story:** As a platform operator, I want incoming contributions automatically detected and indexed, so that campaign progress updates in real time.

#### Acceptance Criteria

1. WHEN a Campaign_Wallet is created, THE Ledger_Monitor SHALL open a Horizon payment stream for that wallet
2. WHEN a payment is received on a monitored Campaign_Wallet, THE Ledger_Monitor SHALL extract the transaction hash, sender, amount, and asset
3. WHEN payment details are extracted, THE Ledger_Monitor SHALL check if the transaction hash already exists in the contributions table
4. IF the transaction hash does not exist, THEN THE Ledger_Monitor SHALL insert a new contribution record
5. WHEN a contribution record is inserted, THE Ledger_Monitor SHALL update the campaign raised_amount by the contribution amount
6. WHEN a path payment is received, THE Ledger_Monitor SHALL extract both source and destination amounts and assets
7. WHEN a path payment is indexed, THE Ledger_Monitor SHALL calculate and store the conversion rate
8. IF contribution indexing fails, THEN THE Ledger_Monitor SHALL roll back the database transaction and log the error

### Requirement 7: Testnet Account Funding

**User Story:** As a developer, I want to fund new testnet accounts automatically, so that I can test campaign wallet creation without manual setup.

#### Acceptance Criteria

1. WHERE the system is running on testnet, THE Testnet_Service SHALL provide a function to fund accounts using Friendbot
2. WHEN a testnet funding request is made, THE Testnet_Service SHALL call the Friendbot API with the account public key
3. WHEN Friendbot funding succeeds, THE Testnet_Service SHALL return the funding transaction details
4. IF the system is running on mainnet, THEN THE Testnet_Service SHALL return an error indicating Friendbot is not available
5. THE Testnet_Service SHALL validate that the STELLAR_NETWORK environment variable is set to 'testnet' before calling Friendbot

### Requirement 8: Developer Documentation

**User Story:** As a developer, I want comprehensive documentation for wallet creation and management, so that I can understand and maintain the Stellar integration.

#### Acceptance Criteria

1. THE Documentation SHALL include a step-by-step guide for creating a Campaign_Wallet
2. THE Documentation SHALL include code examples for each wallet operation
3. THE Documentation SHALL include a diagram showing the multisignature escrow flow
4. THE Documentation SHALL include instructions for key encryption and storage
5. THE Documentation SHALL include troubleshooting steps for common Stellar errors
6. THE Documentation SHALL include instructions for switching between testnet and mainnet
7. THE Documentation SHALL include security best practices for key management
8. THE Documentation SHALL include instructions for monitoring campaign wallet balances

### Requirement 9: Operator Documentation

**User Story:** As a platform operator, I want operational procedures for wallet lifecycle management, so that I can safely manage campaign wallets in production.

#### Acceptance Criteria

1. THE Operator_Documentation SHALL include procedures for platform account setup
2. THE Operator_Documentation SHALL include procedures for funding the Platform_Account with sufficient XLM reserves
3. THE Operator_Documentation SHALL include procedures for approving withdrawal requests
4. THE Operator_Documentation SHALL include procedures for monitoring Ledger_Monitor health
5. THE Operator_Documentation SHALL include procedures for key rotation
6. THE Operator_Documentation SHALL include procedures for disaster recovery
7. THE Operator_Documentation SHALL include procedures for auditing campaign wallet transactions
8. THE Operator_Documentation SHALL include procedures for handling failed transactions

### Requirement 10: API Endpoints for Wallet Operations

**User Story:** As a frontend developer, I want REST API endpoints for wallet operations, so that I can integrate campaign wallet functionality into the UI.

#### Acceptance Criteria

1. THE API SHALL provide a POST endpoint to create a Campaign_Wallet during campaign creation
2. THE API SHALL provide a GET endpoint to retrieve Campaign_Wallet balance
3. THE API SHALL provide a GET endpoint to retrieve Campaign_Wallet multisignature configuration
4. THE API SHALL provide a POST endpoint to initiate a withdrawal request
5. THE API SHALL provide a POST endpoint to sign a withdrawal request
6. THE API SHALL provide a GET endpoint to retrieve withdrawal request status
7. THE API SHALL authenticate all wallet operation endpoints using JWT tokens
8. THE API SHALL validate that only campaign creators can initiate withdrawals for their campaigns
9. THE API SHALL validate that only platform operators can approve withdrawals
10. IF an API request fails validation, THEN THE API SHALL return a 400 or 403 status code with a descriptive error message

### Requirement 11: Transaction Audit Trail

**User Story:** As a platform operator, I want a complete audit trail of all wallet transactions, so that I can verify fund flows and investigate issues.

#### Acceptance Criteria

1. THE Database_Schema SHALL store all contribution transactions with transaction hash, sender, amount, asset, and timestamp
2. THE Database_Schema SHALL store all withdrawal requests with unsigned XDR, signature status, and transaction hash
3. WHEN a contribution is indexed, THE Audit_Service SHALL log the transaction hash and campaign ID
4. WHEN a withdrawal is signed, THE Audit_Service SHALL log the signer identity and timestamp
5. WHEN a withdrawal is submitted, THE Audit_Service SHALL log the transaction hash and submission result
6. THE Audit_Service SHALL provide a query interface to retrieve all transactions for a Campaign_Wallet
7. THE Audit_Service SHALL provide a query interface to retrieve all withdrawal requests for a campaign
8. THE Audit_Service SHALL ensure transaction records are immutable after creation

### Requirement 12: Error Handling and Recovery

**User Story:** As a platform operator, I want robust error handling for wallet operations, so that transient failures do not leave the system in an inconsistent state.

#### Acceptance Criteria

1. WHEN a Stellar transaction submission fails, THE Error_Handler SHALL parse the Horizon error response
2. WHEN a Horizon error is parsed, THE Error_Handler SHALL return a user-friendly error message
3. IF a Campaign_Wallet creation fails after funding, THEN THE Error_Handler SHALL log the orphaned account public key for manual recovery
4. IF a withdrawal transaction fails after both signatures are collected, THEN THE Error_Handler SHALL mark the withdrawal request as 'failed' and allow retry
5. WHEN a Ledger_Monitor stream connection is lost, THE Ledger_Monitor SHALL automatically reconnect
6. WHEN a Ledger_Monitor reconnects, THE Ledger_Monitor SHALL resume streaming from the last processed cursor
7. THE Error_Handler SHALL distinguish between retryable errors and permanent failures
8. THE Error_Handler SHALL log all Stellar errors with full context for debugging

### Requirement 13: Configuration Management

**User Story:** As a developer, I want centralized configuration for Stellar network settings, so that I can easily switch between testnet and mainnet.

#### Acceptance Criteria

1. THE Configuration_Service SHALL load Stellar network settings from environment variables
2. THE Configuration_Service SHALL support 'testnet' and 'mainnet' network modes
3. WHEN the network mode is 'testnet', THE Configuration_Service SHALL use Horizon testnet URL
4. WHEN the network mode is 'mainnet', THE Configuration_Service SHALL use Horizon mainnet URL
5. THE Configuration_Service SHALL load the Platform_Account secret key from environment variables
6. THE Configuration_Service SHALL validate that all required environment variables are set on startup
7. IF required environment variables are missing, THEN THE Configuration_Service SHALL throw an error and prevent application startup
8. THE Configuration_Service SHALL provide a function to retrieve the current network passphrase

### Requirement 14: Asset Support

**User Story:** As a campaign creator, I want my campaign wallet to support multiple Stellar assets, so that I can accept contributions in different currencies.

#### Acceptance Criteria

1. THE Campaign_Wallet_Service SHALL establish a trustline to USDC during wallet creation
2. THE Asset_Service SHALL provide a function to add additional trustlines to a Campaign_Wallet
3. WHEN a trustline is added, THE Asset_Service SHALL build and submit a changeTrust operation
4. THE Asset_Service SHALL validate that the asset issuer is configured before adding a trustline
5. THE Asset_Service SHALL return a list of supported asset codes
6. THE Asset_Service SHALL convert asset codes to Stellar Asset objects for transaction building
7. IF an unsupported asset code is provided, THEN THE Asset_Service SHALL return an error

### Requirement 15: Path Payment Support

**User Story:** As a contributor, I want to contribute in any Stellar asset and have it automatically converted to the campaign's target asset, so that I can contribute without manual currency conversion.

#### Acceptance Criteria

1. WHEN a path payment contribution is requested, THE Path_Payment_Service SHALL build a pathPaymentStrictReceive operation
2. WHEN a path payment is built, THE Path_Payment_Service SHALL set the destination asset to the campaign's target asset
3. WHEN a path payment is built, THE Path_Payment_Service SHALL set the destination amount to the contributor's specified amount
4. WHEN a path payment is built, THE Path_Payment_Service SHALL calculate the maximum source amount with slippage tolerance
5. THE Path_Payment_Service SHALL provide a quote function that queries Stellar DEX for conversion paths
6. WHEN a quote is requested, THE Path_Payment_Service SHALL return the source amount required for the destination amount
7. WHEN a path payment is submitted, THE Path_Payment_Service SHALL include the transaction hash in the response
8. IF no conversion path exists, THEN THE Path_Payment_Service SHALL return an error indicating the assets cannot be converted