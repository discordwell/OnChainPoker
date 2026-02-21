#!/usr/bin/env bash
#
# production-genesis.sh — Generate the production genesis for onchainpoker-1.
#
# This script initializes a chain home directory with the final mainnet genesis.
# It is NOT idempotent: it will refuse to overwrite an existing genesis.
#
# Usage:
#   ./production-genesis.sh                     # interactive (prompts for passphrase)
#   OCPD_KEYRING_BACKEND=test ./production-genesis.sh  # non-interactive (test keyring)
#
# Environment overrides:
#   OCPD_HOME            chain home dir (default: ~/.ocpd)
#   OCPD_KEYRING_BACKEND keyring backend (default: os)
#   OCPD_MONIKER         validator moniker (default: hostname)
#   OCPD_BIN             path to ocpd binary (default: ../bin/ocpd)
#
set -euo pipefail

# ── Constants ──

CHAIN_ID="onchainpoker-1"

# Token allocation (in uocp = 10^-6 OCP).
# Total supply = 4,294,967,295 OCP = uint32 max (fits in a single cosmos Int).
#
# | Purpose                    | OCP           | uocp                    |
# |----------------------------|---------------|-------------------------|
# | Pool seeding (Osmosis)     | 3,865,470,565 | 3,865,470,565,000,000   |
# | Validator self-delegation  | 10,000,000    | 10,000,000,000,000      |
# | Operations reserve         | 419,496,730   | 419,496,730,000,000     |
# | Total                      | 4,294,967,295 | 4,294,967,295,000,000   |

POOL_UOCP="3865470565000000"
VALIDATOR_STAKE_UOCP="10000000000000"
OPS_RESERVE_UOCP="419496730000000"
TOTAL_UOCP="4294967295000000"

DENOM="uocp"
DISPLAY_DENOM="ocp"
DENOM_EXPONENT=6

MIN_GAS_PRICES="0.025${DENOM}"
TIMEOUT_COMMIT="6s"

# ── Paths ──

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OCPD_HOME="${OCPD_HOME:-$HOME/.ocpd}"
OCPD_MONIKER="${OCPD_MONIKER:-$(hostname -s)}"
OCPD_KEYRING_BACKEND="${OCPD_KEYRING_BACKEND:-os}"
OCPD="${OCPD_BIN:-$ROOT/bin/ocpd}"

# ── Helpers ──

log() { echo "[production-genesis] $*"; }
die() { echo "[production-genesis] ERROR: $*" >&2; exit 1; }

pick_python() {
  command -v python3 2>/dev/null && return 0
  command -v python  2>/dev/null && return 0
  return 1
}

runq() {
  local out
  if ! out="$("$@" 2>&1)"; then
    echo "$out" >&2
    return 1
  fi
}

has_genesis_group() {
  "$OCPD" genesis --help >/dev/null 2>&1
}

genesis_cmd() {
  if has_genesis_group; then
    "$OCPD" genesis "$@"
  else
    "$OCPD" "$@"
  fi
}

key_addr() {
  "$OCPD" keys show "$1" -a --home "$OCPD_HOME" --keyring-backend "$OCPD_KEYRING_BACKEND"
}

# ── Sanity checks ──

if [[ ! -x "$OCPD" ]]; then
  die "ocpd binary not found at $OCPD — build it first: (cd $ROOT && go build -o bin/ocpd ./cmd/ocpd)"
fi

if [[ -f "$OCPD_HOME/config/genesis.json" ]]; then
  die "genesis already exists at $OCPD_HOME/config/genesis.json — remove $OCPD_HOME to start fresh"
fi

# Verify total = sum of parts.
COMPUTED_TOTAL=$(( POOL_UOCP + VALIDATOR_STAKE_UOCP + OPS_RESERVE_UOCP ))
if [[ "$COMPUTED_TOTAL" != "$TOTAL_UOCP" ]]; then
  die "token allocation mismatch: $COMPUTED_TOTAL != $TOTAL_UOCP"
fi

# ── Init chain ──

log "initializing chain home at $OCPD_HOME"
runq "$OCPD" init "$OCPD_MONIKER" --chain-id "$CHAIN_ID" --home "$OCPD_HOME"

# ── Create keys ──

log "creating keys (keyring-backend=$OCPD_KEYRING_BACKEND)"
log "  You will be prompted for a passphrase if using the 'os' or 'file' backend."

for KEY_NAME in validator operator; do
  if "$OCPD" keys show "$KEY_NAME" --home "$OCPD_HOME" --keyring-backend "$OCPD_KEYRING_BACKEND" >/dev/null 2>&1; then
    log "  key '$KEY_NAME' already exists, skipping"
  else
    "$OCPD" keys add "$KEY_NAME" --home "$OCPD_HOME" --keyring-backend "$OCPD_KEYRING_BACKEND"
    log "  created key '$KEY_NAME'"
  fi
done

VALIDATOR_ADDR="$(key_addr validator)"
OPERATOR_ADDR="$(key_addr operator)"

log "  validator: $VALIDATOR_ADDR"
log "  operator:  $OPERATOR_ADDR"

# ── Fund genesis accounts ──

# Validator gets self-delegation stake + pool seeding tokens.
VALIDATOR_TOTAL_UOCP=$(( VALIDATOR_STAKE_UOCP + POOL_UOCP ))
log "funding validator account: ${VALIDATOR_TOTAL_UOCP}${DENOM}"
genesis_cmd add-genesis-account "$VALIDATOR_ADDR" "${VALIDATOR_TOTAL_UOCP}${DENOM}" --home "$OCPD_HOME"

