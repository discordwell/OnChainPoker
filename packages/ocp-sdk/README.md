# @onchainpoker/ocp-sdk

WS7 client protocol + SDK.

## v0 Localnet (CometBFT + ABCI)

The current devnet implementation lives in `apps/chain` and uses CometBFT JSON-RPC.

The SDK exposes `OcpV0Client` which can:

- broadcast v0 JSON tx envelopes via `broadcast_tx_commit`
- query state via `abci_query`
- (optionally) subscribe to tx results over WebSocket

### Run The Scripted Hand

Terminal 1:

```bash
apps/chain/scripts/localnet.sh
```

Terminal 2:

```bash
pnpm sdk:build
pnpm ws7:play_hand
```

