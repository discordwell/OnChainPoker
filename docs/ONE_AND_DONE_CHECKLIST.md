# One-And-Done Launch Checklist

Status date: 2026-02-20

Goal: after launch, protocol correctness must not depend on issuer-controlled keys, services, or governance.

## Implemented hardening

- Enforced zero rake at consensus validation (`rake_bps` must be `0`).
  - `apps/cosmos/x/poker/keeper/msg_server.go`
- Removed dealer module parameter update control path from protobuf and runtime (`MsgUpdateParams` deleted).
  - `apps/cosmos/proto/onchainpoker/dealer/v1/tx.proto`
  - `apps/cosmos/x/dealer/types/tx.pb.go`
- Removed `x/gov` and `x/upgrade` from app wiring (no governance proposals or software-upgrade handlers in this runtime).
  - `apps/cosmos/app/app_config.go`
  - `apps/cosmos/app/app.go`
- Removed dealer module authority wiring from keeper/module config.
  - `apps/cosmos/proto/onchainpoker/dealer/module/v1/module.proto`
  - `apps/cosmos/x/dealer/module.go`
- Removed designated gamemaster gate from dealer daemon automation.
  - `apps/dealer-daemon/src/config.ts`
  - `apps/dealer-daemon/src/handlers/automation.ts`

## Remaining blockers for full one-and-done

- Dealer liveness still requires validator participation for DKG/shuffle/share submissions.
  - This is permissionless, but not "no operators at all".
- Launch process still needs a one-time immutable genesis/distribution procedure.
  - Publish reproducible build artifacts + binary checksums.
  - Publish chain-id/genesis hash and final launch transactions.

## Verification commands

```bash
cd apps/cosmos && go test ./...
pnpm -C apps/dealer-daemon test
```
