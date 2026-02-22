#!/usr/bin/env bash
set -euo pipefail

# OCP Integration Test
# Validates the full stack: chain → coordinator → dealer → bots → hand completion.
#
# Usage:
#   ./scripts/integration-test.sh [--keep]
#
# Options:
#   --keep    Don't clean up processes on exit (for debugging)
#
# Prerequisites:
#   - pnpm install completed
#   - Go toolchain available (for building ocpd)
#   - Packages built (pnpm -C packages/ocp-crypto build, etc.)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

KEEP=false
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=true ;;
  esac
done

LOG_DIR=$(mktemp -d)
PIDS=()

log() { echo "[integration] $*"; }
fail() { echo "[integration] FAIL: $*" >&2; exit 1; }

cleanup() {
  if [ "$KEEP" = true ]; then
    log "Keeping processes alive (--keep). Logs in: $LOG_DIR"
    log "PIDs: ${PIDS[*]}"
    return 0
  fi
  log "Cleaning up..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

# ── 1. Build chain binary ──

log "Building ocpd..."
OCPD_BIN="$PROJECT_ROOT/apps/cosmos/bin/ocpd"
(cd "$PROJECT_ROOT/apps/cosmos" && go build -o "$OCPD_BIN" ./cmd/ocpd) || fail "ocpd build failed"

# ── 2. Initialize and start chain ──

OCP_HOME="$LOG_DIR/chain-home"
CHAIN_ID="ocp-integration-1"
MONIKER="validator"
DENOM="uocp"

log "Initializing chain at $OCP_HOME..."
"$OCPD_BIN" init "$MONIKER" --chain-id "$CHAIN_ID" --home "$OCP_HOME" >/dev/null 2>&1

# Create validator key
VALIDATOR_ADDR=$("$OCPD_BIN" keys add validator --keyring-backend test --home "$OCP_HOME" --output json 2>/dev/null | jq -r '.address')
log "Validator address: $VALIDATOR_ADDR"

# Create two bot keys
BOT1_OUT=$("$OCPD_BIN" keys add bot1 --keyring-backend test --home "$OCP_HOME" --output json 2>/dev/null)
BOT1_ADDR=$(echo "$BOT1_OUT" | jq -r '.address')
BOT1_MNEMONIC=$(echo "$BOT1_OUT" | jq -r '.mnemonic')

BOT2_OUT=$("$OCPD_BIN" keys add bot2 --keyring-backend test --home "$OCP_HOME" --output json 2>/dev/null)
BOT2_ADDR=$(echo "$BOT2_OUT" | jq -r '.address')
BOT2_MNEMONIC=$(echo "$BOT2_OUT" | jq -r '.mnemonic')

log "Bot1: $BOT1_ADDR"
log "Bot2: $BOT2_ADDR"

# Fund accounts in genesis
"$OCPD_BIN" genesis add-genesis-account "$VALIDATOR_ADDR" "100000000${DENOM}" --keyring-backend test --home "$OCP_HOME" >/dev/null 2>&1
"$OCPD_BIN" genesis add-genesis-account "$BOT1_ADDR" "100000000${DENOM}" --keyring-backend test --home "$OCP_HOME" >/dev/null 2>&1
"$OCPD_BIN" genesis add-genesis-account "$BOT2_ADDR" "100000000${DENOM}" --keyring-backend test --home "$OCP_HOME" >/dev/null 2>&1

# Create genesis table
GENESIS_FILE="$OCP_HOME/config/genesis.json"
TMP_GENESIS="$LOG_DIR/genesis_tmp.json"
jq '.app_state.poker.tables = [{
  "id": "1",
  "params": {
    "maxPlayers": "9",
    "smallBlind": "50000",
    "bigBlind": "100000",
    "minBuyIn": "1000000",
    "maxBuyIn": "100000000",
    "actionTimeoutSecs": "30",
    "dealerTimeoutSecs": "30"
  },
  "seats": [{},{},{},{},{},{},{},{},{}],
  "status": "TABLE_STATUS_OPEN"
}]' "$GENESIS_FILE" > "$TMP_GENESIS" && mv "$TMP_GENESIS" "$GENESIS_FILE"

