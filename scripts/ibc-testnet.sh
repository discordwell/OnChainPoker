#!/usr/bin/env bash
# IBC testnet setup: local OCP chain <-> Osmosis testnet (osmo-test-5)
#
# Usage:
#   ./scripts/ibc-testnet.sh            # run the full flow
#   ./scripts/ibc-testnet.sh keys       # only create/show relayer keys
#   ./scripts/ibc-testnet.sh channel    # only create the IBC channel
#   ./scripts/ibc-testnet.sh transfer   # only send a test IBC transfer
#   ./scripts/ibc-testnet.sh relay      # only start the relayer
#
# Prerequisites:
#   - hermes installed (brew install hermes / cargo install ibc-relayer-cli)
#   - local OCP chain running (apps/cosmos/scripts/localnet.sh)
#   - Osmosis testnet relayer key funded (see Step 2 output for faucet URL)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HERMES_CONFIG="$ROOT/deploy/hermes-testnet.toml"
OCPD="$ROOT/apps/cosmos/bin/ocpd"
OCPD_HOME="$ROOT/apps/cosmos/.ocpd"

OCP_CHAIN_ID="ocp-local-1"
OSMO_CHAIN_ID="osmo-test-5"
DENOM="uocp"
TRANSFER_AMOUNT="${IBC_TRANSFER_AMOUNT:-1000000}" # 1 OCP
OCP_CHANNEL=""  # populated by create_channel

# ── Helpers ──────────────────────────────────────────────────────────

info()  { echo -e "\033[1;34m[ibc-testnet]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[ibc-testnet]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[ibc-testnet]\033[0m $*"; }
err()   { echo -e "\033[1;31m[ibc-testnet]\033[0m $*" >&2; }
die()   { err "$@"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found. $2"
}

hermes_cmd() {
  hermes --config "$HERMES_CONFIG" "$@"
}

ocpd_cmd() {
  "$OCPD" --home "$OCPD_HOME" --keyring-backend test "$@"
}

wait_for_chain() {
  info "waiting for local OCP chain to be ready..."
  local retries=30
  for ((i = 1; i <= retries; i++)); do
    if curl -sf http://127.0.0.1:26657/status >/dev/null 2>&1; then
      ok "local chain is ready"
      return 0
    fi
    sleep 1
  done
  die "local OCP chain not reachable on localhost:26657 after ${retries}s"
}

# ── Step 1: Check prerequisites ─────────────────────────────────────

check_prereqs() {
  info "checking prerequisites..."

  require_cmd hermes "Install with: brew install hermes"
  info "hermes version: $(hermes version 2>&1 | head -1)"

  if [[ ! -x "$OCPD" ]]; then
    die "ocpd binary not found at $OCPD — run apps/cosmos/scripts/localnet.sh first"
  fi

  if [[ ! -f "$HERMES_CONFIG" ]]; then
    die "hermes config not found at $HERMES_CONFIG"
  fi

  ok "prerequisites OK"
}

# ── Step 2: Create relayer keys ──────────────────────────────────────

setup_keys() {
  info "setting up relayer keys..."

  # Hermes generates + stores its own key; we fund it from the ocpd test keyring faucet
  if hermes_cmd keys list --chain "$OCP_CHAIN_ID" 2>/dev/null | grep -q "relayer"; then
    info "OCP relayer key already exists"
  else
    info "adding relayer key for $OCP_CHAIN_ID..."
    hermes_cmd keys add --chain "$OCP_CHAIN_ID" --key-name relayer --overwrite 2>&1 | tee /dev/stderr
  fi

  # Show the OCP relayer address
  local ocp_relayer_addr
  ocp_relayer_addr=$(hermes_cmd keys list --chain "$OCP_CHAIN_ID" 2>/dev/null | grep -oE 'ocp1[a-z0-9]+' | head -1 || echo "unknown")
  info "OCP relayer address: $ocp_relayer_addr"

  # Fund OCP relayer from faucet account
  if [[ "$ocp_relayer_addr" != "unknown" ]]; then
    info "funding OCP relayer from faucet..."
    ocpd_cmd tx bank send faucet "$ocp_relayer_addr" "10000000${DENOM}" \
      --chain-id "$OCP_CHAIN_ID" \
      --fees "0${DENOM}" \
      --yes \
      --output json 2>/dev/null || warn "funding tx may have failed (check manually)"
    sleep 2
    info "OCP relayer balance:"
    ocpd_cmd query bank balances "$ocp_relayer_addr" --output json 2>/dev/null || true
  fi

  # Osmosis testnet key
  if hermes_cmd keys list --chain "$OSMO_CHAIN_ID" 2>/dev/null | grep -q "relayer"; then
    info "Osmosis relayer key already exists"
  else
    info "adding relayer key for $OSMO_CHAIN_ID..."
    hermes_cmd keys add --chain "$OSMO_CHAIN_ID" --key-name relayer --overwrite 2>&1 | tee /dev/stderr
  fi

  local osmo_relayer_addr
  osmo_relayer_addr=$(hermes_cmd keys list --chain "$OSMO_CHAIN_ID" 2>/dev/null | grep -oE 'osmo1[a-z0-9]+' | head -1 || echo "unknown")
  info "Osmosis relayer address: $osmo_relayer_addr"

  echo ""
  warn "Fund the Osmosis relayer with testnet OSMO:"
  warn "  Faucet: https://faucet.testnet.osmosis.zone"
  warn "  Address: $osmo_relayer_addr"
  echo ""

  ok "relayer keys ready"
}

