#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"

OCPD_HOME="${OCPD_HOME:-$ROOT/.ocpd}"
OCPD_CHAIN_ID="${OCPD_CHAIN_ID:-ocp-local-1}"
OCPD_MONIKER="${OCPD_MONIKER:-local}"
OCPD_KEYRING_BACKEND="${OCPD_KEYRING_BACKEND:-test}"
# Default validator self-delegation for gentx. Must be high enough that slashing
# does not drop the sole validator's power to 0 in single-node localnets.
OCPD_GENTX_STAKE="${OCPD_GENTX_STAKE:-10000000}" # in base denom units (e.g. uocp)

# Port overrides (useful when running multiple localnets side-by-side).
OCPD_RPC_LADDR="${OCPD_RPC_LADDR:-tcp://127.0.0.1:26657}"
OCPD_P2P_LADDR="${OCPD_P2P_LADDR:-tcp://0.0.0.0:26656}"
if [[ -n "${OCPD_GRPC_ADDR:-}" && -z "${OCPD_GRPC_ADDRESS:-}" ]]; then
  echo "[cosmos localnet] NOTE: OCPD_GRPC_ADDR is deprecated; use OCPD_GRPC_ADDRESS" >&2
  OCPD_GRPC_ADDRESS="$OCPD_GRPC_ADDR"
fi
OCPD_GRPC_ADDRESS="${OCPD_GRPC_ADDRESS:-127.0.0.1:9090}"
if [[ -n "${OCPD_API_ADDR:-}" && -z "${OCPD_API_ADDRESS:-}" ]]; then
  echo "[cosmos localnet] NOTE: OCPD_API_ADDR is deprecated; use OCPD_API_ADDRESS" >&2
  OCPD_API_ADDRESS="$OCPD_API_ADDR"
fi
OCPD_API_ADDRESS="${OCPD_API_ADDRESS:-tcp://127.0.0.1:1317}"
OCPD_PPROF_LADDR="${OCPD_PPROF_LADDR:-127.0.0.1:0}"

OCPD="$BIN_DIR/ocpd"

mkdir -p "$BIN_DIR"

pick_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    echo "python"
    return 0
  fi
  return 1
}

runq() {
  # Quiet on success; print captured output on error.
  local out
  if ! out="$("$@" 2>&1)"; then
    echo "$out" >&2
    return 1
  fi
}

build_ocpd() {
  if [[ -x "$OCPD" ]]; then
    return 0
  fi
  if ! command -v go >/dev/null 2>&1; then
    echo "[cosmos localnet] missing 'go' (install via Homebrew: brew install go)"
    exit 1
  fi
  if [[ ! -f "$ROOT/cmd/ocpd/main.go" ]]; then
    echo "[cosmos localnet] missing $ROOT/cmd/ocpd/main.go"
    echo "[cosmos localnet] Agent1 should implement the Cosmos SDK app + ocpd binary first."
    exit 1
  fi

  echo "[cosmos localnet] building ocpd..."
  (cd "$ROOT" && go build -o "$OCPD" ./cmd/ocpd)
}

has_genesis_group() {
  "$OCPD" genesis --help >/dev/null 2>&1
}

genesis_add_account() {
  local addr="$1"
  local coins="$2"
  if has_genesis_group; then
    runq "$OCPD" genesis add-genesis-account "$addr" "$coins" --home "$OCPD_HOME"
  else
    runq "$OCPD" add-genesis-account "$addr" "$coins" --home "$OCPD_HOME"
  fi
}

genesis_gentx() {
  local key_name="$1"
  local amount="$2"
  if has_genesis_group; then
    runq "$OCPD" genesis gentx "$key_name" "$amount" \
      --chain-id "$OCPD_CHAIN_ID" \
      --home "$OCPD_HOME" \
      --keyring-backend "$OCPD_KEYRING_BACKEND" \
      --moniker "$OCPD_MONIKER"
  else
    runq "$OCPD" gentx "$key_name" "$amount" \
      --chain-id "$OCPD_CHAIN_ID" \
      --home "$OCPD_HOME" \
      --keyring-backend "$OCPD_KEYRING_BACKEND" \
      --moniker "$OCPD_MONIKER"
  fi
}

genesis_collect_gentxs() {
  if has_genesis_group; then
    runq "$OCPD" genesis collect-gentxs --home "$OCPD_HOME"
  else
    runq "$OCPD" collect-gentxs --home "$OCPD_HOME"
  fi
}

genesis_validate() {
  if has_genesis_group; then
    runq "$OCPD" genesis validate-genesis --home "$OCPD_HOME"
  else
    runq "$OCPD" validate-genesis --home "$OCPD_HOME"
  fi
}

key_addr() {
  local name="$1"
  "$OCPD" keys show "$name" -a --home "$OCPD_HOME" --keyring-backend "$OCPD_KEYRING_BACKEND"
}

ensure_key() {
  local name="$1"
  if "$OCPD" keys show "$name" --home "$OCPD_HOME" --keyring-backend "$OCPD_KEYRING_BACKEND" >/dev/null 2>&1; then
    return 0
  fi
  runq "$OCPD" keys add "$name" --home "$OCPD_HOME" --keyring-backend "$OCPD_KEYRING_BACKEND"
}

