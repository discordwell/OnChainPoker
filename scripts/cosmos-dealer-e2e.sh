#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export COSMOS_RPC_URL="${COSMOS_RPC_URL:-http://127.0.0.1:26657}"
export COSMOS_LCD_URL="${COSMOS_LCD_URL:-http://127.0.0.1:1317}"
export COSMOS_OCPD_NUM_NODES="${COSMOS_OCPD_NUM_NODES:-${OCPD_NUM_NODES:-3}}"

export OCPD_NUM_NODES="${COSMOS_OCPD_NUM_NODES}"
export OCPD_MULTI_HOME="${OCPD_MULTI_HOME:-${RUNNER_TEMP:-$ROOT/.tmp}/ocpd-multivalidator}"
export OCPD_KEYRING_BACKEND="${OCPD_KEYRING_BACKEND:-test}"
export OCPD_BIN="${OCPD_BIN:-$ROOT/apps/cosmos/bin/ocpd}"
export OCPD_NODE="${OCPD_NODE:-$(echo "$COSMOS_RPC_URL" | sed 's#^https\?://#tcp://#')}"

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
if ! timeout 900s COSMOS_OCPD_NUM_NODES="$COSMOS_OCPD_NUM_NODES" pnpm ws7:play_hand_cosmos; then
  echo "[cosmos-dealer-e2e] e2e run failed"
  tail -n 200 "$MULTINET_LOG" || true
  exit 1
fi

echo "[cosmos-dealer-e2e] completed"
