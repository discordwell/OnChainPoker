# OCP Cosmos Chain (Option C)

This directory will contain the Cosmos SDK-based chain implementation (`ocpd`).

## Local Funding Model (No `bank/mint`)

Local/devnet funding is done via:

1. **Genesis accounts**: balances are allocated in `genesis.json`.
2. **Gentx workflow**: validators are created via `gentx` + `collect-gentxs` (single-node localnet still uses this flow).
3. Optional: an **off-chain faucet** (helper script) that does a normal `tx bank send` from a pre-funded `faucet` account.

## Localnet

Start a single-node localnet:

```bash
bash apps/cosmos/scripts/localnet.sh
```

Environment overrides:

- `OCPD_HOME` (default: `apps/cosmos/.ocpd`)
- `OCPD_CHAIN_ID` (default: `ocp-local-1`)
- `OCPD_DENOM` (default: auto-detected from genesis staking `bond_denom`)
- `OCPD_KEYRING_BACKEND` (default: `test`)
- `OCPD_GENTX_STAKE` (default: `10000000`; validator self-delegation for gentx, in base denom units)
- `OCPD_RESET=1` to wipe `OCPD_HOME` and re-init genesis.
- `OCPD_NO_START=1` to initialize genesis + keys but not start the node.
- Port overrides (so you can run multiple nodes side-by-side):
  - `OCPD_RPC_LADDR` (default: `tcp://127.0.0.1:26657`)
  - `OCPD_P2P_LADDR` (default: `tcp://0.0.0.0:26656`)
  - `OCPD_GRPC_ADDRESS` (default: `127.0.0.1:9090`)
  - `OCPD_API_ADDRESS` (default: `tcp://127.0.0.1:1317`)
  - Deprecated aliases: `OCPD_GRPC_ADDR`, `OCPD_API_ADDR`

## Multinet (Multi-Validator Localnet)

Start a local multi-validator network (default: 4 validators). Node0 enables the API server:

```bash
bash apps/cosmos/scripts/multinet.sh
```

Environment overrides:

- `OCPD_MULTI_HOME` (default: `apps/cosmos/.ocpd-multi`)
- `OCPD_NUM_NODES` (default: `4`)
- `OCPD_CHAIN_ID` (default: `ocp-local-1`)
- `OCPD_DENOM` (default: auto-detected from genesis staking `bond_denom`)
- `OCPD_GENTX_STAKE` (default: `10000000`; validator self-delegation for gentx, in base denom units)
- Port bases (node `i` uses `base + i*OCPD_PORT_STEP`):
  - `OCPD_PORT_STEP` (default: `10`)
  - `OCPD_RPC_PORT_BASE` (default: `26657`)
  - `OCPD_P2P_PORT_BASE` (default: `26656`)
  - `OCPD_GRPC_PORT_BASE` (default: `9090`)
  - `OCPD_API_PORT_BASE` (default: `1317`; node0 only)
- `OCPD_RESET=1` to wipe `OCPD_MULTI_HOME` and re-init genesis.
- `OCPD_NO_START=1` to initialize genesis + keys but not start nodes.
- `OCPD_NO_TAIL=1` to start nodes but not tail logs.

Funding notes:

- The faucet key for multinet lives in `OCPD_MULTI_HOME/node0` (not `apps/cosmos/.ocpd`).
- Use the same `apps/cosmos/scripts/faucet.sh`, but set:
  - `OCPD_HOME=apps/cosmos/.ocpd-multi/node0`
  - `OCPD_NODE=tcp://127.0.0.1:26657` (or your `OCPD_RPC_PORT_BASE`)

Fund an address from the faucet key (off-chain):

```bash
bash apps/cosmos/scripts/faucet.sh <bech32-address> [amount]
```

Notes:

- The localnet script creates keys: `validator`, `faucet`, `alice`, `bob` in the local keyring.
- The localnet script patches `config/client.toml` so manual CLI usage defaults to the right `chain-id`, `node`, and `keyring-backend`.
- The faucet script assumes the `faucet` key exists and was funded in genesis.
- Faucet env overrides:
  - `OCPD_NODE` (default: `tcp://127.0.0.1:26657`)
  - `OCPD_FAUCET_KEY` (default: `faucet`)
  - `OCPD_FEES` (default: `0<denom>`)
  - `OCPD_WAIT` (default: `1`)
  - `OCPD_STRICT_WAIT` (default: `0`; if `1`, exit non-zero when tx isn't indexed yet)
  - `OCPD_RETRY` (default: `1`; retries if node is still starting)
