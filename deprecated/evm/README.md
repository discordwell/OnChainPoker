# Deprecated: EVM Prototype (Do Not Use)

This folder contains the legacy EVM prototype that was used early in the project:

- `packages/contracts`: Hardhat + Solidity (token + `PokerVault` escrow / signed settlement).
- `apps/web`: web UI that talks to the EVM contracts.
- `scripts/*`: Hardhat localnet/dev helpers.
- `packages/ocp-sdk/src/evm`: EVM client helpers (archived).

Status: **DEPRECATED** (as of 2026-02-09).

It is kept only for historical reference. It is **not** part of the active workspace, is **not** run in CI, and should not be extended for new work.

Active development is on the appchain runtime and protocol:

- Chain runtime: `apps/chain`
- Poker state machine: `packages/poker-engine`
- Client SDK (appchain): `packages/ocp-sdk/src/appchain`
- Specs: `docs/SPEC.md`, `docs/PROTOCOL.md`, `docs/INTERFACES.md`

