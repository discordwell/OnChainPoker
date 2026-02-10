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

- Player action timeouts (`docs/SPEC.md` 5.5) are now wired in v0:
  - `poker/tick` applies deterministic default actions once `hand.actionDeadline` passes.
  - `actionTimeoutSecs` is enforced via `hand.actionDeadline` (unix seconds).
- Player bonds are now partially enforced in v0 (anti-grief / devnet):
  - `playerBond` is debited on `poker/sit` and stored as `seat.bond`.
  - `poker/tick` slashes bond on timeouts and emits `PlayerSlashed`.
  - Seats with depleted bond are ejected between hands (`PlayerEjected`) and remaining stack is returned to bank balance.
- `bank/mint` is devnet-only and now requires a validator-signed tx.
  - Important: v0 staking/validator registration is still a stub and not tied to consensus, so "validator-signed" is not a production-grade authorization boundary yet.
  - `bank/mint` MUST NOT exist in production builds.
