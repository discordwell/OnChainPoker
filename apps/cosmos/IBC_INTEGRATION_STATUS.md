# IBC Integration Status

**Date:** 2026-02-21
**Branch:** main (uncommitted changes)

---

## What's Done

### Phase 1A: ibc-go dependency added
- `github.com/cosmos/ibc-go/v10@main` (pseudo-version `v10.0.0-beta.0.0.20260220164140-eb52d21ab253`)
- Also pulled `cosmossdk.io/x/upgrade v0.2.0` (needed for IBC keeper's `UpgradeKeeper` interface)
- SDK was auto-upgraded to pseudo-version `v0.54.0-rc.1.0.20251215170539-f6237824459b` (same SDK main branch, CometBFT v0.39)

### Phase 1B: app_config.go wired
File: `apps/cosmos/app/app_config.go`
- Added imports for `ibcexported` and `ibctransfertypes`
- Added `transfer` module account with `Minter` + `Burner` permissions
- Added `ibc` and `transfer` to `BeginBlockers`, `EndBlockers`, `InitGenesis`, `ExportGenesis` ordering

### Phase 1C: app.go keepers + router wired
File: `apps/cosmos/app/app.go`
- Added `IBCKeeper *ibckeeper.Keeper` and `TransferKeeper *ibctransferkeeper.Keeper` to `OcpApp`
- After `appBuilder.Build()` and before `app.Load()`:
  1. Creates IBC + Transfer store keys, registers with runtime
  2. Creates IBC keeper (with `noopUpgradeKeeper` — see below)
  3. Creates Transfer keeper
  4. Sets up IBC v1 router (transfer stack) and v2 router
  5. Registers 07-tendermint and solo-machine light clients
  6. Calls `app.RegisterModules()` for all IBC modules

### Phase 1C (supporting file): noopupgrade.go
File: `apps/cosmos/app/noopupgrade.go`
- Implements `clienttypes.UpgradeKeeper` interface with no-ops
- IBC keeper requires a non-nil `UpgradeKeeper` (it calls `isEmpty()` via reflection)
- Since this chain has no x/gov and no x/upgrade, the no-op returns errors for all upgrade operations
- Normal IBC transfer/relaying does NOT need upgrades; this only matters for governance-initiated client upgrades

---

## Resolved Blockers

### `go mod tidy` module path mismatch — FIXED
Used `go mod tidy -e` to ignore transitive test dep errors.

### `ObjKVStore` missing from store — FIXED
ibc-go@main + SDK pseudo-version require `cosmossdk.io/store v1.3.0-beta.0` (from SDK main branch), but Go's MVS selected `v1.10.0-rc.2` (higher semver, different branch) which lacks `ObjKVStore`. Fixed with a `replace` directive forcing `v1.3.0-beta.0`.

### CometBFT v2 vs v1 proto types — FIXED
Three files referenced `cometbft/v2` or `cometbft/api` proto types that the SDK pseudo-version expects from `cometbft/proto/tendermint`:
- `app/export.go`: Changed import to `github.com/cometbft/cometbft/proto/tendermint/types`
- `cmd/ocpd/cmd/commands.go`: Changed import to `github.com/cometbft/cometbft/config`
- `x/dealer/keeper/penalty_test.go`: Changed import to `github.com/cometbft/cometbft/proto/tendermint/crypto`, added `GetValidatorPower()` to `fakeValidator`

### Phase 1D: Build + tests — COMPLETE
- `go build ./cmd/ocpd` ✅
- `go test ./...` ✅ (all packages pass)

---

## What Comes Next

### Phase 2: Production genesis script
**New file:** `apps/cosmos/scripts/production-genesis.sh`
- Chain ID: `onchainpoker-1`
- Real keyring (not `test`)
- Token allocation:
  | Purpose | OCP | uocp |
  |---------|-----|------|
  | Pool seeding (Osmosis) | 3,865,470,565 | 3,865,470,565,000,000 |
  | Validator self-delegation | 10,000,000 | 10,000,000,000,000 |
  | Operations reserve | 419,496,730 | 419,496,730,000,000 |
  | **Total** | **4,294,967,295** | **4,294,967,295,000,000** |
- Bank denom metadata (name: "OnChainPoker", symbol: "OCP", base: "uocp", display: "ocp", exponent: 6)
- `timeout_commit = "6s"`, `minimum-gas-prices = "0.025uocp"`
- IBC genesis auto-included from module registration
- Modeled on existing `apps/cosmos/scripts/localnet.sh`

### Phase 3: Deploy chain to VPS
- Cross-compile: `GOOS=linux GOARCH=amd64 go build -o apps/cosmos/bin/ocpd-linux-amd64 ./apps/cosmos/cmd/ocpd`
- Extend `scripts/deploy-vps.sh` to also deploy chain binary
- Initialize chain on VPS, copy genesis, start via existing systemd template (`deploy/ocp-chain-node@.service`)
- Verify blocks: `curl http://discordwell.com:26657/status`

### Phase 4: IBC relayer + Osmosis connection
- Install Hermes relayer on VPS
- Create Hermes config template: `deploy/hermes-config.toml`
- Create IBC connection + transfer channel between `onchainpoker-1` ↔ `osmosis-1`
- Create systemd service: `deploy/ocp-relayer.service`
- IBC transfer OCP to Osmosis: `ocpd tx ibc-transfer transfer transfer channel-0 <osmo-addr> 3000000000000000uocp --from operator`

### Phase 5: Osmosis pool
- Create OCP/ATOM 50/50 balancer pool with `osmosisd tx gamm create-pool`
- Initial OCP/ATOM ratio determines starting price (business decision)
- Optional: PR to `cosmos/chain-registry` + `osmosis-labs/assetlists`

### Phase 6: Update LAUNCH_MANIFEST.md
- Fill in chain ID `onchainpoker-1`
- Add genesis hash, binary hash
- Add IBC verification commands
- Add Osmosis pool verification

---

## Key Files Modified/Created

| File | Status |
|------|--------|
| `apps/cosmos/go.mod` | Modified (ibc-go + x/upgrade added, SDK upgraded) |
| `apps/cosmos/app/app_config.go` | Modified (IBC imports, permissions, ordering) |
| `apps/cosmos/app/app.go` | Modified (IBC keepers, router, light clients, module registration) |
| `apps/cosmos/app/noopupgrade.go` | **New** (no-op UpgradeKeeper for IBC) |
| `apps/cosmos/scripts/production-genesis.sh` | **Not yet created** |
| `deploy/ocp-relayer.service` | **Not yet created** |
| `deploy/hermes-config.toml` | **Not yet created** |
| `docs/LAUNCH_MANIFEST.md` | **Not yet updated** |
| `scripts/deploy-vps.sh` | **Not yet updated** |

---

## Architecture Decision: Why no depinject for IBC

ibc-go v10 does not provide depinject `ProvideModule` functions or proto-based module configs. The standard pattern (from ibc-go's own simapp) is manual keeper construction. The SDK's `runtime.App` provides `RegisterModules()` and `RegisterStores()` specifically for this — adding non-depinject modules to a depinject-based app. This is the documented hybrid approach.

## Architecture Decision: noopUpgradeKeeper

IBC's keeper constructor panics if `UpgradeKeeper` is nil or zero-value (reflection check). Since this chain has no governance and no upgrade module, a no-op implementation satisfies the interface. Normal IBC operations (transfers, relaying, channel handshakes) don't use upgrade methods. Only governance-initiated IBC client upgrades would fail — which is acceptable since there's no governance module to initiate them.
