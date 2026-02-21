#!/usr/bin/env bash
set -euo pipefail

# OCP VPS Deployment Script
# Builds all artifacts locally and deploys to the production VPS.
#
# Usage:
#   ./scripts/deploy-vps.sh [--build-only] [--skip-build]
#
# Environment:
#   VPS_HOST        — SSH host (default: discordwell.com)
#   VPS_USER        — SSH user (default: root)
#   VPS_OCP_DIR     — Remote install dir (default: /opt/ocp)

VPS_HOST="${VPS_HOST:-discordwell.com}"
VPS_USER="${VPS_USER:-root}"
VPS_OCP_DIR="${VPS_OCP_DIR:-/opt/ocp}"
VPS_SSH="${VPS_USER}@${VPS_HOST}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUILD_ONLY=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=true ;;
    --skip-build) SKIP_BUILD=true ;;
  esac
done

ensure_service_active() {
  local svc="$1"
  if ssh "$VPS_SSH" "systemctl is-active --quiet $svc"; then
    return 0
  fi
  echo "ERROR: service is not active: $svc"
  ssh "$VPS_SSH" "systemctl --no-pager --full status $svc || true"
  return 1
}

wait_remote_http() {
  local label="$1"
  local url="$2"
  local attempts="${3:-30}"
  local i
  for ((i=1; i<=attempts; i++)); do
    if ssh "$VPS_SSH" "curl -fsS --max-time 3 '$url' >/dev/null"; then
      echo "   OK: $label"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: timed out waiting for $label ($url)"
  return 1
}

require_remote_file() {
  local path="$1"
  if ssh "$VPS_SSH" "test -f '$path'"; then
    return 0
  fi
  echo "ERROR: required remote file missing: $path"
  return 1
}

echo "=== OCP Deploy ==="
echo "Host: $VPS_SSH"
echo "Remote dir: $VPS_OCP_DIR"
echo ""

# ── Build ──

