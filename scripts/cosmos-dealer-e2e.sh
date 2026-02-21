#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Use isolated default ports so local single-node devnets on 26657/1317 do not
# interfere with multinet e2e runs.
export COSMOS_RPC_URL="${COSMOS_RPC_URL:-http://127.0.0.1:27657}"
export COSMOS_LCD_URL="${COSMOS_LCD_URL:-http://127.0.0.1:1417}"
export COSMOS_OCPD_NUM_NODES="${COSMOS_OCPD_NUM_NODES:-${OCPD_NUM_NODES:-3}}"

rpc_port="$(echo "$COSMOS_RPC_URL" | sed -nE 's#^https?://[^:/]+:([0-9]+).*$#\1#p')"
lcd_port="$(echo "$COSMOS_LCD_URL" | sed -nE 's#^https?://[^:/]+:([0-9]+).*$#\1#p')"
if [[ -z "$rpc_port" || -z "$lcd_port" ]]; then
  echo "[cosmos-dealer-e2e] invalid COSMOS_RPC_URL or COSMOS_LCD_URL"
  echo "[cosmos-dealer-e2e] COSMOS_RPC_URL=$COSMOS_RPC_URL"
  echo "[cosmos-dealer-e2e] COSMOS_LCD_URL=$COSMOS_LCD_URL"
  exit 1
fi

export OCPD_NUM_NODES="${COSMOS_OCPD_NUM_NODES}"
export OCPD_MULTI_HOME="${OCPD_MULTI_HOME:-${RUNNER_TEMP:-$ROOT/.tmp}/ocpd-multivalidator}"
export OCPD_KEYRING_BACKEND="${OCPD_KEYRING_BACKEND:-test}"
export OCPD_BIN="${OCPD_BIN:-$ROOT/apps/cosmos/bin/ocpd}"
export OCPD_NODE="${OCPD_NODE:-$(echo "$COSMOS_RPC_URL" | sed 's#^https\?://#tcp://#')}"
export OCPD_RPC_PORT_BASE="${OCPD_RPC_PORT_BASE:-$rpc_port}"
export OCPD_P2P_PORT_BASE="${OCPD_P2P_PORT_BASE:-$((rpc_port - 1))}"
export OCPD_GRPC_PORT_BASE="${OCPD_GRPC_PORT_BASE:-$((rpc_port - 17567))}"
export OCPD_API_PORT_BASE="${OCPD_API_PORT_BASE:-$lcd_port}"

# Keep each invocation isolated and deterministic.
export OCPD_RESET="${OCPD_RESET:-1}"

RUNTIME_ROOT="${RUNNER_TEMP:-$ROOT/.tmp}"
mkdir -p "$RUNTIME_ROOT"
MULTINET_LOG="$RUNTIME_ROOT/cosmos-multinet.log"

if [[ "$OCPD_RESET" == "1" ]]; then
  rm -rf "$OCPD_MULTI_HOME"
fi

cleanup() {
  if [[ -n "${MULTINET_PID:-}" ]] && kill -0 "$MULTINET_PID" >/dev/null 2>&1; then
    kill "$MULTINET_PID" >/dev/null 2>&1 || true
    wait "$MULTINET_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

echo "[cosmos-dealer-e2e] starting ${COSMOS_OCPD_NUM_NODES}-node multinet at ${OCPD_MULTI_HOME}"
OCPD_NO_TAIL=1 bash apps/cosmos/scripts/multinet.sh >"$MULTINET_LOG" 2>&1 &
MULTINET_PID=$!

ready=0
for _ in $(seq 1 180); do
  if curl -fsS "$COSMOS_RPC_URL/status" >/dev/null 2>&1 && curl -fsS "$COSMOS_LCD_URL/cosmos/base/tendermint/v1beta1/node_info" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  echo "[cosmos-dealer-e2e] network did not become ready"
  tail -n 200 "$MULTINET_LOG" || true
  exit 1
fi

echo "[cosmos-dealer-e2e] building JS packages"
pnpm -C packages/ocp-crypto build
pnpm -C packages/ocp-shuffle build
pnpm sdk:build

echo "[cosmos-dealer-e2e] running confidential dealer e2e"
if command -v timeout >/dev/null 2>&1; then
  e2e_cmd=(timeout 900s env COSMOS_OCPD_NUM_NODES="$COSMOS_OCPD_NUM_NODES" pnpm ws7:play_hand_cosmos)
elif command -v gtimeout >/dev/null 2>&1; then
  e2e_cmd=(gtimeout 900s env COSMOS_OCPD_NUM_NODES="$COSMOS_OCPD_NUM_NODES" pnpm ws7:play_hand_cosmos)
else
  echo "[cosmos-dealer-e2e] warning: no timeout/gtimeout found; running without command timeout"
  e2e_cmd=(env COSMOS_OCPD_NUM_NODES="$COSMOS_OCPD_NUM_NODES" pnpm ws7:play_hand_cosmos)
fi

if ! "${e2e_cmd[@]}"; then
  echo "[cosmos-dealer-e2e] e2e run failed"
  tail -n 200 "$MULTINET_LOG" || true
  exit 1
fi

echo "[cosmos-dealer-e2e] completed"
