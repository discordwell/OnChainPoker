# Claudepad — Session Memory

## Session Summaries

### 2026-02-19T~UTC — Testnet → Live Poker Room (Phases 1-6)
Implemented all 6 phases of the plan to bridge the on-chain poker protocol to a playable poker room:
- **Phase 1**: Fixed `getPlayerPkForAddress()` → `getPlayerKeysForAddress()` to store 64-byte entropy (not just pubkey) in localStorage under `ocp.web.skPlayer:<addr>`. Added legacy key migration.
- **Phase 2**: Added 4 dealer proxy routes to coordinator (`/v1/dealer/hand/:t/:h`, hole-positions, enc-shares, ciphertext) following the existing ABCI query pattern.
- **Phase 3**: Created `apps/dealer-daemon/` — event-loop daemon with handlers for DKG commit, shuffle, enc shares, pub shares. Uses polling against chain LCD. Encrypted-at-rest epoch secrets in `~/.ocp-dealer/`.
- **Phase 4**: Game automation integrated into dealer daemon (`automation.ts`) — auto epoch, hand init, tick, timeout. Gamemaster flag for designated operator.
- **Phase 5**: Created `PokerTable.tsx`, `CardFace.tsx` components with "Emerald Velvet" CSS design. Added `useHoleCards` and `useTableState` hooks. Integrated PokerTable into App.tsx Player Desk section.
- **Phase 6**: Deploy infrastructure — nginx config, 3 systemd unit templates (chain node, coordinator, dealer daemon), `deploy-vps.sh` script.
- **Code review fixes**: State file permissions (0o600), systemd template typo, stale hand ID race, nginx WebSocket upgrade, empty passphrase warning.

## Key Findings

- **DKG limitation**: The dealer daemon currently computes secret shares in single-party mode (self-evaluation only). Multi-party aggregation requires all validators' polynomial evaluations, which needs a chain query or off-chain coordination channel not yet built.
- **Hole card decryption**: `useHoleCards` hook fetches coordinator routes but the final crypto step (`HoleCardRecovery.recoverHoleCards()`) is not yet wired — needs browser-compatible crypto imports.
- **Pre-existing coordinator build error**: `apps/coordinator/src/http.ts:218` has a TypeScript null check issue (`config.corsOrigins`) that predates these changes.
- **Vite base path**: Already configured to `/ocp/` in vite.config.ts.
