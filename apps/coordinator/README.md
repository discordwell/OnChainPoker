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
- WebSocket: `ws://HOST:PORT/ws`

For local development with the `mock` chain adapter only:

- `POST /_dev/mock/tables`
- `POST /_dev/mock/events`

## Env Vars

See `.env.example`.
