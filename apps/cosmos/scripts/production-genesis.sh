#!/usr/bin/env bash
#
# production-genesis.sh — Generate the production genesis for onchainpoker-1.
#
# This script initializes a chain home directory with the final mainnet genesis.
# It is NOT idempotent: it will refuse to overwrite an existing genesis.
#
# Three keys are created:
#   validator   — node operator, self-delegates stake
#   pool-seeder — holds ~3.87B OCP for IBC transfer to Osmosis
#   operator    — operations reserve (~419M OCP)
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

MIN_GAS_PRICES="0.025${DENOM}"
TIMEOUT_COMMIT="6s"

# ── Paths ──

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OCPD_HOME="${OCPD_HOME:-${HOME:?HOME must be set}/.ocpd}"
OCPD_MONIKER="${OCPD_MONIKER:-$(hostname -s)}"
OCPD_KEYRING_BACKEND="${OCPD_KEYRING_BACKEND:-os}"
OCPD="${OCPD_BIN:-$ROOT/bin/ocpd}"

# ── Helpers ──

log() { echo "[production-genesis] $*"; }
die() { echo "[production-genesis] ERROR: $*" >&2; exit 1; }

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

# Save key mnemonic to a secure file. Captures the mnemonic from `keys add`
# output and writes it to $OCPD_HOME/keys/<name>.mnemonic with mode 0600.
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

  # Extract the mnemonic (last line after the "Important" warning).
  local mnemonic
  mnemonic="$(echo "$output" | tail -1)"

  local mnemonic_file="$keys_dir/${name}.mnemonic"
  echo "$mnemonic" > "$mnemonic_file"
  chmod 600 "$mnemonic_file"

  # Print address info (everything except the mnemonic line) to terminal.
  echo "$output" | sed '$d' >&2

  log "  created key '$name' — mnemonic saved to $mnemonic_file"
}

# ── Sanity checks ──

if [[ ! -x "$OCPD" ]]; then
  die "ocpd binary not found at $OCPD — build it first: (cd $ROOT && go build -o bin/ocpd ./cmd/ocpd)"
fi

if [[ -f "$OCPD_HOME/config/genesis.json" ]]; then
  die "genesis already exists at $OCPD_HOME/config/genesis.json — remove $OCPD_HOME to start fresh"
fi

PY="$(pick_python)" || die "python3 or python required for genesis patching"

# Verify total = sum of parts using python (safe on all architectures).
"$PY" -c "
pool = $POOL_UOCP
stake = $VALIDATOR_STAKE_UOCP
ops = $OPS_RESERVE_UOCP
total = $TOTAL_UOCP
computed = pool + stake + ops
assert computed == total, f'token allocation mismatch: {computed} != {total}'
" || die "token allocation verification failed"

# ── Init chain ──

log "initializing chain home at $OCPD_HOME"
runq "$OCPD" init "$OCPD_MONIKER" --chain-id "$CHAIN_ID" --home "$OCPD_HOME"

# ── Create keys ──
#
# Three separate keys to limit blast radius if any single key is compromised:
#   validator   — only holds self-delegation stake (10M OCP)
#   pool-seeder — holds Osmosis pool seeding funds (~3.87B OCP)
#   operator    — holds operations reserve (~419M OCP)

log "creating keys (keyring-backend=$OCPD_KEYRING_BACKEND)"
if [[ "$OCPD_KEYRING_BACKEND" != "test" ]]; then
  log "  You will be prompted for a passphrase for each key."
fi

for KEY_NAME in validator pool-seeder operator; do
  create_key_secure "$KEY_NAME"
done

VALIDATOR_ADDR="$(key_addr validator)"
POOL_SEEDER_ADDR="$(key_addr pool-seeder)"
OPERATOR_ADDR="$(key_addr operator)"

log "  validator:   $VALIDATOR_ADDR"
log "  pool-seeder: $POOL_SEEDER_ADDR"
log "  operator:    $OPERATOR_ADDR"

# ── Fund genesis accounts ──

log "funding validator account: ${VALIDATOR_STAKE_UOCP}${DENOM} (self-delegation)"
genesis_cmd add-genesis-account "$VALIDATOR_ADDR" "${VALIDATOR_STAKE_UOCP}${DENOM}" --home "$OCPD_HOME"

log "funding pool-seeder account: ${POOL_UOCP}${DENOM} (Osmosis pool)"
genesis_cmd add-genesis-account "$POOL_SEEDER_ADDR" "${POOL_UOCP}${DENOM}" --home "$OCPD_HOME"

log "funding operator account: ${OPS_RESERVE_UOCP}${DENOM} (operations reserve)"
genesis_cmd add-genesis-account "$OPERATOR_ADDR" "${OPS_RESERVE_UOCP}${DENOM}" --home "$OCPD_HOME"

# ── Patch genesis JSON ──

GENESIS="$OCPD_HOME/config/genesis.json"

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
CLIENT_TOML="$OCPD_HOME/config/client.toml"

log "patching config.toml: timeout_commit=${TIMEOUT_COMMIT}"
sed -i.bak -E "s/^timeout_commit = .*/timeout_commit = \"${TIMEOUT_COMMIT}\"/" "$CONFIG_TOML"
rm -f "$CONFIG_TOML.bak"

log "patching app.toml: minimum-gas-prices=${MIN_GAS_PRICES}, api.enable=true"
sed -i.bak -E "s/^minimum-gas-prices = .*/minimum-gas-prices = \"${MIN_GAS_PRICES}\"/" "$APP_TOML"
rm -f "$APP_TOML.bak"

# Enable API (needed for coordinator/dealer-daemon LCD queries).
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

# Patch client.toml for operator convenience.
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
log "=== Production Genesis Ready ==="
log ""
log "  Chain ID:       $CHAIN_ID"
log "  Home:           $OCPD_HOME"
log "  Genesis:        $GENESIS"
log "  Genesis SHA256: $GENESIS_HASH"
log ""
log "  Validator addr:   $VALIDATOR_ADDR"
log "  Pool-seeder addr: $POOL_SEEDER_ADDR"
log "  Operator addr:    $OPERATOR_ADDR"
log ""
log "  Total supply:   4,294,967,295 OCP ($TOTAL_UOCP uocp)"
log "    Pool seeding:       3,865,470,565 OCP (pool-seeder key)"
log "    Validator stake:    10,000,000 OCP (validator key, self-delegated)"
log "    Operations reserve: 419,496,730 OCP (operator key)"
log ""
log "  Config:"
log "    timeout_commit:     $TIMEOUT_COMMIT"
log "    minimum-gas-prices: $MIN_GAS_PRICES"
log ""
log "  Key mnemonics saved to: $OCPD_HOME/keys/"
log "    BACK THESE UP IMMEDIATELY and delete the files."
log ""
log "  Next steps:"
log "    1. Securely back up mnemonics from $OCPD_HOME/keys/, then delete them"
log "    2. Copy $OCPD_HOME to VPS"
log "    3. Start node: ocpd start --home $OCPD_HOME"
log "    4. Verify blocks: curl http://localhost:26657/status"
log "    5. Add persistent_peers in config.toml before connecting to other networks"
log ""