# Gentx
"$OCPD_BIN" genesis gentx validator "10000000${DENOM}" --chain-id "$CHAIN_ID" --keyring-backend test --home "$OCP_HOME" >/dev/null 2>&1
"$OCPD_BIN" genesis collect-gentxs --home "$OCP_HOME" >/dev/null 2>&1

# Configure fast blocks
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/' "$OCP_HOME/config/config.toml"
sed -i.bak 's/timeout_propose = "3s"/timeout_propose = "1s"/' "$OCP_HOME/config/config.toml"

log "Starting chain..."
"$OCPD_BIN" start --home "$OCP_HOME" --minimum-gas-prices "0${DENOM}" >"$LOG_DIR/chain.log" 2>&1 &
PIDS+=($!)

# Wait for first block
log "Waiting for first block..."
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:26657/status 2>/dev/null | jq -e '.result.sync_info.latest_block_height | tonumber > 0' >/dev/null 2>&1; then
    log "Chain is producing blocks"
    break
  fi
  if [ "$i" -eq 60 ]; then
    tail -50 "$LOG_DIR/chain.log" || true
    fail "Chain did not start producing blocks"
  fi
  sleep 1
done

# ── 3. Build and start coordinator ──

log "Building coordinator..."
pnpm -C "$PROJECT_ROOT/apps/coordinator" build >"$LOG_DIR/coordinator-build.log" 2>&1 || fail "coordinator build failed"

log "Starting coordinator..."
COORDINATOR_PORT=8788
COORDINATOR_COSMOS_RPC_URL=http://127.0.0.1:26657 \
COORDINATOR_COSMOS_LCD_URL=http://127.0.0.1:1317 \
COORDINATOR_PORT=$COORDINATOR_PORT \
node "$PROJECT_ROOT/apps/coordinator/dist/index.js" >"$LOG_DIR/coordinator.log" 2>&1 &
PIDS+=($!)

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$COORDINATOR_PORT/health" >/dev/null 2>&1; then
    log "Coordinator is healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    tail -30 "$LOG_DIR/coordinator.log" || true
    fail "Coordinator did not become healthy"
  fi
  sleep 1
done

# ── 4. Build and start dealer daemon ──

log "Building dealer-daemon..."
pnpm -C "$PROJECT_ROOT/apps/dealer-daemon" build >"$LOG_DIR/dealer-build.log" 2>&1 || fail "dealer-daemon build failed"

log "Starting dealer daemon..."
DEALER_COSMOS_RPC_URL=http://127.0.0.1:26657 \
DEALER_COSMOS_LCD_URL=http://127.0.0.1:1317 \
DEALER_TABLE_IDS=1 \
DEALER_MNEMONIC=$("$OCPD_BIN" keys export validator --keyring-backend test --home "$OCP_HOME" --unsafe --unarmored-hex 2>/dev/null | head -1) \
DEALER_COORDINATOR_URL="http://127.0.0.1:$COORDINATOR_PORT" \
node "$PROJECT_ROOT/apps/dealer-daemon/dist/index.js" >"$LOG_DIR/dealer.log" 2>&1 &
PIDS+=($!)
sleep 2

# ── 5. Build and start bots ──

log "Building bot..."
pnpm -C "$PROJECT_ROOT/apps/bot" build >"$LOG_DIR/bot-build.log" 2>&1 || fail "bot build failed"

log "Starting bot 1 (calling-station)..."
BOT_TABLE_ID=1 \
BOT_MNEMONIC="$BOT1_MNEMONIC" \
BOT_STRATEGY=calling-station \
BOT_AUTO_SIT=true \
BOT_AUTO_START_HAND=true \
BOT_AUTO_REBUY=true \
BOT_POLL_INTERVAL_MS=500 \
BOT_NAME=bot1 \
node "$PROJECT_ROOT/apps/bot/dist/index.js" >"$LOG_DIR/bot1.log" 2>&1 &
PIDS+=($!)

log "Starting bot 2 (tag)..."
BOT_TABLE_ID=1 \
BOT_MNEMONIC="$BOT2_MNEMONIC" \
BOT_STRATEGY=tag \
BOT_AUTO_SIT=true \
BOT_AUTO_START_HAND=true \
BOT_AUTO_REBUY=true \
BOT_POLL_INTERVAL_MS=500 \
BOT_NAME=bot2 \
node "$PROJECT_ROOT/apps/bot/dist/index.js" >"$LOG_DIR/bot2.log" 2>&1 &
PIDS+=($!)

