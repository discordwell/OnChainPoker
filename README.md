# OnChainPoker

Poker protocol stack with a production Cosmos SDK chain path (`apps/cosmos`) and a legacy CometBFT+ABCI v0 devnet scaffold (`apps/chain`) for fast local prototyping.

## Status

Draft / in development.

## Target Runtime

- **Production target:** `apps/cosmos` (Cosmos SDK)
- **Legacy/devnet only:** `apps/chain` (CometBFT + ABCI scaffold)

## EVM Prototype (Deprecated)

The original Hardhat/EVM prototype has been moved to `deprecated/evm` and is not part of the active workspace or CI.

## Repo Layout

- `apps/cosmos`: production chain implementation (Go, `ocpd`)
- `apps/chain`: v0 devnet-only scaffold (CometBFT + ABCI)
- `apps/coordinator`: optional untrusted coordinator (UX only)
- `apps/sim`: deterministic simulator + Byzantine scenarios
- `packages/poker-engine`: deterministic 9-max NLH state machine (timeouts, side pots, etc)
- `packages/holdem-eval`: Hold'em evaluator (showdown settlement primitive)
- `packages/ocp-crypto`, `packages/dkg`, `packages/ocp-shuffle`: crypto building blocks (v1 direction)
- `packages/ocp-sdk`: client SDK for tx/query/events
- `docs/SPEC.md`, `docs/PROTOCOL.md`, `docs/INTERFACES.md`: protocol/spec/interfaces
- `docs/WORKSTREAMS.md` + `docs/agents/`: parallel build plan + one-shot briefs

## Quickstart

```bash
pnpm install
pnpm test
```

## Run Cosmos Localnet + Scripted Poker Txs (Preferred / Production Path)

Terminal 1:

```bash
pnpm cosmos:localnet
```

Terminal 2:

```bash
pnpm ws7:play_hand_cosmos
```

This submits poker module txs via CosmJS + protobuf signing and queries state via LCD.
Note: progressing past `HAND_PHASE_SHUFFLE` requires validator-signed `x/dealer` messages (committee/dealer pipeline).

## Run Local Appchain (Legacy, Devnet Only)

Terminal 1:

```bash
pnpm dev
```

Optional (insecure): enable the public dealing stub (DealerStub) for local testing only:

```bash
OCP_UNSAFE_ALLOW_DEALER_STUB=1 pnpm dev
```

Terminal 2:

```bash
pnpm ws7:play_hand_dealer
```

This runs a v0 localnet and plays a simple hand by submitting on-chain transactions.

Optional (insecure): if you started the chain with `OCP_UNSAFE_ALLOW_DEALER_STUB=1`, you can also run the legacy public-dealing driver:

```bash
pnpm ws7:play_hand
```

## Run GUI (Coordinator Control Room)

Terminal 1:

```bash
pnpm coordinator:dev
```

Terminal 2:

```bash
pnpm web:dev
```

Open: `http://127.0.0.1:5173/ocp/`

## Tests

```bash
pnpm test
```

## License

MIT
