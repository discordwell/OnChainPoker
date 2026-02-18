#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"

OCPD_MULTI_HOME="${OCPD_MULTI_HOME:-$ROOT/.ocpd-multi}"
OCPD_CHAIN_ID="${OCPD_CHAIN_ID:-ocp-local-1}"
OCPD_KEYRING_BACKEND="${OCPD_KEYRING_BACKEND:-test}"
OCPD_MONIKER_PREFIX="${OCPD_MONIKER_PREFIX:-ocp}"
OCPD_NUM_NODES="${OCPD_NUM_NODES:-4}"
# Validator self-delegation for gentx (base denom units). Keep this high enough
# that slashing fractions don't trivially drop validators to 0 voting power in devnets.
OCPD_GENTX_STAKE="${OCPD_GENTX_STAKE:-10000000}"

# Base ports for node0; other nodes use +i*OCPD_PORT_STEP.
OCPD_PORT_STEP="${OCPD_PORT_STEP:-10}"
OCPD_P2P_PORT_BASE="${OCPD_P2P_PORT_BASE:-26656}"
OCPD_RPC_PORT_BASE="${OCPD_RPC_PORT_BASE:-26657}"
OCPD_GRPC_PORT_BASE="${OCPD_GRPC_PORT_BASE:-9090}"
OCPD_API_PORT_BASE="${OCPD_API_PORT_BASE:-1317}"

OCPD_DENOM="${OCPD_DENOM:-}" # optional; auto-detected from genesis if unset

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
    echo "[cosmos multinet] missing 'go' (install via Homebrew: brew install go)"
    exit 1
  fi
  if [[ ! -f "$ROOT/cmd/ocpd/main.go" ]]; then
    echo "[cosmos multinet] missing $ROOT/cmd/ocpd/main.go"
    echo "[cosmos multinet] Agent1 should implement the Cosmos SDK app + ocpd binary first."
    exit 1
  fi

  echo "[cosmos multinet] building ocpd..."
  (cd "$ROOT" && go build -o "$OCPD" ./cmd/ocpd)
}

has_genesis_group() {
  "$OCPD" genesis --help >/dev/null 2>&1
}

genesis_add_account() {
  local home="$1"
  local addr="$2"
  local coins="$3"
  if has_genesis_group; then
    runq "$OCPD" genesis add-genesis-account "$addr" "$coins" --home "$home"
  else
    runq "$OCPD" add-genesis-account "$addr" "$coins" --home "$home"
  fi
}

genesis_gentx() {
  local home="$1"
  local key_name="$2"
  local amount="$3"
  local moniker="$4"
  if has_genesis_group; then
    runq "$OCPD" genesis gentx "$key_name" "$amount" \
      --chain-id "$OCPD_CHAIN_ID" \
      --home "$home" \
      --keyring-backend "$OCPD_KEYRING_BACKEND" \
      --moniker "$moniker"
  else
    runq "$OCPD" gentx "$key_name" "$amount" \
      --chain-id "$OCPD_CHAIN_ID" \
      --home "$home" \
      --keyring-backend "$OCPD_KEYRING_BACKEND" \
      --moniker "$moniker"
  fi
}

genesis_collect_gentxs() {
  local home="$1"
  if has_genesis_group; then
    runq "$OCPD" genesis collect-gentxs --home "$home"
  else
    runq "$OCPD" collect-gentxs --home "$home"
  fi
}

genesis_validate() {
  local home="$1"
  if has_genesis_group; then
    runq "$OCPD" genesis validate-genesis --home "$home"
  else
    runq "$OCPD" validate-genesis --home "$home"
  fi
}

key_addr() {
  local home="$1"
  local name="$2"
  "$OCPD" keys show "$name" -a --home "$home" --keyring-backend "$OCPD_KEYRING_BACKEND"
}

ensure_key() {
  local home="$1"
  local name="$2"
  if "$OCPD" keys show "$name" --home "$home" --keyring-backend "$OCPD_KEYRING_BACKEND" >/dev/null 2>&1; then
    return 0
  fi
  runq "$OCPD" keys add "$name" --home "$home" --keyring-backend "$OCPD_KEYRING_BACKEND"
}

detect_bond_denom() {
  local home="$1"
  if [[ -n "$OCPD_DENOM" ]]; then
    echo "$OCPD_DENOM"
    return 0
  fi

  local genesis="$home/config/genesis.json"
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
  local home="$1"
  local denom="$2"
  local app_toml="$home/config/app.toml"
  if [[ ! -f "$app_toml" ]]; then
    return 0
  fi
  sed -i.bak -E "s/^minimum-gas-prices = .*/minimum-gas-prices = \"0.0${denom}\"/" "$app_toml" || true
  rm -f "$app_toml.bak" || true
}

