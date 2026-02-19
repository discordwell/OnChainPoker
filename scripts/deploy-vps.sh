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
ssh "$VPS_SSH" "mkdir -p $VPS_OCP_DIR/{web,coordinator,dealer-daemon,config,bin}"

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

# Install dependencies remotely
echo ">> Installing remote dependencies..."
ssh "$VPS_SSH" "cd $VPS_OCP_DIR/coordinator && npm install --omit=dev 2>/dev/null || true"
ssh "$VPS_SSH" "cd $VPS_OCP_DIR/dealer-daemon && npm install --omit=dev 2>/dev/null || true"

# Reload and restart services
echo ">> Restarting services..."
ssh "$VPS_SSH" "systemctl daemon-reload && systemctl restart ocp-coordinator ocp-dealer-daemon@0 ocp-dealer-daemon@1 ocp-dealer-daemon@2 2>/dev/null || true"

echo ""
echo "=== Deploy complete ==="
echo "Web:   https://$VPS_HOST/ocp"
echo "API:   https://$VPS_HOST/ocp/api/health"
