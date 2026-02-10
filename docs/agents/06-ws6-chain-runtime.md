# WS6: Chain Runtime / App Implementation (One-Shot Brief)

## Goal

Scaffold the appchain runtime and implement the PokerTable and Dealer modules with the interfaces in `docs/INTERFACES.md`.

## Inputs

- `docs/SPEC.md` full
- `docs/INTERFACES.md`

## Deliverables

- New app directory: `apps/chain`
- Pick a framework:
  - Option A: CometBFT + ABCI app (Go or Rust)
  - Option B: Cosmos SDK module set (Go)
  - Option C: Substrate pallet runtime (Rust, no_std constraints)
  - Choose one and record rationale in `apps/chain/README.md`.
- Implement v0 runtime:
  - `Bank` + simple accounts
  - `PokerTable` state machine (WS1)
  - Dealer *stub* with public dealing first (to validate hand flow)
- Define tx types and events (WS7 will consume).

### Concrete v0 Scope (Recommended)

Target an end-to-end playable flow with **public dealing**:

- `Bank`:
  - `bank/mint` (devnet only; validator-signed)
  - `bank/send`
- `PokerTable`:
  - `poker/create_table`
  - `poker/sit`
  - `poker/start_hand`
  - `poker/act` (v0: check/call/fold + simple bet/raise semantics)
- `DealerStub`:
  - deterministic deck shuffle per hand (insecure; public dealing)
  - hole cards emitted publicly as events (until WS3/WS4/WS5 land)
  - NOTE: now gated behind `OCP_UNSAFE_ALLOW_DEALER_STUB=1` and disabled by default.

For v0, it’s acceptable that:

- txs are JSON-encoded bytes (not protobuf/SCALE),
- tx auth is minimal (ed25519 + nonce replay protection) and devnet-focused,
- showdown is a placeholder evaluator (WS2 will replace).

### Localnet + Acceptance Harness

Include:

- `apps/chain/scripts/localnet.sh`: builds tools and starts a 1-node localnet.
- `apps/chain/scripts/play_hand.mjs`: scripted 2-player hand driver against CometBFT RPC.

## Acceptance Tests

- Local devnet boots and produces blocks.
- Scripted full hand executes end-to-end.
  - Preferred: dealer-mode script (`scripts/play_hand_dealer.mjs`).
  - Optional (insecure): public dealing stub if the chain is started with `OCP_UNSAFE_ALLOW_DEALER_STUB=1`.

## Notes

Keep crypto-heavy verification behind a module boundary so we can swap in precompiles / host functions later if needed.
