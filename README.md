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

## Quickstart

```bash
# Hardhat recommends Node 22 LTS (see `.nvmrc`)
pnpm install
pnpm contracts:compile
pnpm contracts:test
```

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

### Polygon Amoy Deploy

Set `PRIVATE_KEY` and (optionally) `AMOY_RPC_URL` in `.env` (see `.env.example`), then:

```bash
pnpm contracts:deploy:amoy
```

## License

MIT
