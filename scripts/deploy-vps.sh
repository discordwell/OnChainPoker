#!/usr/bin/env bash
set -euo pipefail

# OCP VPS Deployment Script
# Builds all artifacts locally and deploys to the production VPS.
#
# Usage:
#   ./scripts/deploy-vps.sh [--build-only] [--skip-build]
#
# Environment:
#   DEPLOY_TARGETS  — Comma-separated SSH host aliases (default: ovh)
#                     Example: DEPLOY_TARGETS=ovh,ovh2 ./scripts/deploy-vps.sh
#   VPS_USER        — SSH user override (default: use SSH config)
#   VPS_OCP_DIR     — Remote install dir (default: /opt/ocp)
#   NO_RESTART      — If set to 1, skip service restart and env validation
#                     (useful for pre-flip deploys to a standby server)

DEPLOY_TARGETS="${DEPLOY_TARGETS:-ovh}"
VPS_USER="${VPS_USER:-}"
VPS_OCP_DIR="${VPS_OCP_DIR:-/opt/ocp}"
NO_RESTART="${NO_RESTART:-0}"

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

# Helper: resolve VPS_SSH from a target alias
resolve_ssh() {
  local target="$1"
  if [[ -n "$VPS_USER" ]]; then
    echo "${VPS_USER}@${target}"
  else
    echo "${target}"
  fi
}

ensure_service_active() {
  local ssh_target="$1"
  local svc="$2"
  if ssh "$ssh_target" "sudo systemctl is-active --quiet $svc"; then
    return 0
  fi
  echo "ERROR: service is not active: $svc"
  ssh "$ssh_target" "sudo systemctl --no-pager --full status $svc || true"
  return 1
}

wait_remote_http() {
  local ssh_target="$1"
  local label="$2"
  local url="$3"
  local attempts="${4:-30}"
  local i
  for ((i=1; i<=attempts; i++)); do
    if ssh "$ssh_target" "sudo curl -fsS --max-time 3 '$url' >/dev/null"; then
      echo "   OK: $label"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: timed out waiting for $label ($url)"
  return 1
}

require_remote_file() {
  local ssh_target="$1"
  local path="$2"
  if ssh "$ssh_target" "sudo test -f '$path'"; then
    return 0
  fi
  echo "ERROR: required remote file missing: $path"
  return 1
}

echo "=== OCP Deploy ==="
echo "Targets: $DEPLOY_TARGETS"
echo "Remote dir: $VPS_OCP_DIR"
echo "NO_RESTART: $NO_RESTART"
echo ""

# ── Build ──

if [ "$SKIP_BUILD" = false ]; then
  echo ">> Building packages..."
  cd "$PROJECT_ROOT"
  pnpm -C packages/ocp-crypto build
  pnpm -C packages/ocp-shuffle build
  pnpm -C packages/ocp-sdk build

  echo ">> Building web..."
  VITE_COORDINATOR_HTTP_URL=/ocp/api \
  VITE_COSMOS_RPC_URL=/ocp/rpc \
  VITE_COSMOS_LCD_URL=/ocp/lcd \
  VITE_COSMOS_CHAIN_ID=onchainpoker-testnet-1 \
  VITE_COSMOS_GAS_PRICE=0utchips \
  pnpm -C apps/web build

  echo ">> Building coordinator..."
  pnpm -C apps/coordinator build

  echo ">> Building dealer-daemon..."
  pnpm -C apps/dealer-daemon build

  echo ">> Building bot..."
  pnpm -C apps/bot build

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

# ── Deploy (loop over targets) ──

IFS=',' read -ra TARGETS <<< "$DEPLOY_TARGETS"