patch_fast_blocks_and_local_p2p() {
  local home="$1"
  local cfg="$home/config/config.toml"
  if [[ ! -f "$cfg" ]]; then
    return 0
  fi
  sed -i.bak -E 's/^timeout_commit = .*/timeout_commit = "1s"/' "$cfg" || true
  # Needed for multiple nodes on localhost.
  sed -i.bak -E 's/^addr_book_strict = .*/addr_book_strict = false/' "$cfg" || true
  sed -i.bak -E 's/^allow_duplicate_ip = .*/allow_duplicate_ip = true/' "$cfg" || true
  rm -f "$cfg.bak" || true
}

patch_client_toml() {
  local home="$1"
  local rpc_port="$2"
  local client_toml="$home/config/client.toml"
  if [[ ! -f "$client_toml" ]]; then
    return 0
  fi
  sed -i.bak -E "s/^chain-id = .*/chain-id = \"${OCPD_CHAIN_ID}\"/" "$client_toml" || true
  sed -i.bak -E "s/^keyring-backend = .*/keyring-backend = \"${OCPD_KEYRING_BACKEND}\"/" "$client_toml" || true
  sed -i.bak -E "s|^node = .*|node = \"tcp://127.0.0.1:${rpc_port}\"|" "$client_toml" || true
  rm -f "$client_toml.bak" || true
}

node_home() {
  local i="$1"
  echo "$OCPD_MULTI_HOME/node${i}"
}

init_node_if_needed() {
  local i="$1"
  local home
  home="$(node_home "$i")"

  if [[ -f "$home/config/genesis.json" ]]; then
    return 0
  fi

  mkdir -p "$home"
  local moniker="${OCPD_MONIKER_PREFIX}${i}"
  echo "[cosmos multinet] init node${i}: $home (moniker=$moniker)"
  runq "$OCPD" init "$moniker" --chain-id "$OCPD_CHAIN_ID" --home "$home"

  patch_fast_blocks_and_local_p2p "$home"
  ensure_key "$home" "validator"
}

reset_if_requested() {
  if [[ "${OCPD_RESET:-}" == "1" ]]; then
    echo "[cosmos multinet] reset requested (OCPD_RESET=1): wiping $OCPD_MULTI_HOME"
    rm -rf "$OCPD_MULTI_HOME"
  fi
}

