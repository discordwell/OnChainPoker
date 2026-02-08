#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin"

OCP_HOME="${OCP_HOME:-$ROOT/.ocp}"
COMET_HOME="$OCP_HOME/cometbft"

ABCI_ADDR="${OCP_ABCI_ADDR:-tcp://127.0.0.1:26658}"

mkdir -p "$BIN" "$OCP_HOME"

if ! command -v go >/dev/null 2>&1; then
  echo "[localnet] missing 'go' (install via: brew install go)"
  exit 1
fi

build_tools() {
  if [[ ! -x "$BIN/cometbft" ]]; then
    echo "[localnet] building cometbft..."
    GOBIN="$BIN" go install github.com/cometbft/cometbft/cmd/cometbft@v1.0.1
  fi
  if [[ ! -x "$BIN/ocpd" ]]; then
    echo "[localnet] building ocpd..."
    (cd "$ROOT" && go build -o "$BIN/ocpd" ./cmd/ocpd)
  fi
}

init_comet() {
  if [[ ! -d "$COMET_HOME/config" ]]; then
    echo "[localnet] init cometbft home at $COMET_HOME"
    "$BIN/cometbft" init --home "$COMET_HOME" >/dev/null
  fi
}

cleanup() {
  if [[ -f "$OCP_HOME/cometbft.pid" ]]; then
    kill "$(cat "$OCP_HOME/cometbft.pid")" >/dev/null 2>&1 || true
    rm -f "$OCP_HOME/cometbft.pid"
  fi
  if [[ -f "$OCP_HOME/ocpd.pid" ]]; then
    kill "$(cat "$OCP_HOME/ocpd.pid")" >/dev/null 2>&1 || true
    rm -f "$OCP_HOME/ocpd.pid"
  fi
}

trap cleanup EXIT INT TERM

build_tools
init_comet

echo "[localnet] starting ocpd (ABCI: $ABCI_ADDR)"
"$BIN/ocpd" --home "$OCP_HOME" --addr "$ABCI_ADDR" >"$OCP_HOME/ocpd.log" 2>&1 &
echo $! >"$OCP_HOME/ocpd.pid"

echo "[localnet] starting cometbft (RPC: http://127.0.0.1:26657)"
"$BIN/cometbft" node --home "$COMET_HOME" --proxy_app "$ABCI_ADDR" >"$OCP_HOME/cometbft.log" 2>&1 &
echo $! >"$OCP_HOME/cometbft.pid"

echo "[localnet] logs: $OCP_HOME/cometbft.log"
echo "[localnet] Ctrl-C to stop"
tail -f "$OCP_HOME/cometbft.log"