if [ "$SKIP_BUILD" = false ]; then
  echo ">> Building packages..."
  cd "$PROJECT_ROOT"
  pnpm -C packages/ocp-crypto build
  pnpm -C packages/ocp-shuffle build
  pnpm -C packages/ocp-sdk build

  echo ">> Building web..."
  pnpm -C apps/web build

  echo ">> Building coordinator..."
  pnpm -C apps/coordinator build

  echo ">> Building dealer-daemon..."
  pnpm -C apps/dealer-daemon build

  echo ">> Cross-compiling ocpd (linux/amd64)..."
  OCPD_BIN="$PROJECT_ROOT/apps/cosmos/bin/ocpd-linux-amd64"
  (cd "$PROJECT_ROOT/apps/cosmos" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$OCPD_BIN" ./cmd/ocpd)
  echo "   Built: $OCPD_BIN ($(du -h "$OCPD_BIN" | cut -f1))"

  echo ">> Build complete."
fi

if [ "$BUILD_ONLY" = true ]; then
  echo "Build-only mode, skipping deploy."
  exit 0
fi

# ── Deploy ──

echo ""
echo ">> Syncing artifacts to $VPS_SSH:$VPS_OCP_DIR ..."

# Ensure remote directories exist
ssh "$VPS_SSH" "mkdir -p $VPS_OCP_DIR/{web,coordinator,dealer-daemon,config,bin,chain,packages/ocp-crypto,packages/ocp-shuffle,packages/ocp-sdk}"

# Web (static)
rsync -az --delete \
  "$PROJECT_ROOT/apps/web/dist/" \
  "$VPS_SSH:$VPS_OCP_DIR/web/dist/"

# Coordinator (node)
rsync -az --delete \
  "$PROJECT_ROOT/apps/coordinator/dist/" \
  "$VPS_SSH:$VPS_OCP_DIR/coordinator/dist/"
rsync -az \
  "$PROJECT_ROOT/apps/coordinator/package.json" \
  "$VPS_SSH:$VPS_OCP_DIR/coordinator/"

# Dealer daemon (node)
rsync -az --delete \
  "$PROJECT_ROOT/apps/dealer-daemon/dist/" \
  "$VPS_SSH:$VPS_OCP_DIR/dealer-daemon/dist/"
rsync -az \
  "$PROJECT_ROOT/apps/dealer-daemon/package.json" \
  "$VPS_SSH:$VPS_OCP_DIR/dealer-daemon/"

# Chain binary (linux/amd64)
OCPD_BIN="$PROJECT_ROOT/apps/cosmos/bin/ocpd-linux-amd64"
if [[ -f "$OCPD_BIN" ]]; then
  rsync -az "$OCPD_BIN" "$VPS_SSH:$VPS_OCP_DIR/bin/ocpd"
  ssh "$VPS_SSH" "chmod +x $VPS_OCP_DIR/bin/ocpd"
else
  echo "   WARN: ocpd-linux-amd64 not found, skipping chain binary deploy"
fi

# Production genesis script
rsync -az \
  "$PROJECT_ROOT/apps/cosmos/scripts/production-genesis.sh" \
  "$VPS_SSH:$VPS_OCP_DIR/chain/"

# Shared packages (for node_modules resolution)
for pkg in ocp-crypto ocp-shuffle ocp-sdk; do
  rsync -az --delete \
    "$PROJECT_ROOT/packages/$pkg/dist/" \
    "$VPS_SSH:$VPS_OCP_DIR/packages/$pkg/dist/"
  rsync -az \
    "$PROJECT_ROOT/packages/$pkg/package.json" \
    "$VPS_SSH:$VPS_OCP_DIR/packages/$pkg/"
done

# Systemd units
rsync -az \
  "$PROJECT_ROOT/deploy/ocp-coordinator.service" \
  "$PROJECT_ROOT/deploy/ocp-dealer-daemon@.service" \
  "$PROJECT_ROOT/deploy/ocp-chain-node@.service" \
  "$VPS_SSH:/etc/systemd/system/"

# Environment templates (operator must copy + fill real env files).
rsync -az \
  "$PROJECT_ROOT/deploy/coordinator.env.example" \
  "$PROJECT_ROOT/deploy/dealer.env.example" \
  "$VPS_SSH:$VPS_OCP_DIR/config/"

# Install dependencies remotely
echo ">> Installing remote dependencies..."
ssh "$VPS_SSH" "VPS_OCP_DIR='$VPS_OCP_DIR' node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.VPS_OCP_DIR;
if (!root) throw new Error('VPS_OCP_DIR missing');

function patchDeps(relPath, updates) {
  const absPath = path.join(root, relPath);
  const pkg = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  for (const [name, value] of Object.entries(updates)) {
    pkg.dependencies[name] = value;
  }
  fs.writeFileSync(absPath, JSON.stringify(pkg, null, 2) + '\\n', 'utf8');
}

patchDeps('packages/ocp-shuffle/package.json', {
  '@onchainpoker/ocp-crypto': 'file:../ocp-crypto',
});

patchDeps('dealer-daemon/package.json', {
  '@onchainpoker/ocp-crypto': 'file:../packages/ocp-crypto',
  '@onchainpoker/ocp-sdk': 'file:../packages/ocp-sdk',
  '@onchainpoker/ocp-shuffle': 'file:../packages/ocp-shuffle',
});
NODE"
ssh "$VPS_SSH" "cd $VPS_OCP_DIR/packages/ocp-crypto && npm install --omit=dev --no-fund --no-audit"
ssh "$VPS_SSH" "cd $VPS_OCP_DIR/packages/ocp-sdk && npm install --omit=dev --no-fund --no-audit"
ssh "$VPS_SSH" "cd $VPS_OCP_DIR/packages/ocp-shuffle && npm install --omit=dev --no-fund --no-audit"
ssh "$VPS_SSH" "cd $VPS_OCP_DIR/coordinator && npm install --omit=dev --no-fund --no-audit"
ssh "$VPS_SSH" "cd $VPS_OCP_DIR/dealer-daemon && npm install --omit=dev --no-fund --no-audit"

# Required runtime env files (fail-fast if absent).
echo ">> Validating required runtime env files..."
require_remote_file "$VPS_OCP_DIR/config/coordinator.env"
require_remote_file "$VPS_OCP_DIR/config/dealer-0.env"
require_remote_file "$VPS_OCP_DIR/config/dealer-1.env"
require_remote_file "$VPS_OCP_DIR/config/dealer-2.env"

# Reload and restart services
echo ">> Restarting services..."
ssh "$VPS_SSH" "systemctl daemon-reload"
ssh "$VPS_SSH" "systemctl restart ocp-coordinator ocp-dealer-daemon@0 ocp-dealer-daemon@1 ocp-dealer-daemon@2"
ensure_service_active "ocp-coordinator"
ensure_service_active "ocp-dealer-daemon@0"
ensure_service_active "ocp-dealer-daemon@1"
ensure_service_active "ocp-dealer-daemon@2"
wait_remote_http "coordinator health" "http://127.0.0.1:8788/health" 45

# Restart chain node if it's already initialized
if ssh "$VPS_SSH" "test -f '$VPS_OCP_DIR/chain/node0/config/genesis.json'"; then
  ssh "$VPS_SSH" "systemctl restart ocp-chain-node@0"
  ensure_service_active "ocp-chain-node@0"
  wait_remote_http "chain RPC status" "http://127.0.0.1:26657/status" 60
else
  echo "   Chain not initialized yet — run production-genesis.sh on VPS first"
fi

echo ""
echo "=== Deploy complete ==="
echo "Web:     https://$VPS_HOST/ocp"
echo "API:     https://$VPS_HOST/ocp/api/health"
echo ""
echo "Chain initialization (first deploy only):"
echo "  ssh $VPS_SSH"
echo "  OCPD_HOME=$VPS_OCP_DIR/chain/node0 OCPD_BIN=$VPS_OCP_DIR/bin/ocpd bash $VPS_OCP_DIR/chain/production-genesis.sh"
echo "  systemctl enable --now ocp-chain-node@0"
echo ""
echo "Runtime config templates copied to:"
echo "  $VPS_OCP_DIR/config/coordinator.env.example"
echo "  $VPS_OCP_DIR/config/dealer.env.example"
