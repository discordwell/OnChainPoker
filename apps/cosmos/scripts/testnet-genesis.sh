#!/usr/bin/env bash
#
# testnet-genesis.sh — Generate genesis for public testnet (onchainpoker-1).
#
# Creates keys: validator, faucet, bot-0, bot-1, bot-2
# Pre-seeds a poker table (id=1).
# Saves mnemonics to $OCPD_HOME/keys/<name>.mnemonic (mode 0600).
#
# Usage:
#   OCPD_HOME=/opt/ocp/chain/node0 OCPD_BIN=/opt/ocp/bin/ocpd bash testnet-genesis.sh
#
# Environment overrides:
#   OCPD_HOME            chain home dir (default: ~/.ocpd)
#   OCPD_BIN             path to ocpd binary (default: ../bin/ocpd)
#   OCPD_MONIKER         validator moniker (default: hostname)
#   OCPD_KEYRING_BACKEND keyring backend (default: test)
#
set -euo pipefail

# ── Constants ──

CHAIN_ID="onchainpoker-testnet-1"
DENOM="utchips"

# Token allocation (in utchips = 10^-6 TCHIPS)
#
# | Purpose              | TCHIPS      | utchips              |
# |----------------------|-------------|----------------------|
# | Validator            | 10,000      | 10,000,000,000       |
# | Faucet               | 100,000,000 | 100,000,000,000,000  |
# | Bot-0                | 1,000,000   | 1,000,000,000,000    |
# | Bot-1                | 1,000,000   | 1,000,000,000,000    |
# | Bot-2                | 1,000,000   | 1,000,000,000,000    |

VALIDATOR_UCHIPS="10000000000"
FAUCET_UCHIPS="100000000000000"
BOT_UCHIPS="1000000000000"
GENTX_STAKE="${VALIDATOR_UCHIPS}"

MIN_GAS_PRICES="0${DENOM}"
TIMEOUT_COMMIT="6s"

# ── Paths ──

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OCPD_HOME="${OCPD_HOME:-${HOME:?HOME must be set}/.ocpd}"
OCPD_MONIKER="${OCPD_MONIKER:-$(hostname -s)}"
OCPD_KEYRING_BACKEND="${OCPD_KEYRING_BACKEND:-test}"
OCPD="${OCPD_BIN:-$ROOT/bin/ocpd}"

# ── Helpers ──

log() { echo "[testnet-genesis] $*"; }
die() { echo "[testnet-genesis] ERROR: $*" >&2; exit 1; }

