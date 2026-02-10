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

## Cosmos SDK (In Progress)

Cosmos mode uses protobuf txs (sequence numbers, gas/fees) and grpc-gateway/LCD for JSON queries.

Exports:

- `connectOcpCosmosSigningClient` / `walletFromMnemonic` (CosmJS signing)
- `CosmosLcdClient` (JSON queries against the chain API server)
- `createOcpRegistry` / `OCP_TYPE_URLS` (register + reference OCP protobuf `Msg*` typeUrls)

Example:

```js
import { walletFromMnemonic, connectOcpCosmosSigningClient } from "@onchainpoker/ocp-sdk";

const wallet = await walletFromMnemonic({ mnemonic: process.env.MNEMONIC, prefix: "ocp" });
const { address, signAndBroadcastAuto } = await connectOcpCosmosSigningClient({
  rpcUrl: "http://127.0.0.1:26657",
  signer: wallet,
  gasPrice: "0uocp"
});

console.log({ address });
// await signAndBroadcastAuto([{ typeUrl: "...", value: { ... } }]);
```