# ── 6. Wait for hands to complete ──

TARGET_HANDS=3
TIMEOUT_SECS=120
log "Waiting for $TARGET_HANDS hands to complete (timeout: ${TIMEOUT_SECS}s)..."

for i in $(seq 1 "$TIMEOUT_SECS"); do
  # Query the table to check hand count
  TABLE_JSON=$(curl -fsS "http://127.0.0.1:1317/onchainpoker/poker/v1/tables/1" 2>/dev/null || echo "{}")
  HAND_ID=$(echo "$TABLE_JSON" | jq -r '.table.hand.handId // .table.hand.hand_id // "0"' 2>/dev/null || echo "0")

  # Count completed hand events from coordinator
  EVENTS_JSON=$(curl -fsS "http://127.0.0.1:$COORDINATOR_PORT/v1/events?limit=100" 2>/dev/null || echo '{"events":[]}')
  HAND_COMPLETED_COUNT=$(echo "$EVENTS_JSON" | jq '[.events[] | select(.name == "HandCompleted")] | length' 2>/dev/null || echo "0")

  if [ "$HAND_COMPLETED_COUNT" -ge "$TARGET_HANDS" ]; then
    log "Reached $HAND_COMPLETED_COUNT completed hands"
    break
  fi

  if [ "$i" -eq "$TIMEOUT_SECS" ]; then
    log "Logs:"
    echo "--- chain (last 20 lines) ---"
    tail -20 "$LOG_DIR/chain.log" || true
    echo "--- coordinator (last 20 lines) ---"
    tail -20 "$LOG_DIR/coordinator.log" || true
    echo "--- dealer (last 20 lines) ---"
    tail -20 "$LOG_DIR/dealer.log" || true
    echo "--- bot1 (last 20 lines) ---"
    tail -20 "$LOG_DIR/bot1.log" || true
    echo "--- bot2 (last 20 lines) ---"
    tail -20 "$LOG_DIR/bot2.log" || true
    fail "Only $HAND_COMPLETED_COUNT/$TARGET_HANDS hands completed after ${TIMEOUT_SECS}s"
  fi

  sleep 1
done

# ── 7. Assertions ──

log "Running assertions..."

# Check chain is still running
curl -fsS http://127.0.0.1:26657/status >/dev/null 2>&1 || fail "Chain died during test"

# Check coordinator is still healthy
curl -fsS "http://127.0.0.1:$COORDINATOR_PORT/health" >/dev/null 2>&1 || fail "Coordinator died during test"

# Verify hands completed
FINAL_EVENTS=$(curl -fsS "http://127.0.0.1:$COORDINATOR_PORT/v1/events?limit=200" 2>/dev/null)
HAND_COUNT=$(echo "$FINAL_EVENTS" | jq '[.events[] | select(.name == "HandCompleted")] | length')
POT_AWARDED=$(echo "$FINAL_EVENTS" | jq '[.events[] | select(.name == "PotAwarded")] | length')

log "Completed hands: $HAND_COUNT"
log "Pots awarded: $POT_AWARDED"

[ "$HAND_COUNT" -ge "$TARGET_HANDS" ] || fail "Expected >= $TARGET_HANDS completed hands, got $HAND_COUNT"
[ "$POT_AWARDED" -ge 1 ] || fail "Expected >= 1 pot awarded, got $POT_AWARDED"

# Check no crashes in bot logs
for botlog in "$LOG_DIR"/bot*.log; do
  if grep -qi "fatal\|unhandled\|ECONNREFUSED" "$botlog" 2>/dev/null; then
    log "WARNING: potential error in $(basename "$botlog"):"
    grep -i "fatal\|unhandled\|ECONNREFUSED" "$botlog" | head -5
  fi
done

echo ""
log "=== Integration test PASSED ==="
log "  Hands completed: $HAND_COUNT"
log "  Pots awarded: $POT_AWARDED"
log "  Logs: $LOG_DIR"
