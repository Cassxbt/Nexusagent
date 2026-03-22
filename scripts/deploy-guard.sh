#!/usr/bin/env bash
# Deploy NexusGuard to Arbitrum One
# Usage: ./scripts/deploy-guard.sh
#
# Requires:
#   - DEPLOYER_PRIVATE_KEY in .env (or exported in shell)
#   - Forge installed (brew install foundry)
#
# Default parameters (adjust as needed):
#   maxTransactionUsdt = 500000000  = $500  (6 decimals)
#   dailyLimitUsdt     = 2000000000 = $2000 (6 decimals)
#   maxSlippageBps     = 100        = 1%
#   cooldownSeconds    = 0          = no cooldown

set -e

if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ -z "$DEPLOYER_PRIVATE_KEY" ]; then
  echo "Error: DEPLOYER_PRIVATE_KEY not set in .env"
  exit 1
fi

RPC_URL="${ETH_RPC_URL:-https://arb1.arbitrum.io/rpc}"

echo "Deploying NexusGuard to Arbitrum One..."
echo "RPC: $RPC_URL"
echo ""

# Deploy with constructor args: maxTx=500e6, daily=2000e6, slippage=100bps, cooldown=0
DEPLOY_OUTPUT=$(forge create \
  contracts/NexusGuard.sol:NexusGuard \
  --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --constructor-args 500000000 2000000000 100 0 \
  --broadcast \
  2>&1)

echo "$DEPLOY_OUTPUT"

# Extract deployed address
DEPLOYED_ADDR=$(echo "$DEPLOY_OUTPUT" | grep "Deployed to:" | awk '{print $NF}')

if [ -z "$DEPLOYED_ADDR" ]; then
  echo "Could not extract deployed address. Check output above."
  exit 1
fi

echo ""
echo "✅ NexusGuard deployed to: $DEPLOYED_ADDR"
echo ""
echo "Add to .env:"
echo "  NEXUS_GUARD_ADDRESS=$DEPLOYED_ADDR"
echo ""
echo "View on Arbiscan:"
echo "  https://arbiscan.io/address/$DEPLOYED_ADDR"
