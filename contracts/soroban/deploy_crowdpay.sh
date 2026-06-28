#!/bin/bash
set -e

# Path to the Wasm file
WASM_PATH="target/wasm32-unknown-unknown/release/crowdpay.wasm"

# Check if build exists
if [ ! -f "$WASM_PATH" ]; then
    echo "Error: Wasm file not found at $WASM_PATH. Did you run 'make build' in the contract directory?"
    exit 1
fi

echo "Deploying contract to Stellar Testnet..."
# Deploying using 'deployer' key
CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source deployer \
    --network testnet)

echo "Contract deployed successfully! Contract ID: $CONTRACT_ID"

# Update manifest file
MANIFEST_FILE="deploy_manifest.json"
echo "Saving contract ID to $MANIFEST_FILE..."
cat <<EOF > "$MANIFEST_FILE"
{
  "contract_id": "$CONTRACT_ID",
  "name": "crowdpay",
  "network": "testnet",
  "deployed_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EOF

echo "Deployment complete."