detect_bond_denom() {
  if [[ -n "${OCPD_DENOM:-}" ]]; then
    echo "$OCPD_DENOM"
    return 0
  fi

  local genesis="$OCPD_HOME/config/genesis.json"
  if [[ ! -f "$genesis" ]]; then
    echo "stake"
    return 0
  fi

  local py
  py="$(pick_python)" || { echo "stake"; return 0; }

  "$py" - "$genesis" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
  g = json.load(f)

denom = None
try:
  denom = g["app_state"]["staking"]["params"]["bond_denom"]
except Exception:
  denom = None

print(denom or "stake")
PY
}

patch_min_gas_prices() {
  local denom="$1"
  local app_toml="$OCPD_HOME/config/app.toml"
  if [[ ! -f "$app_toml" ]]; then
    return 0
  fi
  # macOS sed requires a backup extension for -i.
  sed -i.bak -E "s/^minimum-gas-prices = .*/minimum-gas-prices = \"0.0${denom}\"/" "$app_toml" || true
  rm -f "$app_toml.bak" || true
}

patch_fast_blocks() {
  local cfg="$OCPD_HOME/config/config.toml"
  if [[ ! -f "$cfg" ]]; then
    return 0
  fi
  sed -i.bak -E 's/^timeout_commit = .*/timeout_commit = "1s"/' "$cfg" || true
  rm -f "$cfg.bak" || true
}

patch_client_toml() {
  local client_toml="$OCPD_HOME/config/client.toml"
  if [[ ! -f "$client_toml" ]]; then
    return 0
  fi
  # Make manual CLI usage sane (chain-id/node/keyring-backend default correctly).
  sed -i.bak -E "s/^chain-id = .*/chain-id = \"${OCPD_CHAIN_ID}\"/" "$client_toml" || true
  sed -i.bak -E "s/^keyring-backend = .*/keyring-backend = \"${OCPD_KEYRING_BACKEND}\"/" "$client_toml" || true
  # Use '|' to avoid escaping slashes in tcp://... values.
  sed -i.bak -E "s|^node = .*|node = \"${OCPD_RPC_LADDR}\"|" "$client_toml" || true
  rm -f "$client_toml.bak" || true
}

init_if_needed() {
  if [[ "${OCPD_RESET:-}" == "1" ]]; then
    echo "[cosmos localnet] reset requested (OCPD_RESET=1): wiping $OCPD_HOME"
    rm -rf "$OCPD_HOME"
  fi

  if [[ -f "$OCPD_HOME/config/genesis.json" ]]; then
    return 0
  fi

  echo "[cosmos localnet] init home: $OCPD_HOME"
  runq "$OCPD" init "$OCPD_MONIKER" --chain-id "$OCPD_CHAIN_ID" --home "$OCPD_HOME"

  local denom
  denom="$(detect_bond_denom)"

  patch_min_gas_prices "$denom"
  patch_fast_blocks
  patch_client_toml

  # Deterministic local test keys (stored in keyring-backend=test under OCPD_HOME).
  ensure_key "validator"
  ensure_key "faucet"
  ensure_key "alice"
  ensure_key "bob"

  local v_addr f_addr a_addr b_addr
  v_addr="$(key_addr validator)"
  f_addr="$(key_addr faucet)"
  a_addr="$(key_addr alice)"
  b_addr="$(key_addr bob)"

  echo "[cosmos localnet] bond denom: $denom"
  echo "[cosmos localnet] add genesis accounts..."
  genesis_add_account "$v_addr" "1000000000${denom}"
  genesis_add_account "$f_addr" "1000000000000${denom}"
  genesis_add_account "$a_addr" "100000000${denom}"
  genesis_add_account "$b_addr" "100000000${denom}"

  echo "[cosmos localnet] generate gentx..."
  genesis_gentx "validator" "${OCPD_GENTX_STAKE}${denom}"

  echo "[cosmos localnet] collect gentxs + validate genesis..."
  genesis_collect_gentxs
  genesis_validate
}

build_ocpd
init_if_needed

DENOM="$(detect_bond_denom)"

echo ""
echo "[cosmos localnet] chain-id: $OCPD_CHAIN_ID"
echo "[cosmos localnet] denom:    $DENOM"
echo "[cosmos localnet] home:     $OCPD_HOME"
echo "[cosmos localnet] addrs:"
echo "  validator: $(key_addr validator)"
echo "  faucet:    $(key_addr faucet)"
echo "  alice:     $(key_addr alice)"
echo "  bob:       $(key_addr bob)"
echo ""
echo "[cosmos localnet] RPC:  $OCPD_RPC_LADDR"
echo "[cosmos localnet] P2P:  $OCPD_P2P_LADDR"
echo "[cosmos localnet] gRPC: $OCPD_GRPC_ADDRESS"
echo "[cosmos localnet] API:  $OCPD_API_ADDRESS"
echo "[cosmos localnet] Ctrl-C to stop"
echo ""

if [[ "${OCPD_NO_START:-}" == "1" ]]; then
  exit 0
fi

exec "$OCPD" start \
  --home "$OCPD_HOME" \
  --rpc.laddr "$OCPD_RPC_LADDR" \
  --p2p.laddr "$OCPD_P2P_LADDR" \
  --grpc.address "$OCPD_GRPC_ADDRESS" \
  --api.enable \
  --api.address "$OCPD_API_ADDRESS" \
  --rpc.pprof_laddr "$OCPD_PPROF_LADDR"
