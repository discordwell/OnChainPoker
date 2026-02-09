# Code Audit Notes (WIP)

Status: WIP (started 2026-02-09)

Scope (active code):

- Appchain runtime: `apps/chain`
- Core libraries: `packages/poker-engine`, `packages/holdem-eval`, `packages/ocp-crypto`, `packages/dkg`, `packages/ocp-shuffle`
- Client SDK (appchain): `packages/ocp-sdk/src/appchain`
- Coordinator (untrusted UX): `apps/coordinator`

Out of scope:

- Deprecated EVM prototype (archived under `deprecated/evm`)

## High-Risk Areas To Review

- Tx authentication + replay protection (account/validator keys, nonce rules): `apps/chain/internal/app/auth.go`
- Funds accounting invariants (chip conservation, escrow/commit/side pots): `apps/chain/internal/app/poker.go`, `packages/poker-engine`
- Deterministic timeouts + liveness (player actions, dealer steps): `docs/SPEC.md` 5.5, `apps/chain/internal/app/dealer.go`
- Dealer artifact validation + slashing rules: `apps/chain/internal/app/dealer.go`, `docs/SPEC.md` 6-8
- Abort/refund semantics and anti-griefing: `docs/SPEC.md` 8
- Coordinator attack surface (must never become correctness-critical): `apps/coordinator`, `apps/coordinator/THREATS.md`

## Known Gaps / TODOs

- Player action timeouts are specified but not yet wired in the v0 chain runtime:
  - `actionTimeoutSecs` is accepted/stored, but there is no `PokerTable.Tick` tx in v0.
- `bank/mint` is devnet-only and currently unauthenticated; MUST NOT exist in production builds.

