# Parallel Build Workstreams (v1)

Date: 2026-02-08
Status: Draft (execution is Cosmos-first)

This repo previously contained an EVM prototype; it has been archived under `deprecated/evm`.
The non-negotiable "contract is the dealer and nobody can know unrevealed cards" requirement implies a specialized chain runtime (see `docs/SPEC.md`).
Current runtime direction is `apps/cosmos` (production path); `apps/chain` remains legacy devnet-only scaffolding.
This document decomposes the build into parallelizable workstreams with crisp interfaces.

## Global Constraints (Must Hold Across All Tracks)

- Source of truth is the chain state machine. No off-chain settlement.
- Confidentiality is threshold-based: no single validator learns unrevealed cards; confidentiality breaks only if adversary controls >= `t` dealer committee members.
- 9-max NLH cash games only in v1.
- Mid-hand slashing/removal must not halt the hand unless threshold `t` can no longer be reached.

## Stable Interfaces (Key Decoupling Points)

Implementations MUST treat these as contracts between tracks:

- `PokerTable <-> Dealer` interface: how the table requests deck creation, hole-card delivery, and board reveals, and how the Dealer returns proofs/artifacts.
- `Tx/Event schema`: the canonical transaction types + events clients consume.
- `Crypto transcript formats`: byte serialization of group elements, scalars, proofs, and domain separation tags.

Start from `docs/INTERFACES.md`.

## Workstreams (5-10 Agents)

Each workstream below can be developed largely independently if it adheres to the stable interfaces.

1. **WS1: Poker State Machine + Pot/Side Pots**
   - Output: deterministic 9-max NLH state transition library + test corpus.
   - Must include: legal actions, bet sizing rules, all-in, side pots, timeouts, hand completion rules.
   - Acceptance: invariant tests (chip conservation), exhaustive edge-case suite for side pots.

2. **WS2: Hand Evaluation (Showdown)**
   - Output: 7-card hand evaluator (Hold'em) + deterministic winner resolution (including ties, split pots).
   - Acceptance: test vectors (known hands), randomized cross-check vs reference implementation.

3. **WS3: Crypto Primitives Library**
   - Output: group abstraction, hashing, ElGamal, Chaum-Pedersen proofs, Fiat-Shamir transcript rules.
   - Acceptance: known-answer tests, negative tests (invalid proofs rejected), serialization round-trips.

4. **WS4: Threshold Keying (DKG) + Per-Hand Key Derivation**
   - Output: DKG protocol spec + implementation plan; per-hand derived keys (`PK_hand`, `sk_i_hand`) and evidence/slashing conditions.
   - Acceptance: simulated DKG with honest + byzantine participants; transcript verification; deterministic derivation.

5. **WS5: Verifiable Shuffle Proofs**
   - Output: pick a concrete shuffle proof system and specify proof statement, prover, verifier, and on-chain verification cost model.
   - Acceptance: verifier implementation + benchmarks for 52-card decks and committee sizes in target range.

6. **WS6: Chain Runtime / App Implementation**
   - Output: production Cosmos runtime (`apps/cosmos`) with `x/poker` + `x/dealer`, plus localnet/multinet orchestration.
   - Legacy note: `apps/chain` remains devnet-only scaffold for fast prototyping.
   - Acceptance: local Cosmos network spins up; can run a full confidential dealer hand end-to-end.
     - Required: `pnpm cosmos:dealer:e2e` (3-node multinet).
     - Legacy smoke (optional): `pnpm ws7:play_hand_dealer` on `apps/chain` devnet.

7. **WS7: Client Protocol + SDK**
   - Output: typed client SDK for tx submission, event subscription, and share retrieval/decryption.
   - Acceptance: integration test against local devnet; can play a scripted hand end-to-end.

8. **WS8: Coordinator (Untrusted)**
   - Output: optional service for matchmaking, table discovery, push notifications, artifact relay/caching.
   - Acceptance: coordinator outage does not break correctness (only UX).

9. **WS9: Simulation + Byzantine/Grief Testing**
   - Output: deterministic simulator that can inject faults (withholding shares, invalid proofs, timeouts) and validate chain invariants.
   - Acceptance: scenario suite covering abort/refund, mid-hand slashing, committee rotation, and threshold failure.

10. **WS10: DevEx / CI / Localnet Tooling**
   - Output: scripts to run Cosmos localnet/multinet + web + coordinator; CI for unit/integration tests; basic benchmarks.
   - Acceptance: single command to run the full stack locally; CI green on main; failing Cosmos E2E jobs publish multinet logs/artifacts.

## Suggested Execution Order (To Reduce Rework)

- First: WS1 + WS2 + WS7 (define poker + protocol contract)
- In parallel: WS3 + WS4 + WS5 (crypto core)
- Then: WS6 (runtime integration)
- Throughout: WS9 + WS10 (tests and tooling)

## Agent Briefs

One-shot briefs are in `docs/agents/`.
