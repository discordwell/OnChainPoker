# OnChainPoker

Provably fair poker on a purpose-built Cosmos blockchain. Every deal is verifiable. Every chip is on-chain.

## What Makes This Different

- **Threshold cryptographic dealing** — No single validator can see unrevealed cards. The deck is encrypted, shuffled, and revealed through a multi-party protocol with verifiable proofs.
- **On-chain escrow and settlement** — All chip movement is recorded and settled on the blockchain. No custodial risk, no house edge manipulation.
- **Chain verification** — Players can independently verify that the coordinator is honest by comparing its data against direct chain queries.
- **Purpose-built appchain** — Not a smart contract on a general-purpose chain. OnChainPoker is a Cosmos SDK appchain with custom modules (`x/poker`, `x/dealer`) optimized for poker.

## Live Demo

**[Play on Testnet](https://discordwell.com/ocp)**

Connect a Keplr wallet, grab free testnet CHIPS from the faucet, and sit at a table. Bots keep tables active so you can jump in immediately.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system overview, data flow diagrams, and crypto pipeline.

**Key components:**

| Component | Description | Language |
|-----------|------------|----------|
| `apps/cosmos` | Purpose-built Cosmos SDK appchain (`ocpd`) | Go |
| `apps/coordinator` | Untrusted relay service (REST + WebSocket) | TypeScript |
| `apps/dealer-daemon` | Validator sidecar for threshold crypto operations | TypeScript |
| `apps/web` | Dark casino-themed poker room frontend | React/TS |
| `apps/bot` | Automated poker bots (LAG, TAG strategies) | TypeScript |
| `packages/poker-engine` | Deterministic 9-max NLH state machine | TypeScript |
| `packages/holdem-eval` | Hand evaluator with tiebreakers | TypeScript |
| `packages/ocp-crypto` | ElGamal encryption, Chaum-Pedersen proofs | TypeScript |
| `packages/ocp-shuffle` | Verifiable shuffle protocol | TypeScript |
| `packages/dkg` | Distributed key generation | TypeScript |
| `packages/ocp-sdk` | Client SDK (CosmJS, protobuf, events) | TypeScript |

## Tech Stack

**Chain:** Cosmos SDK, CometBFT, Go | **Crypto:** Ristretto255, ElGamal threshold encryption | **Frontend:** React 19, TypeScript, Vite | **Wallet:** Keplr | **Monorepo:** pnpm workspaces

## Quickstart

```bash
pnpm install
pnpm test
```

### Run Cosmos Localnet + Scripted Poker Txs

Terminal 1:
```bash
pnpm cosmos:localnet
```

Terminal 2:
```bash
pnpm ws7:play_hand_cosmos
```

This submits poker module txs via CosmJS + protobuf signing and queries state via LCD.

### Run GUI

Terminal 1:
```bash
pnpm coordinator:dev
```

Terminal 2:
```bash
pnpm web:dev
```

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — System overview, data flow, crypto pipeline
- [docs/SPEC.md](./docs/SPEC.md) — Full protocol specification (RFC-style)
- [docs/PROTOCOL.md](./docs/PROTOCOL.md) — Client protocol definition
- [docs/INTERFACES.md](./docs/INTERFACES.md) — API surface and module boundaries

## Status

Testnet. Actively developed.

## License

[MIT](./LICENSE)
