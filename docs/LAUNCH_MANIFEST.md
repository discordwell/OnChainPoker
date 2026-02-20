# Launch Manifest

Generated (UTC): 2026-02-20T14:43:56Z

## Source

- Commit: `020b07b7738cea83513a5206b7041380d7e9b33d` (`020b07b`)
- Worktree status at generation: `dirty`

## Chain Freeze Fields

- Chain ID: `TBD`
- Genesis file path: `TBD`
- Genesis SHA-256: `TBD`

## Artifacts

Directory digests are computed as SHA-256 over a sorted manifest of `<file_sha256><space><space><repo-relative-path>` lines.

| Path | Kind | SHA-256 | Bytes |
|---|---|---|---:|
| `apps/cosmos/bin/ocpd` | file | `c314414025cc5f21d7243e72fb46f0eec16d9a54d786b033bcac55dbcb14c51f` | 102022258 |
| `apps/web/dist` | dir(4 files) | `e32c1d647714b7b0f79108f9496af4fa420889084be23e302556544aec1deced` | 11192656 |
| `apps/coordinator/dist` | dir(11 files) | `73f418de8fec1ea8fd51b9013a5edf19abb21583a91ae6f1f10ee5aa7523af51` | 60038 |
| `apps/dealer-daemon/dist` | dir(10 files) | `3ec7b9cbb3cc2310f67aa05bb4f32bdb9e3691464904394c45df3ec63634d0e0` | 45845 |
| `packages/ocp-sdk/dist` | dir(156 files) | `eeefb260d41c6c0ae0f6655a051482ef3c84b82812b8668191db232706db7285` | 1313122 |
| `packages/ocp-crypto/dist` | dir(36 files) | `0f8efc09145114639640c4ecdb2e3fb909a13460cd1ae8f5b4d8bed2a7d17597` | 45256 |
| `packages/ocp-shuffle/dist` | dir(22 files) | `d9930fc59ed6d69ab29831f2432653031e9eed096ffe40a1b03c8ab257d89c70` | 40101 |

## Gate Results

Validated on 2026-02-20 (UTC); all passed:

- `(cd apps/cosmos && go test ./...)`
- `pnpm -C apps/dealer-daemon build`
- `pnpm -C apps/dealer-daemon test`
- `pnpm -C packages/ocp-sdk test`
- `pnpm -C apps/coordinator build`
- `pnpm -C apps/coordinator test`
- `bash scripts/cosmos-dealer-e2e.sh`
- `go build -o apps/cosmos/bin/ocpd ./apps/cosmos/cmd/ocpd`
- `bash scripts/deploy-vps.sh --build-only`

## Finalization Commands

Use these once the final genesis is ready:

```bash
# Set launch chain metadata
CHAIN_ID="<your-chain-id>"
GENESIS_PATH="<absolute-path-to-genesis.json>"

# Compute genesis hash
shasum -a 256 "$GENESIS_PATH"

# Optional sanity check
apps/cosmos/bin/ocpd genesis validate-genesis --home "$(dirname "$GENESIS_PATH")/.."
```
