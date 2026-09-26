#!/usr/bin/env bash
# Test environment variables for CrowdPay
# Source this file before running tests: source test-env.sh && npm test
# All secrets here are NON-SECRET test defaults. Override in CI/local as needed.

export NODE_ENV=test
export JWT_SECRET=testsecret
export API_KEY_PEPPER=testpeppersecret
export USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
export STELLAR_NETWORK=testnet
export STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
export PLATFORM_SECRET_KEY=SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR
export ARBITRATOR_SECRET_KEY=SD5R3ADP7AC37OAYWYG73266DR2MBR6IJGXBLLAGCOWMTHLMPFAJMWPM
# Generate secure random keys for testing (32 bytes each)
# WALLET_ENCRYPTION_KEY: base64-encoded 32 bytes
export WALLET_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
# WALLET_SECRET_LOCAL_KEK: base64-encoded 32 bytes
export WALLET_SECRET_LOCAL_KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export OPS_API_KEY=test-ops-key
export UNSUBSCRIBE_SECRET=test-unsubscribe-secret
export IMPACT_SIGNING_SECRET=test-impact-secret
export DATABASE_URL=postgresql://postgres:password@localhost:5432/crowdpay_test
export REDIS_URL=redis://localhost:6379
export ENABLE_CAMPAIGN_STATUS_CRON=false