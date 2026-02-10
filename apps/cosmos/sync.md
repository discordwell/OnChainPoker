# Agent 1: New Chain Implementation

## Defaults

- Bech32 prefix: `ocp`
- Base denom: `uocp`
- Home dir: `~/.ocpd`

These are defined in:
- `apps/cosmos/app/params/params.go`
- `apps/cosmos/cmd/ocpd/cmd/root.go` (sets `sdk.DefaultBondDenom` and Bech32 prefixes)
- `apps/cosmos/cmd/ocpd/cmd/commands.go` (defaults `app.toml` `minimum-gas-prices` to `0uocp`)

## Legacy Amino Msg Names (Ledger Constraint)

Cosmos SDK `legacy.RegisterAminoMsg` enforces **message type names <40 chars** (ledger nano signing constraint),
and go-amino can panic on rare prefix collisions.

For custom modules we use short, stable names:
- `ocp/poker/*` in `apps/cosmos/x/poker/types/codec.go`
- `ocp/dealer/*` in `apps/cosmos/x/dealer/types/codec.go`

## Adding Custom Modules (x/poker, x/dealer)

Edit `apps/cosmos/app/app_config.go`:

- Add module configs to `ModuleConfig`.
- Update `runtime` module ordering:
  - `BeginBlockers` / `EndBlockers`
  - `InitGenesis` / `ExportGenesis`
- Add module accounts/permissions if you introduce escrow/module accounts.
- If module params depend on the chain denom, prefer using `sdk.DefaultBondDenom` or plumb the denom via your module's params.

App wiring:
- Prefer depinject wiring (module `ProvideModule`) over manual `RegisterStores`/`RegisterModules` in `apps/cosmos/app/app.go` to avoid duplicate store keys.

## Poker Seats Encoding (Important)

Protobuf marshalling rejects `nil` elements inside repeated message fields, so `Table.seats` **cannot** contain `nil` entries in stored state or query responses.

Current convention:
- `Table.seats` is always length 9
- An "empty" seat is a `Seat{ player: "" }` (and other fields zeroed)

Implication for clients (Agent 6):
- When decoding `QueryTableResponse`, treat seats with missing/empty `player` as empty seats (not "occupied").

## Agent 4: Stake-based committee

- Stake-weighted committee sampling utilities live in `apps/cosmos/x/dealer/committee` (`RandEpochOrDevnet` + weighted sampling from bonded validators; can return selected member power + consensus pubkey snapshot for later slashing/signature checks).

## Agent 5: Integrate Staking with slashing/jailing

- Helper + interfaces are in:
  - `apps/cosmos/x/dealer/types/expected_keepers.go`
  - `apps/cosmos/x/dealer/keeper/penalty.go`
- Intended call site is `x/dealer` fault resolution: slash + jail the validator via `x/slashing`/`x/staking`, using a stored `distributionHeight` and `powerAtDistributionHeight` captured at committee selection time.

Dealer penalty economics are on-chain params:
- `Query/Params`: `GET /onchainpoker/dealer/v1/params`
- `MsgUpdateParams`: authority-controlled param updates (defaults to `x/gov` module account)

## Agent 3: Port Game Logic Into Cosmos Modules

- `x/poker` now uses real `x/bank` coins escrowed in module account `poker` (buy-ins + player bonds), and drives the poker state machine.
- `x/dealer` is implemented with:
  - DKG epochs (BeginEpoch, DkgCommit, complaints/reveals, FinalizeEpoch, DkgTimeout) with stake-weighted committee sampling and power snapshots.
  - Per-hand dealing/shuffle/reveal (InitHand, SubmitShuffle, FinalizeDeck, SubmitEncShare, SubmitPubShare, FinalizeReveal, Timeout).
  - Validator penalties routed through `keeper.SlashAndJailValidator` using `distributionHeight` snapshots.
- Cross-module surface:
  - `x/dealer` depends on `types.PokerKeeper` (see `apps/cosmos/x/dealer/types/expected_keepers.go`).
  - `x/poker/keeper` now exposes:
    - `AbortHandRefundAllCommits`
    - `ApplyDealerReveal`
    - `AdvanceAfterHoleSharesReady`
- Wiring:
  - Module config protos added under `apps/cosmos/proto/onchainpoker/{poker,dealer}/module/v1`.
  - `apps/cosmos/app/app_config.go` updated to include both modules + poker module account perms + block external sends to `poker`.

