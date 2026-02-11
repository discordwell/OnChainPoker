# OnChainPoker

Poker-specific appchain prototype (CometBFT + ABCI) with a deterministic on-chain table state machine and (in-progress) confidential dealing.

## Status

Draft / in development.

## EVM Prototype (Deprecated)

The original Hardhat/EVM prototype has been moved to `deprecated/evm` and is not part of the active workspace or CI.
New work should target the appchain runtime + protocol (`apps/chain`, `docs/SPEC.md`, `packages/*`).

## Repo Layout

- `apps/chain`: v0 appchain scaffold (Go, CometBFT + ABCI)
- `apps/cosmos`: Cosmos SDK chain scaffold (Go, ocpd)
- `apps/coordinator`: optional untrusted coordinator (UX only)
- `apps/sim`: deterministic simulator + byzantine scenarios
- `packages/poker-engine`: deterministic 9-max NLH state machine (timeouts, side pots, etc)
- `packages/holdem-eval`: Hold'em evaluator (showdown settlement primitive)
- `packages/ocp-crypto`, `packages/dkg`, `packages/ocp-shuffle`: crypto building blocks (v1 direction)
- `packages/ocp-sdk`: client SDK for tx/query/events against the appchain
- `docs/SPEC.md`, `docs/PROTOCOL.md`, `docs/INTERFACES.md`: protocol/spec/interfaces
- `docs/WORKSTREAMS.md` + `docs/agents/`: parallel build plan + one-shot briefs

## Quickstart

```bash
pnpm install
pnpm test
```

## Run Local Appchain + Scripted Hand

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

## Run Cosmos Localnet + Scripted Poker Txs

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
