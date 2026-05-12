#!/usr/bin/env bash
set -euo pipefail

CLUSTER="${1:-devnet}"
PROGRAM_NAME="magicblock_negotiation"
PROGRAM_ID="BfFvxgysVSGdP2TwAjBRSFhDYtK2JA1VBd8BUqh8nGGq"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SO_PATH="target/deploy/${PROGRAM_NAME}.so"
IDL_PATH="target/idl/${PROGRAM_NAME}.json"
IDL_TS_PATH="target/types/${PROGRAM_NAME}.ts"
AGENT_IDL_DIR="../middleman-agent/src/idl"

echo "Checking upgrade authority for ${PROGRAM_ID} on ${CLUSTER}..."
WALLET_ADDR="$(solana address)"
PROGRAM_INFO="$(solana program show "$PROGRAM_ID" --url "$CLUSTER")"
AUTHORITY="$(printf '%s\n' "$PROGRAM_INFO" | awk -F': ' '/Authority:/ {print $2}')"

if [[ "$AUTHORITY" != "$WALLET_ADDR" ]]; then
  echo "Upgrade authority mismatch."
  echo "  Wallet:    ${WALLET_ADDR}"
  echo "  Authority: ${AUTHORITY}"
  exit 1
fi

echo "Building ${PROGRAM_NAME}..."
anchor build -p "$PROGRAM_NAME"

echo "Syncing generated IDL into middleman-agent..."
cp "$IDL_PATH" "${AGENT_IDL_DIR}/${PROGRAM_NAME}.json"
cp "$IDL_TS_PATH" "${AGENT_IDL_DIR}/${PROGRAM_NAME}.ts"

LOCAL_SIZE="$(stat -f%z "$SO_PATH")"
PROGRAM_INFO="$(solana program show "$PROGRAM_ID" --url "$CLUSTER")"
DEPLOYED_SIZE="$(printf '%s\n' "$PROGRAM_INFO" | awk -F': ' '/Data Length:/ {print $2}' | awk '{print $1}')"

if [[ -z "$DEPLOYED_SIZE" ]]; then
  echo "Could not determine deployed program size for ${PROGRAM_ID}."
  exit 1
fi

if (( LOCAL_SIZE > DEPLOYED_SIZE )); then
  EXTRA_BYTES=$((LOCAL_SIZE - DEPLOYED_SIZE))
  echo "Extending ${PROGRAM_ID} by ${EXTRA_BYTES} bytes..."
  solana program extend "$PROGRAM_ID" "$EXTRA_BYTES" --url "$CLUSTER"
else
  echo "No extend needed. Local size ${LOCAL_SIZE}, deployed size ${DEPLOYED_SIZE}."
fi

echo "Uploading program data to buffer..."
BUFFER_JSON="$(solana program write-buffer "$SO_PATH" --url "$CLUSTER" --output json-compact)"
BUFFER_PUBKEY="$(node -e 'console.log(JSON.parse(process.argv[1]).buffer)' "$BUFFER_JSON")"
echo "Buffer: ${BUFFER_PUBKEY}"

echo "Upgrading ${PROGRAM_ID}..."
solana program upgrade "$BUFFER_PUBKEY" "$PROGRAM_ID" --url "$CLUSTER"

echo "Upgrade complete."
solana program show "$PROGRAM_ID" --url "$CLUSTER"