# Operator gets the operations reserve.
log "funding operator account: ${OPS_RESERVE_UOCP}${DENOM}"
genesis_cmd add-genesis-account "$OPERATOR_ADDR" "${OPS_RESERVE_UOCP}${DENOM}" --home "$OCPD_HOME"

# ── Patch genesis JSON ──

GENESIS="$OCPD_HOME/config/genesis.json"
PY="$(pick_python)" || die "python3 or python required for genesis patching"

log "patching genesis: denom metadata, staking params"
"$PY" - "$GENESIS" <<'PYEOF'
import json, sys

path = sys.argv[1]
with open(path, "r") as f:
    g = json.load(f)

# Bank denom metadata.
g["app_state"]["bank"]["denom_metadata"] = [
    {
        "description": "The native staking and gas token of the OnChainPoker network.",
        "denom_units": [
            {"denom": "uocp", "exponent": 0, "aliases": ["microocp"]},
            {"denom": "mocp", "exponent": 3, "aliases": ["milliocp"]},
            {"denom": "ocp",  "exponent": 6, "aliases": []},
        ],
        "base": "uocp",
        "display": "ocp",
        "name": "OnChainPoker",
        "symbol": "OCP",
    }
]

# Ensure staking bond_denom is uocp.
g["app_state"]["staking"]["params"]["bond_denom"] = "uocp"

# Ensure mint is disabled (no inflation — fixed supply).
if "mint" in g["app_state"]:
    mint = g["app_state"]["mint"]
    if "minter" in mint:
        mint["minter"]["inflation"] = "0.000000000000000000"
        mint["minter"]["annual_provisions"] = "0.000000000000000000"
    if "params" in mint:
        mint["params"]["inflation_max"] = "0.000000000000000000"
        mint["params"]["inflation_min"] = "0.000000000000000000"
        mint["params"]["inflation_rate_change"] = "0.000000000000000000"
        mint["params"]["mint_denom"] = "uocp"

with open(path, "w") as f:
    json.dump(g, f, indent=2)
    f.write("\n")
PYEOF

# ── Gentx ──

log "generating gentx: ${VALIDATOR_STAKE_UOCP}${DENOM} self-delegation"
genesis_cmd gentx validator "${VALIDATOR_STAKE_UOCP}${DENOM}" \
  --chain-id "$CHAIN_ID" \
  --home "$OCPD_HOME" \
  --keyring-backend "$OCPD_KEYRING_BACKEND" \
  --moniker "$OCPD_MONIKER" \
  --commission-rate "0.05" \
  --commission-max-rate "0.20" \
  --commission-max-change-rate "0.01"

log "collecting gentxs"
genesis_cmd collect-gentxs --home "$OCPD_HOME"

# ── Patch config files ──

CONFIG_TOML="$OCPD_HOME/config/config.toml"
APP_TOML="$OCPD_HOME/config/app.toml"

log "patching config.toml: timeout_commit=${TIMEOUT_COMMIT}"
sed -i.bak -E "s/^timeout_commit = .*/timeout_commit = \"${TIMEOUT_COMMIT}\"/" "$CONFIG_TOML"
rm -f "$CONFIG_TOML.bak"

log "patching app.toml: minimum-gas-prices=${MIN_GAS_PRICES}"
sed -i.bak -E "s/^minimum-gas-prices = .*/minimum-gas-prices = \"${MIN_GAS_PRICES}\"/" "$APP_TOML"
rm -f "$APP_TOML.bak"

# Enable API (needed for coordinator/dealer-daemon LCD queries).
# macOS sed doesn't support range-in-braces, so use python for this patch.
"$PY" - "$APP_TOML" <<'PYEOF2'
import re, sys
path = sys.argv[1]
with open(path, "r") as f:
    content = f.read()
# Enable the first `enable = false` after `[api]`.
content = re.sub(
    r'(\[api\][^\[]*?)enable = false',
    r'\1enable = true',
    content,
    count=1,
    flags=re.DOTALL,
)
with open(path, "w") as f:
    f.write(content)
PYEOF2

# ── Validate ──

log "validating genesis"
genesis_cmd validate-genesis --home "$OCPD_HOME"

# ── Summary ──

GENESIS_HASH="$(shasum -a 256 "$GENESIS" | awk '{print $1}')"

echo ""
log "=== Production Genesis Ready ==="
log ""
log "  Chain ID:       $CHAIN_ID"
log "  Home:           $OCPD_HOME"
log "  Genesis:        $GENESIS"
log "  Genesis SHA256: $GENESIS_HASH"
log ""
log "  Validator addr: $VALIDATOR_ADDR"
log "  Operator addr:  $OPERATOR_ADDR"
log ""
log "  Total supply:   4,294,967,295 OCP ($TOTAL_UOCP uocp)"
log "    Pool seeding:       3,865,470,565 OCP (held by validator, IBC transfer to Osmosis)"
log "    Validator stake:    10,000,000 OCP (self-delegation)"
log "    Operations reserve: 419,496,730 OCP (held by operator)"
log ""
log "  Config:"
log "    timeout_commit:     $TIMEOUT_COMMIT"
log "    minimum-gas-prices: $MIN_GAS_PRICES"
log ""
log "  Next steps:"
log "    1. Back up key mnemonics from keyring"
log "    2. Copy $OCPD_HOME to VPS"
log "    3. Start node: ocpd start --home $OCPD_HOME"
log "    4. Verify blocks: curl http://localhost:26657/status"
log ""
