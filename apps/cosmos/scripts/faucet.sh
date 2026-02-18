#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"

OCPD_HOME="${OCPD_HOME:-$ROOT/.ocpd}"
OCPD_CHAIN_ID="${OCPD_CHAIN_ID:-ocp-local-1}"
OCPD_KEYRING_BACKEND="${OCPD_KEYRING_BACKEND:-test}"
OCPD_NODE="${OCPD_NODE:-tcp://127.0.0.1:26657}"
OCPD_FAUCET_KEY="${OCPD_FAUCET_KEY:-faucet}"
OCPD_BROADCAST_MODE="${OCPD_BROADCAST_MODE:-sync}"
OCPD_WAIT="${OCPD_WAIT:-1}"
OCPD_RETRY="${OCPD_RETRY:-1}"
OCPD_STRICT_WAIT="${OCPD_STRICT_WAIT:-0}"

OCPD="$BIN_DIR/ocpd"

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

usage() {
  cat <<EOF
Usage:
  $0 <to_bech32_addr> [amount]

Env:
  OCPD_HOME              (default: apps/cosmos/.ocpd)
  OCPD_CHAIN_ID          (default: ocp-local-1)
  OCPD_NODE              (default: tcp://127.0.0.1:26657)
  OCPD_BROADCAST_MODE    (default: sync; use block for sequence-safe serial sends)
  OCPD_DENOM             (default: auto-detected from genesis)
  OCPD_KEYRING_BACKEND   (default: test)
  OCPD_FAUCET_KEY         (default: faucet)
  OCPD_FEES              (default: 0<denom>)
  OCPD_WAIT              (default: 1; poll until tx is indexed)

Examples:
  $0 ocp1... 1000000
EOF
}

TO="${1:-}"
AMOUNT="${2:-1000000}"

if [[ -z "$TO" ]]; then
  usage
  exit 1
fi

if ! command -v "$OCPD" >/dev/null 2>&1 && [[ ! -x "$OCPD" ]]; then
  echo "[faucet] missing ocpd at $OCPD"
  echo "[faucet] start localnet first (it builds ocpd) or set OCPD to a built binary."
  exit 1
fi

DENOM="$(detect_bond_denom)"
FEES="${OCPD_FEES:-0${DENOM}}"

echo "[faucet] sending ${AMOUNT}${DENOM} -> $TO"
TX_OUT=""
TX_CODE=1
for attempt in {1..40}; do
  set +e
  TX_OUT="$("$OCPD" tx bank send "$OCPD_FAUCET_KEY" "$TO" "${AMOUNT}${DENOM}" \
    --yes \
    --broadcast-mode "$OCPD_BROADCAST_MODE" \
    --chain-id "$OCPD_CHAIN_ID" \
    --node "$OCPD_NODE" \
    --home "$OCPD_HOME" \
    --keyring-backend "$OCPD_KEYRING_BACKEND" \
    --fees "$FEES" \
    --gas auto \
    --gas-adjustment 1.3 \
    --output json 2>&1)"
  TX_CODE=$?
  set -e

  if [[ "$TX_CODE" == "0" ]]; then
    break
  fi

  if [[ "$OCPD_RETRY" == "1" ]] && echo "$TX_OUT" | grep -Eiq "invalid height|not ready|gas wanted -1 is negative|account sequence mismatch|incorrect account sequence"; then
    sleep 0.5
    continue
  fi

  break
done

echo "$TX_OUT"
if [[ "$TX_CODE" != "0" ]]; then
  exit "$TX_CODE"
fi

if [[ "$OCPD_WAIT" == "0" ]]; then
  exit 0
fi

TX_JSON="$(echo "$TX_OUT" | awk 'NF{last=$0} END{print last}')"

PYBIN="$(pick_python || true)"
if [[ -n "$PYBIN" ]]; then
  TXHASH="$("$PYBIN" -c 'import json,sys; print(json.loads(sys.stdin.read()).get("txhash",""))' <<<"$TX_JSON")"
else
  # Fallback: extremely small JSON extraction without requiring python.
  TXHASH="$(echo "$TX_JSON" | sed -n 's/.*"txhash"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"
fi

if [[ -z "$TXHASH" ]]; then
  echo "[faucet] failed to parse txhash from tx output" >&2
  exit 1
fi

# Wait for Comet to index the tx so balance queries see it.
RPC_HTTP="${OCPD_NODE/tcp:\\/\\//http://}"
for _ in {1..120}; do
  if curl -sf "${RPC_HTTP}/tx?hash=0x${TXHASH}" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.5
done

echo "[faucet] tx not indexed yet: $TXHASH" >&2
if [[ "$OCPD_STRICT_WAIT" == "1" ]]; then
  exit 1
fi
exit 0
