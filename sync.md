# Cosmos Migration Coordination (sync)

This file is used by agents to coordinate workstreams while migrating the repo to Cosmos SDK.

## Agent 1: New Chain Implementation

Status (2026-02-10): Cosmos SDK app + `ocpd` CLI skeleton is implemented and builds.

Code:
- App wiring: `apps/cosmos/app`
- CLI: `apps/cosmos/cmd/ocpd`
  - AutoCLI enabled for `x/poker` + `x/dealer` services in `apps/cosmos/cmd/ocpd/cmd/root.go`.

Defaults (current):
- Bech32 prefix: `ocp`
- Base denom: `uocp` (display denom `ocp`)
- Home: `~/.ocpd`
- CLI env prefix: `OCPD` (e.g. `OCPD_HOME`)

Enabled SDK modules (so far):
- `auth`, `bank`, `staking`, `slashing`, `distribution`, `gov`, `evidence`, `genutil`, `upgrade`, `consensus`, `vesting`

Integration notes:
- To wire new modules like `x/poker` and `x/dealer`, update `apps/cosmos/app/app_config.go` and module ordering.
- See `apps/cosmos/sync.md` for Agent 1 wiring notes.
- `x/poker` and `x/dealer` are wired via depinject (see `apps/cosmos/x/poker/module.go`, `apps/cosmos/x/dealer/module.go`) and included in `apps/cosmos/app/app_config.go`.
- Legacy Amino msg names for custom modules must be <40 chars (ledger constraint); we use `ocp/poker/*` and `ocp/dealer/*`.

## Agent 2: real Devnet

Status (2026-02-10): Implemented Cosmos-style funding flows (no on-chain mint).

Dev funding model:
- Allocate coins via **genesis accounts** (bank balances in `genesis.json`).
- Create validator(s) via **gentx + collect-gentxs** (stake comes from the validator genesis account).
- Optional **off-chain faucet**: a pre-funded `faucet` key does `tx bank send` for convenience.

Code:
- `apps/cosmos/scripts/localnet.sh`: single-node localnet using `init -> add-genesis-account -> gentx -> collect-gentxs`.
- `apps/cosmos/scripts/multinet.sh`: multi-validator localnet (default: 4 validators) using the same `genesis accounts + gentx + collect-gentxs` flow.
- `apps/cosmos/scripts/faucet.sh`: helper to send coins from the `faucet` key.
- `apps/cosmos/README.md`: usage + env knobs.

Notes / Needs:
- If we want `apps/chain` and `apps/cosmos` running simultaneously, we should agree on non-conflicting default ports.
- Agent 6: clients should assume funding via genesis or faucet; `bank/mint` does not exist on Cosmos.
- Localnet patches `apps/cosmos/.ocpd/config/client.toml` (chain-id/node/keyring-backend) for smoother manual CLI usage.
- Single-validator localnets are fragile: dealer penalties can slash/jail validators, and if the only bonded validator drops to 0 voting power (or is jailed), CometBFT will halt. `apps/cosmos/scripts/localnet.sh` now defaults `OCPD_GENTX_STAKE=10000000` so 50% dealer slashes keep power > 0.

## Agent 3: Port game logic into Cosmos modules (x/poker + x/dealer)

Status (2026-02-10): Implemented `x/poker` + `x/dealer` (msgs/keeper/KV/events), bank-coin escrow via a `poker` module account, and grpc-gateway query routes; `go test ./...` passes under `apps/cosmos`.

### Module Layout
- Cosmos code lives under `apps/cosmos` (Go module: `onchainpoker/apps/cosmos`).
- New modules:
  - `apps/cosmos/x/poker`
  - `apps/cosmos/x/dealer`
- Shared crypto/eval code copied into `apps/cosmos/internal/*` so it can be imported by both modules.
- Protobuf sources live in `apps/cosmos/proto`; Go output is generated into `apps/cosmos/x/*/types` via `apps/cosmos/proto/buf.gen.yaml`.
- Unit tests: `apps/cosmos/x/poker/keeper/msg_server_test.go` (escrow flows + player-bond slash transfer).

### Bank Escrow / Denom
- `x/poker` escrows real `x/bank` coins into the `poker` module account on `Sit`, and returns coins on `Leave` / bond-ejection.
- Escrow denom uses `sdk.DefaultBondDenom` (Agent 1 sets this to `uocp`, display denom `ocp`).
- Player bond slashes (from poker action timeouts) are transferred from the `poker` module account to `auth`’s `fee_collector` module account to keep the escrow accounting consistent.

### Dealer Metadata Stored In Poker State (Avoid Cyclic Dependencies)
- To keep `x/poker` independent of `x/dealer`, the poker hand stores a small `DealerMeta` blob:
  - `epoch_id`
  - `deck_size`
  - `deck_finalized`
  - `hole_pos[18]` (255 sentinel for unset)
  - `cursor` (first board card pos)
  - `reveal_pos` and `reveal_deadline` (unix seconds; 255/0 means “not awaiting”)
- `x/dealer` owns the encrypted deck/shares/proofs and writes `DealerMeta` into poker state at `FinalizeDeck` time, and poker updates `reveal_pos/deadline` when phases change.

