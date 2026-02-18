#!/usr/bin/env bash
set -euo pipefail

fail=0

require_literal() {
  local file="$1"
  local needle="$2"
  local message="$3"
  if ! grep -Fq -- "$needle" "$file"; then
    echo "[runtime-check] FAIL: $message"
    echo "  file: $file"
    echo "  expected text: $needle"
    fail=1
  fi
}

require_literal README.md "Production target:" "README.md must mark apps/cosmos as production target"
require_literal README.md '`apps/cosmos`' "README.md must mark apps/cosmos as production target"
require_literal apps/chain/README.md "legacy, devnet-only" "apps/chain README must mark legacy/devnet-only status"
require_literal apps/chain/scripts/localnet.sh "OCP_CHAIN_PROFILE=devnet" "apps/chain localnet should gate startup on OCP_CHAIN_PROFILE=devnet"
require_literal package.json '"dev": "OCP_CHAIN_PROFILE=devnet' "package.json dev script should pass OCP_CHAIN_PROFILE=devnet explicitly"
require_literal .github/workflows/ci.yml "OCP_CHAIN_PROFILE=devnet" "CI dealer smoke should start apps/chain with explicit devnet opt-in"

if [[ "$fail" -ne 0 ]]; then
  echo "[runtime-check] one or more runtime policy checks failed"
  exit 1
fi

echo "[runtime-check] runtime policy checks passed"
