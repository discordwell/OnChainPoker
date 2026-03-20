# OnChainPoker — Architecture

> Provably fair poker on a purpose-built Cosmos SDK appchain.

Every deal uses threshold cryptographic shuffling so no single validator can see unrevealed cards. All chip movement is settled on-chain.

---

## System Overview

OnChainPoker is a monorepo containing a custom Cosmos SDK blockchain, supporting infrastructure services, a cryptographic library suite, and a browser-based poker client. The system guarantees fairness through distributed key generation, verifiable shuffles, and threshold decryption — eliminating the need to trust any single party with knowledge of the deck.

---

## Component Map

### Applications (`apps/`)

| Directory | Language | Description |
|---|---|---|
| `apps/cosmos` | Go | Purpose-built Cosmos SDK appchain. Contains the `x/poker` module (table management, betting, hand lifecycle) and the `x/dealer` module (DKG, shuffle, card encryption/decryption). Produces the `ocpd` binary. |
| `apps/coordinator` | TypeScript | Untrusted relay service. Bridges chain events to WebSocket for the frontend, provides a REST API, manages seat intents, and hosts a faucet. Does **not** handle game logic — all game state is authoritative on-chain. |
| `apps/dealer-daemon` | TypeScript | Validator sidecar. Each validator runs an instance to participate in threshold cryptographic operations: DKG key generation, shuffle proofs, and encrypted share distribution. |
| `apps/web` | TypeScript (React) | Dark casino-themed poker room with Keplr wallet integration, real-time table state via WebSocket, hole card decryption, and on-chain verification links. |
| `apps/bot` | TypeScript | Automated poker bot with configurable strategy profiles (LAG, TAG, calling station). Used for load testing and maintaining table activity. |
| `apps/sim` | TypeScript | Deterministic simulator for Byzantine fault scenario testing. |

### Packages (`packages/`)

| Package | Description |
|---|---|
| `packages/poker-engine` | Deterministic 9-max No-Limit Hold'em state machine. Handles timeouts, side pots, and action validation. |
| `packages/holdem-eval` | Hand evaluator. 7-card evaluation, tiebreakers, and showdown settlement. |
| `packages/ocp-crypto` | ElGamal encryption, Chaum-Pedersen proofs, and group operations on Ristretto255. |
| `packages/ocp-shuffle` | Verifiable shuffle protocol implementation. |
| `packages/dkg` | Distributed key generation with complaint-based share distribution. |
| `packages/ocp-sdk` | Client SDK. CosmJS signing client, LCD queries, protobuf registry, and event parsing. |

---

## Data Flow

```
  Player (Browser)
    |
    ├── Keplr Wallet ──── signs Cosmos txs ────────────────────┐
    |                                                          │
    ├── Web App ── subscribes to coordinator WebSocket ──┐     │
    |                                                    │     │
    |                                                    │     ▼
    |                                              Coordinator ◄──── Cosmos Chain
    |                                              (relay)           (x/poker, x/dealer)
    |                                                    │                │
    |                                                    │       Validator Nodes
    └──────── receives WS events ◄───────────────────────┘       + Dealer Daemons
                                                                 (DKG, shuffle, enc shares)
```

**Transaction path:** The player's browser signs a Cosmos transaction via Keplr and broadcasts it directly to the chain. The `x/poker` and `x/dealer` modules process the transaction, update on-chain state, and emit events.

**Event path:** The coordinator indexes chain events and pushes them over WebSocket to connected clients. The coordinator is *untrusted* — it cannot forge game state because all state is verified on-chain. If the coordinator lies, clients can query the chain directly.

**Cryptographic path:** Validator-run dealer daemons watch for on-chain dealing requests, participate in DKG rounds, perform their shuffle pass, and publish encrypted card shares back to the chain.

---

## Cryptographic Pipeline

The dealing protocol runs in six stages:

1. **DKG (Distributed Key Generation)** — At the start of each epoch, validators execute a complaint-based DKG to produce a shared public key. No single validator holds the full private key; each holds only a share.

2. **Shuffle** — When a hand begins, the deck is represented as a vector of ElGamal ciphertexts. Each participating validator re-encrypts and permutes the deck, publishing a zero-knowledge shuffle proof that the operation was performed correctly.

3. **Encrypted Shares** — After the final shuffle, per-card encrypted shares are distributed. Each card's decryption requires a threshold number of validator shares.

4. **Hole Card Recovery** — A player decrypts their hole cards locally using their private key combined with the validator-provided shares via Lagrange interpolation. Only the card holder can perform this decryption.

5. **Board Reveal** — Community cards (flop, turn, river) are revealed through threshold decryption: enough validators publish their decryption shares for the designated board cards, and any observer can reconstruct the plaintext.

6. **Showdown** — Remaining players' hole cards are revealed. The `holdem-eval` package determines the winner(s), and the `x/poker` module atomically settles chips from the pot.

---

## Security Model

| Property | Mechanism |
|---|---|
| **Threshold trust** | Honest majority of validators (fewer than *t* Byzantine) ensures no party can see unrevealed cards. |
| **On-chain escrow** | All chips are held in Cosmos SDK module accounts. Settlement is atomic within a single transaction. |
| **Verifiable operations** | Shuffle proofs (zero-knowledge) and encryption proofs (Chaum-Pedersen) are publicly verifiable by any observer. |
| **Slashable misbehavior** | Validators who fail to participate in dealing rounds within the timeout window are subject to penalties. |
| **Client-side verification** | The frontend can independently verify any game event against on-chain state. The coordinator is a convenience layer, not a trust anchor. |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Blockchain** | Cosmos SDK v0.54, CometBFT consensus |
| **Chain language** | Go 1.22+ |
| **Cryptography** | Ristretto255 (curve25519), ElGamal threshold encryption, Chaum-Pedersen proofs |
| **Frontend** | React 19, TypeScript, Vite |
| **Wallet** | Keplr (`experimentalSuggestChain`) |
| **Coordinator** | Node.js, WebSocket, REST |
| **Monorepo tooling** | pnpm workspaces |
| **CI/CD** | GitHub Actions |

---

## Deployment Topology

```
                  ┌─────────────────────────────────┐
                  │         Validator Node           │
                  │  ┌───────────┐  ┌─────────────┐ │
                  │  │   ocpd    │  │ dealer-daemon│ │
                  │  │ (CometBFT)│  │  (sidecar)   │ │
                  │  └───────────┘  └─────────────┘ │
                  └─────────────────────────────────┘
                              × N validators

                  ┌─────────────────────────────────┐
                  │        Coordinator (1+)          │
                  │   chain indexer + WS + REST      │
                  │   faucet (testnet only)          │
                  └─────────────────────────────────┘

                  ┌─────────────────────────────────┐
                  │     Web App (static deploy)      │
                  │   React SPA served via CDN/VPS   │
                  └─────────────────────────────────┘
```

Each validator runs `ocpd` (the chain node) alongside a `dealer-daemon` sidecar that handles the cryptographic dealing duties. The coordinator is a stateless relay that can be horizontally scaled. The web app is a static single-page application.