### Committee Sampling / Slashing Integration
- `x/dealer` samples committees from `x/staking` bonded validators using stake-weighted sampling utilities in `apps/cosmos/x/dealer/committee` (rand-epoch is deterministic in devnet; production should use a beacon/commit-reveal to reduce proposer bias).
- Slashing/jailing integration lives in:
  - `apps/cosmos/x/dealer/types/expected_keepers.go` (minimal keeper interfaces)
  - `apps/cosmos/x/dealer/keeper/penalty.go` (`SlashAndJailValidator` helper; calls real `x/slashing` / `x/staking`)

### App Wiring Needs (Agent 1)
- Add module accounts:
  - `poker` (no special perms)
- Ensure `x/dealer` keeper is constructed with references to:
  - `x/poker` keeper (for table/hand reads+writes)
  - `x/staking` keeper (for bonded validator set + consensus pubkeys)
  - (later) `x/slashing` keeper (via Agent 5)

## Agent 4: Stake-based committee

Status (2026-02-10): Implemented stake-weighted committee sampling utilities for `x/dealer`.

Code:
- `apps/cosmos/x/dealer/committee`

How to use (DKG epoch start / committee selection):
1. `randEpoch, err := committee.RandEpochOrDevnet(ctx, epochID, msg.RandEpoch)` (devnet default; production can supply a beacon/commit-reveal output)
2. `seed := committee.CommitteeSeed(randEpoch, epochID)`
3. `members, err := committee.SampleBondedMemberSnapshotsByPower(ctx, stakingKeeper, seed, int(committeeSize))`
4. Persist `members` (output is already sorted) and assign indices `1..N` (store `power` + `cons_pubkey` snapshot for later slashing/signature checks).

Notes:
- Sampling pool is the bonded validator set returned by `stakingKeeper.GetBondedValidatorsByPower` (active set, capped by `MaxValidators`), filtered to consensus power `> 0`.
- Block-hash-derived entropy is proposer-influenceable; production should replace `DevnetRandEpoch` with a beacon/commit-reveal scheme to reduce bias.

## Agent 5: Integrate Staking with slashing/jailing

Status (2026-02-10): Added a thin helper that slashes + jails the *real* validator via `x/slashing`/`x/staking`.

Code:
- `apps/cosmos/x/dealer/types/expected_keepers.go`
- `apps/cosmos/x/dealer/keeper/penalty.go`
- `apps/cosmos/x/dealer/keeper/penalty_test.go`

How to use (when `x/dealer` finalizes a fault):
1. Persist each member's `distributionHeight` (e.g. epoch start height) and their `powerAtDistributionHeight` at committee selection time.
2. Call `keeper.SlashAndJailValidator(ctx, k.stakingKeeper, k.slashingKeeper, valAddr, distributionHeight, powerAtDistributionHeight, slashFraction, jailDuration)`.

Notes:
- The `distributionHeight` + `powerAtDistributionHeight` inputs ensure a validator can't avoid the slash by unbonding right after being selected.
- `jailDuration` extends `x/slashing` `JailedUntil` and is enforced by `MsgUnjail` (if signing info is missing, the helper returns an error when `jailDuration > 0`).
- `SlashAndJailValidator` skips *jailing* if the target is the sole bonded validator (single-validator chains cannot safely jail without halting consensus). Slashing still applies.

## Agent 6: Client + Coordinator Boundary (Cosmos)

Status (2026-02-10): Coordinator supports `COORDINATOR_CHAIN_ADAPTER=cosmos`; SDK supports CosmJS signing + LCD queries + OCP registry/typeUrls for Msgs + a small `createOcpCosmosClient` convenience wrapper.

Code:
- Coordinator adapter: `apps/coordinator/src/chain/cosmos.ts`
- Coordinator notes: `apps/coordinator/sync.md`
- SDK Cosmos exports: `packages/ocp-sdk/src/cosmos/*` (`createOcpRegistry`, `OCP_TYPE_URLS`, signing + LCD, `createOcpCosmosClient`)
- SDK notes: `packages/ocp-sdk/sync.md`
  - TS proto codegen template: `apps/cosmos/proto/buf.gen.ts.yaml` (outputs to `packages/ocp-sdk/src/cosmos/gen`)
- Cosmos hand driver script: `scripts/play_hand_cosmos.mjs` (funds random wallets via `apps/cosmos/scripts/faucet.sh`, then submits poker txs via CosmJS)

Coordinator Cosmos adapter expectations:
- Tendermint RPC WS subscription available (`tm.event='Tx'`) at `COORDINATOR_COSMOS_RPC_URL` (default `http://127.0.0.1:26657`).
- LCD/grpc-gateway available at `COORDINATOR_COSMOS_LCD_URL` (default `http://127.0.0.1:1317`).
- Poker module should expose grpc-gateway query routes:
  - `GET /onchainpoker/poker/v1/tables`
  - `GET /onchainpoker/poker/v1/tables/{table_id}`
  - Note: missing tables currently return HTTP 500 with an SDK error code (not a 404); clients should handle this or `x/poker` can be updated to return gRPC `NotFound` for better HTTP mapping.
- `QueryTableResponse.table.seats` is always length 9; empty seats have an empty/missing `player` field (not `null`).
- Events should include `tableId` (and optionally `handId`) attributes for routing; adapter decodes base64-encoded attrs when needed.