for TARGET in "${TARGETS[@]}"; do
  VPS_SSH="$(resolve_ssh "$TARGET")"

  echo ""
  echo ">> [$TARGET] Syncing artifacts to $VPS_SSH:$VPS_OCP_DIR ..."

  # Ensure remote directories exist
  ssh "$VPS_SSH" "sudo mkdir -p $VPS_OCP_DIR/{web,coordinator,dealer-daemon,bot,config,bin,chain,packages/ocp-crypto,packages/ocp-shuffle,packages/ocp-sdk,packages/holdem-eval} && sudo chown -R ocp:ocp $VPS_OCP_DIR"

  # Web (static)
  rsync -az --delete --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/apps/web/dist/" \
    "$VPS_SSH:$VPS_OCP_DIR/web/dist/"

  # Coordinator (node)
  rsync -az --delete --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/apps/coordinator/dist/" \
    "$VPS_SSH:$VPS_OCP_DIR/coordinator/dist/"
  rsync -az --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/apps/coordinator/package.json" \
    "$VPS_SSH:$VPS_OCP_DIR/coordinator/"

  # Dealer daemon (node)
  rsync -az --delete --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/apps/dealer-daemon/dist/" \
    "$VPS_SSH:$VPS_OCP_DIR/dealer-daemon/dist/"
  rsync -az --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/apps/dealer-daemon/package.json" \
    "$VPS_SSH:$VPS_OCP_DIR/dealer-daemon/"

  # Bot (node)
  rsync -az --delete --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/apps/bot/dist/" \
    "$VPS_SSH:$VPS_OCP_DIR/bot/dist/"
  rsync -az --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/apps/bot/package.json" \
    "$VPS_SSH:$VPS_OCP_DIR/bot/"

  # Chain binary (linux/amd64)
  OCPD_BIN="$PROJECT_ROOT/apps/cosmos/bin/ocpd-linux-amd64"
  if [[ -f "$OCPD_BIN" ]]; then
    rsync -az --rsync-path="sudo rsync" "$OCPD_BIN" "$VPS_SSH:$VPS_OCP_DIR/bin/ocpd"
    ssh "$VPS_SSH" "sudo chmod +x $VPS_OCP_DIR/bin/ocpd"
  else
    echo "   WARN: ocpd-linux-amd64 not found, skipping chain binary deploy"
  fi

  # Genesis scripts
  rsync -az --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/apps/cosmos/scripts/production-genesis.sh" \
    "$PROJECT_ROOT/apps/cosmos/scripts/testnet-genesis.sh" \
    "$VPS_SSH:$VPS_OCP_DIR/chain/"

  # Shared packages (for node_modules resolution)
  for pkg in ocp-crypto ocp-shuffle ocp-sdk holdem-eval; do
    rsync -az --delete --rsync-path="sudo rsync" \
      "$PROJECT_ROOT/packages/$pkg/dist/" \
      "$VPS_SSH:$VPS_OCP_DIR/packages/$pkg/dist/"
    rsync -az --rsync-path="sudo rsync" \
      "$PROJECT_ROOT/packages/$pkg/package.json" \
      "$VPS_SSH:$VPS_OCP_DIR/packages/$pkg/"
  done

  # Nginx config snippet (included from main discordwell.com server block)
  rsync -az --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/deploy/nginx-ocp.conf" \
    "$VPS_SSH:$VPS_OCP_DIR/config/"

  # Systemd units
  rsync -az --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/deploy/ocp-coordinator.service" \
    "$PROJECT_ROOT/deploy/ocp-dealer-daemon@.service" \
    "$PROJECT_ROOT/deploy/ocp-bot@.service" \
    "$PROJECT_ROOT/deploy/ocp-chain-node@.service" \
    "$VPS_SSH:/etc/systemd/system/"

  # Environment templates (operator must copy + fill real env files).
  rsync -az --rsync-path="sudo rsync" \
    "$PROJECT_ROOT/deploy/coordinator.env.example" \
    "$PROJECT_ROOT/deploy/dealer.env.example" \
    "$PROJECT_ROOT/deploy/bot.env.example" \
    "$VPS_SSH:$VPS_OCP_DIR/config/"

  # Fix ownership after rsync (sudo rsync creates files as root)
  ssh "$VPS_SSH" "sudo chown -R ocp:ocp $VPS_OCP_DIR"

  # Install dependencies remotely
  echo ">> [$TARGET] Installing remote dependencies..."
  ssh "$VPS_SSH" "sudo -u ocp VPS_OCP_DIR='$VPS_OCP_DIR' node <<'NODE'
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

patchDeps('coordinator/package.json', {
  '@onchainpoker/ocp-sdk': 'file:../packages/ocp-sdk',
});

patchDeps('dealer-daemon/package.json', {
  '@onchainpoker/ocp-crypto': 'file:../packages/ocp-crypto',
  '@onchainpoker/ocp-sdk': 'file:../packages/ocp-sdk',
  '@onchainpoker/ocp-shuffle': 'file:../packages/ocp-shuffle',
});

