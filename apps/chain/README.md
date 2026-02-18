# OCP Chain (WS6)

This directory contains the v0 appchain scaffold for OnChainPoker.

## Important: Production Status

`apps/chain` is **legacy, devnet-only** and must not be used as a production runtime target.

Use `apps/cosmos` for production-path development and deployments.

## Framework Choice

Chosen: **Option A: CometBFT + ABCI app (Go)**.

Rationale:

- Minimal surface area for a v0 "runtime" while keeping a clear path to a richer SDK later.
- Lets us iterate on `PokerTable` / `Dealer` module boundaries without committing to Cosmos SDK or Substrate constraints.
- CometBFT provides consensus + RPC; the app implements deterministic state transitions via ABCI.

## Status (v0)

- `Bank`: simple accounts + transfers (devnet only; no auth/signature checks yet)
- `PokerTable`: table lifecycle + a minimal hand driver
- `DealerStub`: **public dealing** (hole cards are not private) to validate hand flow end-to-end
- `Staking`: stub (static validator set from CometBFT genesis)

This is intentionally "v0": it exists to unblock WS7 integration and to provide a stable place to wire WS1/WS2/WS3/WS4/WS5 later.

## Quickstart (Local Devnet)

Prereqs:

- Go (installed via Homebrew: `brew install go`)

Start node + app:

```bash
OCP_CHAIN_PROFILE=devnet bash apps/chain/scripts/localnet.sh
```

Or use the repo shortcut:

```bash
pnpm dev
```

Run a scripted hand (in another terminal):

```bash
node apps/chain/scripts/play_hand.mjs
```

## Tx Format (v0)

Transactions are UTF-8 JSON bytes broadcast via CometBFT RPC. Shape:

```json
{ "type": "poker/create_table", "value": { ... } }
```

See `apps/chain/internal/codec/tx.go` for the concrete schemas.

## Events

ABCI events follow `docs/INTERFACES.md` naming where possible.

Event types emitted in v0:

- `TableCreated`
- `PlayerSat`
- `HandStarted`
- `StreetRevealed`
- `ActionApplied`
- `HandCompleted`

All include `tableId` and (when applicable) `handId` attributes.
