# Coordinator Cosmos Adapter Notes (Agent 6)

This app supports multiple chain adapters:

- `mock` (tests/dev)
- `comet` (v0 ABCI scaffold, JSON via `abci_query`)
- `cosmos` (Cosmos SDK chain, LCD + Tendermint WS)

## Cosmos Mode

Set:

- `COORDINATOR_CHAIN_ADAPTER=cosmos`
- `COORDINATOR_COSMOS_RPC_URL` (default `http://127.0.0.1:26657`) for Tendermint WS subscription (`/websocket`)
- `COORDINATOR_COSMOS_LCD_URL` (default `http://127.0.0.1:1317`) for JSON queries (grpc-gateway / API server)

Query routes expected (grpc-gateway, to be implemented by x/poker):

- `GET /onchainpoker/poker/v1/tables`
- `GET /onchainpoker/poker/v1/tables/{table_id}`

Event routing expectation:

- Events should include `tableId` (and optionally `handId`) as attributes.

More context: `/Users/discordwell/Projects/OnChainPoker/sync.md`.