patchDeps('bot/package.json', {
  '@onchainpoker/ocp-crypto': 'file:../packages/ocp-crypto',
  '@onchainpoker/ocp-sdk': 'file:../packages/ocp-sdk',
  '@onchainpoker/holdem-eval': 'file:../packages/holdem-eval',
});
NODE"
  ssh "$VPS_SSH" "sudo -u ocp bash -c 'cd $VPS_OCP_DIR/packages/ocp-crypto && npm install --omit=dev --no-fund --no-audit'"
  ssh "$VPS_SSH" "sudo -u ocp bash -c 'cd $VPS_OCP_DIR/packages/ocp-sdk && npm install --omit=dev --no-fund --no-audit'"
  ssh "$VPS_SSH" "sudo -u ocp bash -c 'cd $VPS_OCP_DIR/packages/ocp-shuffle && npm install --omit=dev --no-fund --no-audit'"
  ssh "$VPS_SSH" "sudo -u ocp bash -c 'cd $VPS_OCP_DIR/coordinator && npm install --omit=dev --no-fund --no-audit'"
  ssh "$VPS_SSH" "sudo -u ocp bash -c 'cd $VPS_OCP_DIR/dealer-daemon && npm install --omit=dev --no-fund --no-audit'"
  ssh "$VPS_SSH" "sudo -u ocp bash -c 'cd $VPS_OCP_DIR/bot && npm install --omit=dev --no-fund --no-audit'"

  if [[ "$NO_RESTART" == "1" ]]; then
    echo ">> [$TARGET] NO_RESTART=1 — skipping env validation, service restart, and proxy reload."
    ssh "$VPS_SSH" "sudo systemctl daemon-reload"
    echo ">> [$TARGET] Deploy (artifacts only) complete."
    continue
  fi

  # Required runtime env files (fail-fast if absent).
  echo ">> [$TARGET] Validating required runtime env files..."
  require_remote_file "$VPS_SSH" "$VPS_OCP_DIR/config/coordinator.env"
  require_remote_file "$VPS_SSH" "$VPS_OCP_DIR/config/dealer-0.env"
  require_remote_file "$VPS_SSH" "$VPS_OCP_DIR/config/dealer-1.env"
  require_remote_file "$VPS_SSH" "$VPS_OCP_DIR/config/dealer-2.env"

  # Reload and restart services
  echo ">> [$TARGET] Restarting services..."
  ssh "$VPS_SSH" "sudo systemctl daemon-reload"
  ssh "$VPS_SSH" "sudo systemctl restart ocp-coordinator ocp-dealer-daemon@0 ocp-dealer-daemon@1 ocp-dealer-daemon@2"
  ensure_service_active "$VPS_SSH" "ocp-coordinator"
  ensure_service_active "$VPS_SSH" "ocp-dealer-daemon@0"
  ensure_service_active "$VPS_SSH" "ocp-dealer-daemon@1"
  ensure_service_active "$VPS_SSH" "ocp-dealer-daemon@2"
  wait_remote_http "$VPS_SSH" "coordinator health" "http://127.0.0.1:8788/health" 45

  # Restart any bot instances (detect bot-*.env in config dir)
  BOT_INSTANCES="$(ssh "$VPS_SSH" "ls $VPS_OCP_DIR/config/bot-*.env 2>/dev/null | sed 's|.*/bot-||;s|\.env$||' || true")"
  if [[ -n "$BOT_INSTANCES" ]]; then
    for BOT_ID in $BOT_INSTANCES; do
      echo "   Restarting ocp-bot@$BOT_ID..."
      ssh "$VPS_SSH" "sudo systemctl restart ocp-bot@$BOT_ID"
      ensure_service_active "$VPS_SSH" "ocp-bot@$BOT_ID"
    done
  else
    echo "   No bot env files found — skipping bot restart"
  fi

  # Restart chain node if it's already initialized
  if ssh "$VPS_SSH" "sudo test -f '$VPS_OCP_DIR/chain/node0/config/genesis.json'"; then
    ssh "$VPS_SSH" "sudo systemctl restart ocp-chain-node@0"
    ensure_service_active "$VPS_SSH" "ocp-chain-node@0"
    wait_remote_http "$VPS_SSH" "chain RPC status" "http://127.0.0.1:26657/status" 60
  else
    echo "   Chain not initialized yet — run production-genesis.sh on VPS first"
  fi

  # Detect and reload the reverse proxy (nginx or caddy)
  echo ">> [$TARGET] Reloading reverse proxy..."
  PROXY_TYPE="$(ssh "$VPS_SSH" 'if command -v caddy >/dev/null 2>&1 && systemctl is-active --quiet caddy; then echo caddy; elif command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx; then echo nginx; else echo none; fi')"
  case "$PROXY_TYPE" in
    caddy) ssh "$VPS_SSH" "sudo systemctl reload caddy" ;;
    nginx) ssh "$VPS_SSH" "sudo nginx -t && sudo systemctl reload nginx" ;;
    *)     echo "   WARN: No supported reverse proxy detected on $TARGET" ;;
  esac

  echo ""
  echo "=== [$TARGET] Deploy complete ==="
done

echo ""
echo "Web:     https://discordwell.com/ocp"
echo "LCD:     https://discordwell.com/ocp/lcd/cosmos/base/tendermint/v1beta1/node_info"
echo "API:     https://discordwell.com/ocp/api/health"
echo ""
echo "Chain initialization (first deploy only):"
echo "  ssh <target>"
echo "  OCPD_HOME=$VPS_OCP_DIR/chain/node0 OCPD_BIN=$VPS_OCP_DIR/bin/ocpd bash $VPS_OCP_DIR/chain/production-genesis.sh"
echo "  systemctl enable --now ocp-chain-node@0"
echo ""
echo "Runtime config templates copied to:"
echo "  $VPS_OCP_DIR/config/coordinator.env.example"
echo "  $VPS_OCP_DIR/config/dealer.env.example"
echo "  $VPS_OCP_DIR/config/bot.env.example"
echo ""
echo "Bot instances (optional):"
echo "  cp $VPS_OCP_DIR/config/bot.env.example $VPS_OCP_DIR/config/bot-0.env"
echo "  # Edit bot-0.env with mnemonic, table, strategy"
echo "  systemctl enable --now ocp-bot@0"