genesis_setup_if_needed() {
  local marker="$OCPD_MULTI_HOME/.genesis_ready"
  if [[ -f "$marker" ]]; then
    return 0
  fi

  local home0
  home0="$(node_home 0)"
  local denom
  denom="$(detect_bond_denom "$home0")"

  echo "[cosmos multinet] bond denom: $denom"

  # Ensure shared test keys exist (node0 keyring).
  ensure_key "$home0" "faucet"
  ensure_key "$home0" "alice"
  ensure_key "$home0" "bob"

  local faucet_addr alice_addr bob_addr
  faucet_addr="$(key_addr "$home0" faucet)"
  alice_addr="$(key_addr "$home0" alice)"
  bob_addr="$(key_addr "$home0" bob)"

  echo "[cosmos multinet] add genesis accounts..."
  # Fund validators (their keys live in each node home).
  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    local hi vi
    hi="$(node_home "$i")"
    vi="$(key_addr "$hi" validator)"
    genesis_add_account "$home0" "$vi" "1000000000${denom}"
  done
  genesis_add_account "$home0" "$faucet_addr" "1000000000000${denom}"
  genesis_add_account "$home0" "$alice_addr" "100000000${denom}"
  genesis_add_account "$home0" "$bob_addr" "100000000${denom}"

  # All nodes need the same pre-gentx genesis so `gentx` can validate accounts.
  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    local hi
    hi="$(node_home "$i")"
    if [[ "$hi" != "$home0" ]]; then
      cp "$home0/config/genesis.json" "$hi/config/genesis.json"
    fi
  done

  # Clear gentx dirs for determinism.
  rm -rf "$home0/config/gentx"
  mkdir -p "$home0/config/gentx"

  echo "[cosmos multinet] generate gentxs..."
  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    local hi moniker
    hi="$(node_home "$i")"
    moniker="${OCPD_MONIKER_PREFIX}${i}"
    rm -rf "$hi/config/gentx"
    mkdir -p "$hi/config/gentx"
    genesis_gentx "$hi" "validator" "${OCPD_GENTX_STAKE}${denom}" "$moniker"

    # Copy gentx into node0 for collect-gentxs.
    if [[ "$hi" != "$home0" ]]; then
      shopt -s nullglob
      for f in "$hi/config/gentx"/*.json; do
        cp "$f" "$home0/config/gentx/"
      done
      shopt -u nullglob
    fi
  done

  echo "[cosmos multinet] collect gentxs + validate genesis..."
  genesis_collect_gentxs "$home0"
  genesis_validate "$home0"

  # Propagate final genesis to all nodes.
  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    local hi
    hi="$(node_home "$i")"
    if [[ "$hi" != "$home0" ]]; then
      cp "$home0/config/genesis.json" "$hi/config/genesis.json"
    fi
  done

  # Patch app.toml now that we know the denom.
  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    patch_min_gas_prices "$(node_home "$i")" "$denom"
  done

  # Patch node0 client.toml to point at node0 RPC and defaults.
  patch_client_toml "$home0" "$OCPD_RPC_PORT_BASE"

  touch "$marker"
}

start_nodes() {
  local home0 node0_id peers
  home0="$(node_home 0)"
  node0_id="$("$OCPD" tendermint show-node-id --home "$home0")"
  peers="${node0_id}@127.0.0.1:${OCPD_P2P_PORT_BASE}"

  local -a pids=()
  local -a logs=()

  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    local hi rpc_port p2p_port grpc_port log api_flags peer_flags
    hi="$(node_home "$i")"
    rpc_port=$((OCPD_RPC_PORT_BASE + i * OCPD_PORT_STEP))
    p2p_port=$((OCPD_P2P_PORT_BASE + i * OCPD_PORT_STEP))
    grpc_port=$((OCPD_GRPC_PORT_BASE + i * OCPD_PORT_STEP))
    log="$hi/ocpd.log"

    api_flags=()
    if [[ "$i" == "0" ]]; then
      api_flags=(--api.enable --api.address "tcp://127.0.0.1:${OCPD_API_PORT_BASE}")
    fi

    peer_flags=()
    if [[ "$i" != "0" ]]; then
      peer_flags=(--p2p.persistent_peers "$peers")
    fi

    echo "[cosmos multinet] starting node${i} (rpc=127.0.0.1:${rpc_port} p2p=127.0.0.1:${p2p_port} grpc=127.0.0.1:${grpc_port})"
    "$OCPD" start \
      --home "$hi" \
      --rpc.laddr "tcp://127.0.0.1:${rpc_port}" \
      --p2p.laddr "tcp://127.0.0.1:${p2p_port}" \
      --grpc.address "127.0.0.1:${grpc_port}" \
      --rpc.pprof_laddr "127.0.0.1:0" \
      ${api_flags[@]+"${api_flags[@]}"} \
      ${peer_flags[@]+"${peer_flags[@]}"} \
      >"$log" 2>&1 &

    pids+=("$!")
    logs+=("$log")
  done

  cleanup() {
    for pid in "${pids[@]:-}"; do
      kill "$pid" >/dev/null 2>&1 || true
    done
  }
  trap cleanup EXIT INT TERM

  echo ""
  echo "[cosmos multinet] chain-id: $OCPD_CHAIN_ID"
  echo "[cosmos multinet] home:     $OCPD_MULTI_HOME"
  echo "[cosmos multinet] node0 endpoints:"
  echo "  RPC:  http://127.0.0.1:${OCPD_RPC_PORT_BASE}"
  echo "  gRPC: 127.0.0.1:${OCPD_GRPC_PORT_BASE}"
  echo "  API:  http://127.0.0.1:${OCPD_API_PORT_BASE}"
  echo ""
  echo "[cosmos multinet] logs:"
  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    echo "  node${i}: $(node_home "$i")/ocpd.log"
  done
  echo ""
  echo "[cosmos multinet] Ctrl-C to stop"
  echo ""

  if [[ "${OCPD_NO_TAIL:-}" == "1" ]]; then
    wait
    exit 0
  fi

  # Tail node0 log by default.
  tail -f "${logs[0]}"
}

main() {
  build_ocpd
  reset_if_requested

  if [[ "$OCPD_NUM_NODES" -lt 1 ]]; then
    echo "[cosmos multinet] OCPD_NUM_NODES must be >= 1" >&2
    exit 1
  fi

  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    init_node_if_needed "$i"
  done

  # Patch min gas prices for nodes even if genesis already exists (idempotent).
  local denom
  denom="$(detect_bond_denom "$(node_home 0)")"
  for ((i=0; i< OCPD_NUM_NODES; i++)); do
    patch_min_gas_prices "$(node_home "$i")" "$denom"
  done
  patch_client_toml "$(node_home 0)" "$OCPD_RPC_PORT_BASE"

  genesis_setup_if_needed

  if [[ "${OCPD_NO_START:-}" == "1" ]]; then
    echo "[cosmos multinet] init complete (OCPD_NO_START=1)."
    exit 0
  fi

  start_nodes
}

main "$@"
