# Code Audit Notes (WIP)

Status: WIP (started 2026-02-09)

Scope (active code):

- Production runtime: `apps/cosmos` (`x/poker`, `x/dealer`, localnet/multinet scripts)
- Core libraries: `packages/poker-engine`, `packages/holdem-eval`, `packages/ocp-crypto`, `packages/dkg`, `packages/ocp-shuffle`
- Client SDK: `packages/ocp-sdk/src/cosmos` (+ legacy `src/appchain`)
- Coordinator/Web UX surfaces: `apps/coordinator`, `apps/web`
- Simulation/fault harness: `apps/sim`

Out of scope:

- Deprecated EVM prototype (archived under `deprecated/evm`)
- `apps/chain` correctness hardening for production (legacy devnet-only path)

## High-Risk Areas To Review

- Tx authentication and sequence handling under concurrent writes (Cosmos signing path + faucet tooling): `packages/ocp-sdk/src/cosmos/signing.ts`, `apps/cosmos/scripts/faucet.sh`
- Funds accounting invariants (chip conservation, escrow/commit/side pots): `apps/cosmos/x/poker`, `packages/poker-engine`
- Dealer DKG/reveal liveness windows and timeout semantics: `apps/cosmos/x/dealer`, `scripts/play_hand_cosmos.mjs`
- Dealer artifact validation and slashing evidence handling: `apps/cosmos/x/dealer`, `docs/SPEC.md` 6-8
- Abort/refund semantics and anti-griefing: `docs/SPEC.md` 8, `apps/sim`
- Coordinator attack surface (must never become correctness-critical): `apps/coordinator`, `apps/coordinator/THREATS.md`

## Known Gaps / TODOs

- Recent close-outs (2026-02-18):
  - `pnpm cosmos:dealer:e2e` now passes locally end-to-end (3-node multinet, confidential dealer flow).
  - Cosmos signing client has an LCD fallback path for tx delivery where Comet event decoding is brittle.
  - `play_hand_cosmos` helper logic has targeted regression tests (`scripts/test/play_hand_cosmos_helpers.test.mjs`).
- Still open:
  - `docs/PROTOCOL.md` / `docs/INTERFACES.md` are still marked Draft and include legacy/appchain-v0 context; update to explicitly mark Cosmos-first canonical flow.
  - Strengthen fault-injection coverage for Cosmos dealer deadlines and reveal races (mirror critical scenarios from `apps/sim` at chain integration level).
  - Keep localnet/multinet scripts portable across macOS/Linux shell variants and retain CI failure artifacts for faster triage.
