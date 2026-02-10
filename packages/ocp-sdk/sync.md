# OCP SDK Cosmos Boundary Notes (Agent 6)

## Current State

`packages/ocp-sdk` has:

- v0 client (`OcpV0Client`) that talks to the legacy CometBFT+ABCI JSON envelope chain in `apps/chain`.
- Cosmos scaffolding for CosmJS:
  - `CosmosLcdClient` (grpc-gateway JSON)
  - `walletFromMnemonic`
  - `connectOcpCosmosSigningClient` (sequence, gas/fees, `SIGN_MODE_DIRECT`)
- TS-generated OCP protobuf types (from `apps/cosmos/proto`) under `src/cosmos/gen/`
- `createOcpRegistry` + `OCP_TYPE_URLS` for registering/signing OCP `Msg*` types with CosmJS
- `createOcpCosmosClient` (convenience wrapper):
  - poker tx helpers: `pokerCreateTable`, `pokerSit`, `pokerStartHand`, `pokerAct`, `pokerTick`, `pokerLeave`
  - dealer tx helpers: `dealerBeginEpoch`, `dealerDkg*`, `dealerInitHand`, `dealerSubmit*`, `dealerFinalize*`, `dealerTimeout`
  - LCD queries: `getTables`, `getTable`, `getDealerEpoch`, `getDealerDkg`, `getDealerHand`
  - event parsing helpers for `DeliverTxResponse` (`parseTableIdFromTx`, `parseHandIdFromTx`)

## Remaining (Optional)

- Event subscription helper (Tendermint WS `tm.event='Tx'`) packaged for SDK consumers (coordinator already has a Cosmos WS adapter).
- More opinionated query normalization (seat empty encoding, bigint helpers, etc.) once the proto/json shapes stabilize.

More context: `/Users/discordwell/Projects/OnChainPoker/sync.md`.

## Proto TS Generation

TS codegen template:

- `/Users/discordwell/Projects/OnChainPoker/apps/cosmos/proto/buf.gen.ts.yaml`

Output folder:

- `/Users/discordwell/Projects/OnChainPoker/packages/ocp-sdk/src/cosmos/gen/`
