# Coordinator (WS8)

Optional, **untrusted** coordinator service that improves UX without affecting correctness:

- table discovery / lobby views,
- seating intents (matchmaking hints),
- WebSocket event push (relay of chain events),
- artifact relay + caching (dealer artifacts).

If the coordinator is down or malicious, clients MUST still function via direct chain queries.

## Quickstart

```bash
pnpm coordinator:dev
```

Default address: `http://127.0.0.1:8788`

## API (v1)

- `GET /health`
- `GET /v1/tables`
- `POST /v1/seat-intents`
- `GET /v1/seat-intents?tableId=...`
- `PUT /v1/artifacts/:artifactId`
- `GET /v1/artifacts/:artifactId`
- `GET /v1/appchain/v0/tables/:tableId` (raw v0 `/table/<id>` view; Comet adapter only)
- `GET /v1/appchain/v0/dealer/epoch` (raw v0 `/dealer/epoch`; Comet adapter only)
- `GET /v1/appchain/v0/tables/:tableId/dealer/next` (suggests next dealer step; Comet adapter only)
- `POST /v1/appchain/v0/artifacts/shuffle` (store shuffle proof by sha256; Comet adapter only)
- WebSocket: `ws://HOST:PORT/ws`

For local development with the `mock` chain adapter only:

- `POST /_dev/mock/tables`
- `POST /_dev/mock/events`

## Env Vars

See `.env.example`.

To run against the local appchain (`apps/chain` localnet):

```bash
COORDINATOR_CHAIN_ADAPTER=comet COORDINATOR_COMET_RPC_URL=http://127.0.0.1:26657 pnpm coordinator:dev
```