# ── Step 3: Health check ─────────────────────────────────────────────

health_check() {
  info "running hermes health check..."
  if hermes_cmd health-check; then
    ok "both chains reachable"
  else
    err "health check failed — is the local chain running and Osmosis testnet reachable?"
    return 1
  fi
}

# ── Step 4: Create IBC channel ───────────────────────────────────────

create_channel() {
  info "creating IBC channel (client + connection + channel)..."
  info "this may take a minute as it requires multiple on-chain txs on both chains..."
  echo ""

  local output
  output=$(hermes_cmd create channel \
    --a-chain "$OCP_CHAIN_ID" \
    --b-chain "$OSMO_CHAIN_ID" \
    --a-port transfer \
    --b-port transfer \
    --new-client-connection 2>&1) || { echo "$output"; die "channel creation failed"; }
  echo "$output"

  # Extract the channel ID from hermes output (e.g. "channel-0")
  OCP_CHANNEL=$(echo "$output" | grep -oE 'channel-[0-9]+' | head -1)
  OCP_CHANNEL="${OCP_CHANNEL:-channel-0}"

  echo ""
  ok "IBC channel created: $OCP_CHANNEL"
  info "verifying channel state..."
  hermes_cmd query channel end --chain "$OCP_CHAIN_ID" --port transfer --channel "$OCP_CHANNEL" || true
}

# ── Step 5: Test IBC transfer ────────────────────────────────────────

test_transfer() {
  local channel="${OCP_CHANNEL:-channel-0}"
  info "sending test IBC transfer: ${TRANSFER_AMOUNT}${DENOM} from alice on OCP -> Osmosis via $channel..."

  # Get the Osmosis relayer address as the receiver
  local osmo_addr
  osmo_addr=$(hermes_cmd keys list --chain "$OSMO_CHAIN_ID" 2>/dev/null | grep -oE 'osmo1[a-z0-9]+' | head -1)
  if [[ -z "$osmo_addr" ]]; then
    die "could not determine Osmosis relayer address — run 'keys' step first"
  fi

  info "receiver on Osmosis: $osmo_addr"
  info "alice balance before:"
  ocpd_cmd query bank balances "$(ocpd_cmd keys show alice -a)" --output json 2>/dev/null || true

  ocpd_cmd tx ibc-transfer transfer transfer "$channel" "$osmo_addr" "${TRANSFER_AMOUNT}${DENOM}" \
    --from alice \
    --chain-id "$OCP_CHAIN_ID" \
    --fees "0${DENOM}" \
    --yes \
    --output json 2>/dev/null || warn "transfer tx may have failed (check manually)"

  ok "IBC transfer tx submitted"
  info "start the relayer to relay the packet: ./scripts/ibc-testnet.sh relay"
}

# ── Step 6: Start relayer ────────────────────────────────────────────

start_relay() {
  info "starting Hermes relayer (Ctrl-C to stop)..."
  info "the relayer will automatically pick up and relay pending packets"
  echo ""
  hermes_cmd start
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
  local cmd="${1:-full}"

  check_prereqs

  case "$cmd" in
    keys)
      wait_for_chain
      setup_keys
      ;;
    channel)
      wait_for_chain
      health_check
      create_channel
      ;;
    transfer)
      wait_for_chain
      test_transfer
      ;;
    relay)
      start_relay
      ;;
    health)
      health_check
      ;;
    full)
      wait_for_chain
      setup_keys
      echo ""
      read -rp "[ibc-testnet] Press Enter after funding the Osmosis relayer key (or Ctrl-C to abort)... "
      echo ""
      health_check
      create_channel
      test_transfer
      info ""
      info "IBC setup complete! Next steps:"
      info "  1. Start the relayer:  ./scripts/ibc-testnet.sh relay"
      info "  2. The relayer will relay the pending transfer packet"
      info "  3. Check Osmosis testnet balance for the IBC denom"
      ;;
    *)
      echo "Usage: $0 [keys|channel|transfer|relay|health|full]"
      exit 1
      ;;
  esac
}

main "$@"
