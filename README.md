# OnChainPoker

Decentralized poker game built on blockchain technology.

## Overview

OnChainPoker is a blockchain-based poker platform that enables trustless, transparent gameplay with cryptocurrency integration.

## Status

🚧 **Project in development**

## Tech Stack (Planned)

- Smart Contracts: Solidity
- Blockchain: Ethereum/Polygon
- Frontend: React + Web3.js
- Backend: Node.js
- Game Engine: Custom poker logic

## Repo Layout

- `packages/contracts`: Hardhat + Solidity contracts
  - `OCPToken` (ERC-20): owner-mintable platform token
  - `PokerVault`: escrow + internal ledger for off-chain dealt poker (EIP-712 signatures required to apply zero-sum hand results)
- `apps/web`: wallet UI (connect/approve/deposit/withdraw + sign/submit hand results)
- `docs/SPEC.md`: appchain spec for confidential on-chain dealing (draft)
- `docs/WORKSTREAMS.md` + `docs/agents/`: parallel build plan + 10 one-shot agent briefs

## Quickstart

```bash
# Hardhat recommends Node 22 LTS (see `.nvmrc`)
pnpm install
pnpm contracts:compile
pnpm contracts:test
```

## One-Command Local Dev (Localnet + Web)

```bash
pnpm dev
```

This will:

- start a Hardhat node (if one isn't already running)
- deploy contracts to localnet
- write `apps/web/.env.local` from the latest `deployments/*.json`
- start the web dev server

You can override the RPC URL/port with `OCP_RPC_URL` (default: `http://127.0.0.1:8545`).

### Local Deploy

Terminal 1:

```bash
pnpm -C packages/contracts node
```

Terminal 2:

```bash
pnpm -C packages/contracts deploy:local
```

Deployments are also written to `deployments/<network>-<chainId>.json`.

### Web App

Set `VITE_TOKEN_ADDRESS` and `VITE_VAULT_ADDRESS` in `apps/web/.env` (see `apps/web/.env.example`), then:

```bash
pnpm web:dev
```

## Tests

```bash
pnpm test
pnpm test:integration
```

### Polygon Amoy Deploy

Set `PRIVATE_KEY` and (optionally) `AMOY_RPC_URL` in `.env` (see `.env.example`), then:

```bash
pnpm contracts:deploy:amoy
```

### Appchain Localnet (Draft)

The confidential-dealing design lives in `docs/SPEC.md`. A v0 CometBFT + ABCI scaffold (public-dealing stub) is in `apps/chain`.

```bash
apps/chain/scripts/localnet.sh
node apps/chain/scripts/play_hand.mjs
```

## License

MIT
