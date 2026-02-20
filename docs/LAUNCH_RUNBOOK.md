# Launch Runbook

Status date: 2026-02-20

## 1. Freeze Inputs

Set these values before launch:

- `CHAIN_ID`
- `GENESIS_PATH` (final immutable genesis file)
- `TAG_NAME` (example: `launch-ocp-mainnet-2026-02-20`)

```bash
CHAIN_ID="<chain-id>"
GENESIS_PATH="<absolute-path-to-final-genesis.json>"
TAG_NAME="<launch-tag>"
```

## 2. Validate Genesis and Compute Hash

```bash
apps/cosmos/bin/ocpd genesis validate-genesis --home "$(dirname "$GENESIS_PATH")/.."
shasum -a 256 "$GENESIS_PATH"
```

Update `/Users/discordwell/Projects/OnChainPoker/docs/LAUNCH_MANIFEST.md` with:

- `Chain ID`
- `Genesis file path`
- `Genesis SHA-256`

## 3. Final Pre-Launch Gate

```bash
cd /Users/discordwell/Projects/OnChainPoker

# Chain unit/integration tests
(cd apps/cosmos && go test ./...)

# Daemon build + tests
pnpm -C apps/dealer-daemon build
pnpm -C apps/dealer-daemon test

# SDK tests
pnpm -C packages/ocp-sdk test

# Coordinator build + tests
pnpm -C apps/coordinator build
pnpm -C apps/coordinator test

# End-to-end dealer flow
bash scripts/cosmos-dealer-e2e.sh
```

## 4. Build Artifacts

```bash
cd /Users/discordwell/Projects/OnChainPoker
go build -o apps/cosmos/bin/ocpd ./apps/cosmos/cmd/ocpd
bash scripts/deploy-vps.sh --build-only
```

## 5. Commit + Tag

```bash
cd /Users/discordwell/Projects/OnChainPoker

git add \
  docs/LAUNCH_MANIFEST.md \
  docs/LAUNCH_RUNBOOK.md \
  docs/ONE_AND_DONE_CHECKLIST.md \
  apps/cosmos \
  apps/dealer-daemon \
  packages/ocp-sdk \
  sync.md

git commit -m "launch: finalize one-and-done runtime and publish manifest"
git tag -a "$TAG_NAME" -m "OCP launch freeze ($CHAIN_ID)"

git push origin HEAD
git push origin "$TAG_NAME"
```

## 6. Publish Launch Proof Set

Publish these artifacts publicly in one place:

- Commit SHA
- Tag
- Chain ID
- Genesis SHA-256
- `/Users/discordwell/Projects/OnChainPoker/docs/LAUNCH_MANIFEST.md`