pick_python() {
  if command -v python3 >/dev/null 2>&1; then echo "python3"; return 0; fi
  if command -v python >/dev/null 2>&1; then echo "python"; return 0; fi
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

create_key_secure() {
  local name="$1"
  local keys_dir="$OCPD_HOME/keys"
  mkdir -p "$keys_dir"
  chmod 700 "$keys_dir"

  if "$OCPD" keys show "$name" --home "$OCPD_HOME" --keyring-backend "$OCPD_KEYRING_BACKEND" >/dev/null 2>&1; then
    log "  key '$name' already exists, skipping"
    return 0
  fi

  local output
  output="$("$OCPD" keys add "$name" --home "$OCPD_HOME" --keyring-backend "$OCPD_KEYRING_BACKEND" 2>&1)"

  local mnemonic
  mnemonic="$(echo "$output" | tail -1)"

  local mnemonic_file="$keys_dir/${name}.mnemonic"
  echo "$mnemonic" > "$mnemonic_file"
  chmod 600 "$mnemonic_file"

  echo "$output" | sed '$d' >&2
  log "  created key '$name' — mnemonic saved to $mnemonic_file"
}

# ── Sanity checks ──

if [[ ! -x "$OCPD" ]]; then
  die "ocpd binary not found at $OCPD"
fi

if [[ -f "$OCPD_HOME/config/genesis.json" ]]; then
  die "genesis already exists at $OCPD_HOME/config/genesis.json — remove $OCPD_HOME to start fresh"
fi

PY="$(pick_python)" || die "python3 or python required for genesis patching"

# ── Init chain ──

log "initializing chain home at $OCPD_HOME"
runq "$OCPD" init "$OCPD_MONIKER" --chain-id "$CHAIN_ID" --home "$OCPD_HOME"

# ── Create keys ──

log "creating keys (keyring-backend=$OCPD_KEYRING_BACKEND)"

for KEY_NAME in validator faucet bot-0 bot-1 bot-2; do
  create_key_secure "$KEY_NAME"
done

VALIDATOR_ADDR="$(key_addr validator)"
FAUCET_ADDR="$(key_addr faucet)"
BOT0_ADDR="$(key_addr bot-0)"
BOT1_ADDR="$(key_addr bot-1)"
BOT2_ADDR="$(key_addr bot-2)"

log "  validator: $VALIDATOR_ADDR"
log "  faucet:    $FAUCET_ADDR"
log "  bot-0:     $BOT0_ADDR"
log "  bot-1:     $BOT1_ADDR"
log "  bot-2:     $BOT2_ADDR"

# ── Fund genesis accounts ──

log "funding genesis accounts..."
genesis_cmd add-genesis-account "$VALIDATOR_ADDR" "${VALIDATOR_UCHIPS}${DENOM}" --home "$OCPD_HOME"
genesis_cmd add-genesis-account "$FAUCET_ADDR" "${FAUCET_UCHIPS}${DENOM}" --home "$OCPD_HOME"
genesis_cmd add-genesis-account "$BOT0_ADDR" "${BOT_UCHIPS}${DENOM}" --home "$OCPD_HOME"
genesis_cmd add-genesis-account "$BOT1_ADDR" "${BOT_UCHIPS}${DENOM}" --home "$OCPD_HOME"
genesis_cmd add-genesis-account "$BOT2_ADDR" "${BOT_UCHIPS}${DENOM}" --home "$OCPD_HOME"

# ── Patch genesis JSON ──

GENESIS="$OCPD_HOME/config/genesis.json"

log "patching genesis: denom metadata, staking params, pre-seeded table"
"$PY" - "$GENESIS" <<'PYEOF'
import json, sys

path = sys.argv[1]
with open(path, "r") as f:
    g = json.load(f)

# Bank denom metadata — testnet uses TCHIPS to distinguish from mainnet CHIPS
g["app_state"]["bank"]["denom_metadata"] = [
    {
        "description": "The testnet token of the OnChainPoker network.",
        "denom_units": [
            {"denom": "utchips", "exponent": 0, "aliases": ["microtchips"]},
            {"denom": "mtchips", "exponent": 3, "aliases": ["millitchips"]},
            {"denom": "tchips",  "exponent": 6, "aliases": []},
        ],
        "base": "utchips",
        "display": "tchips",
        "name": "OnChainPoker Testnet",
        "symbol": "TCHIPS",
    }
]

# Staking bond_denom
g["app_state"]["staking"]["params"]["bond_denom"] = "utchips"

# Pre-seeded poker table (id=1):
# 5k/10k blinds (in utchips), 500k-5M buy-in, 30s timeouts
g["app_state"]["poker"] = {
    "next_table_id": 2,
    "tables": [
        {
            "id": 1,
            "creator": "",
            "label": "Testnet Table #1",
            "params": {
                "max_players": 9,
                "small_blind": 5000,
                "big_blind": 10000,
                "min_buy_in": 500000,
                "max_buy_in": 5000000,
                "action_timeout_secs": 30,
                "dealer_timeout_secs": 30,
            },
            "seats": [],
            "next_hand_id": 1,
            "button_seat": -1,
        }
    ],
}

with open(path, "w") as f:
    json.dump(g, f, indent=2)
    f.write("\n")
PYEOF

# ── Gentx ──

log "generating gentx: ${GENTX_STAKE}${DENOM} self-delegation"
genesis_cmd gentx validator "${GENTX_STAKE}${DENOM}" \
  --chain-id "$CHAIN_ID" \
  --home "$OCPD_HOME" \
  --keyring-backend "$OCPD_KEYRING_BACKEND" \
  --moniker "$OCPD_MONIKER"

log "collecting gentxs"
genesis_cmd collect-gentxs --home "$OCPD_HOME"

# ── Patch config files ──

CONFIG_TOML="$OCPD_HOME/config/config.toml"
APP_TOML="$OCPD_HOME/config/app.toml"
CLIENT_TOML="$OCPD_HOME/config/client.toml"

log "patching config.toml: timeout_commit=${TIMEOUT_COMMIT}"
sed -i.bak -E "s/^timeout_commit = .*/timeout_commit = \"${TIMEOUT_COMMIT}\"/" "$CONFIG_TOML"
rm -f "$CONFIG_TOML.bak"

log "patching app.toml: minimum-gas-prices=${MIN_GAS_PRICES}, api.enable=true"
sed -i.bak -E "s/^minimum-gas-prices = .*/minimum-gas-prices = \"${MIN_GAS_PRICES}\"/" "$APP_TOML"
rm -f "$APP_TOML.bak"

# Enable API (LCD)
"$PY" - "$APP_TOML" <<'PYEOF2'
import re, sys
path = sys.argv[1]
with open(path, "r") as f:
    content = f.read()
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

# Patch client.toml
if [[ -f "$CLIENT_TOML" ]]; then
  log "patching client.toml: chain-id, keyring-backend"
  sed -i.bak -E "s/^chain-id = .*/chain-id = \"${CHAIN_ID}\"/" "$CLIENT_TOML"
  sed -i.bak -E "s/^keyring-backend = .*/keyring-backend = \"${OCPD_KEYRING_BACKEND}\"/" "$CLIENT_TOML"
  rm -f "$CLIENT_TOML.bak"
fi

# ── Validate ──

log "validating genesis"
genesis_cmd validate-genesis --home "$OCPD_HOME"

# ── Summary ──

GENESIS_HASH="$(shasum -a 256 "$GENESIS" | awk '{print $1}')"

echo ""
log "=== Testnet Genesis Ready ==="
log ""
log "  Chain ID:       $CHAIN_ID"
log "  Home:           $OCPD_HOME"
log "  Genesis SHA256: $GENESIS_HASH"
log ""
log "  Accounts:"
log "    validator: $VALIDATOR_ADDR (${VALIDATOR_UCHIPS} ${DENOM})"
log "    faucet:    $FAUCET_ADDR (${FAUCET_UCHIPS} ${DENOM})"
log "    bot-0:     $BOT0_ADDR (${BOT_UCHIPS} ${DENOM})"
log "    bot-1:     $BOT1_ADDR (${BOT_UCHIPS} ${DENOM})"
log "    bot-2:     $BOT2_ADDR (${BOT_UCHIPS} ${DENOM})"
log ""
log "  Pre-seeded table: id=1 (5k/10k blinds, 500k-5M buy-in)"
log ""
log "  Key mnemonics saved to: $OCPD_HOME/keys/"
log "    BACK THESE UP and populate:"
log "      - coordinator.env: FAUCET_MNEMONIC=<faucet.mnemonic>"
log "      - bot-0.env: BOT_MNEMONIC=<bot-0.mnemonic>"
log "      - bot-1.env: BOT_MNEMONIC=<bot-1.mnemonic>"
log "      - bot-2.env: BOT_MNEMONIC=<bot-2.mnemonic>"
log ""
log "  Next steps:"
log "    1. Back up mnemonics, populate env files"
log "    2. Start node: ocpd start --home $OCPD_HOME"
log "    3. Start coordinator, dealers, bots"
log ""
