# Claudepad — Session Memory

## Session Summaries

### 2026-02-21T~UTC — IBC State Query Fix (GoLevelDB Empty-Value Bug)
Fixed the blocking issue preventing all gRPC/REST state queries when IBC is enabled:
- **Root cause**: `cosmos-db`'s `GoLevelDB.Has()` returns false for keys with empty values (`[]byte{}`). IAVL's `SaveEmptyRoot()` writes `[]byte{}` for empty stores (evidence, ibc, transfer). This breaks `CacheMultiStoreWithVersion()` for all queries.
- **Fix**: Created `queryMultiStore` wrapper (`app/querywrap.go`) overriding `CacheMultiStoreWithVersion`. When `GetImmutable` fails and CommitInfo shows an empty-tree hash, substitutes a MemDB dummy instead of erroring. Wired via `SetQueryMultiStore()`.
- Also fixed IBCStackBuilder middleware panic (bypass builder, wire transfer module directly).
- All gRPC, REST, CLI queries now work: bank, staking, IBC endpoints verified.

### 2026-02-19T~UTC — Follow-up Fixes (DKG + Hole Cards)
Fixed two documented limitations from the initial implementation:
- **Multi-party DKG**: Updated daemon to use complaint-based share distribution. New flow: commit → file `DkgComplaintMissing` for all other validators → reveal shares in response to complaints → aggregate secret share from own self-evaluation + received reveals → finalize. Added `handleDkgComplaints()`, `handleDkgReveals()`, `handleDkgAggregate()` to `dkg.ts`. Updated daemon.ts polling loop.
- **Hole card decryption**: Implemented full crypto pipeline in `useHoleCards.ts`. Decrypts enc shares (V - skPlayer * U), computes Lagrange coefficients for validator indices, combines threshold shares via group-element interpolation (Σ λ_j * d_j), recovers card ID from precomputed lookup table (M = C2 - D). Integrated into App.tsx passing `holeCardState.cards` to PokerTable.

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

- **DKG share distribution**: Uses the chain's complaint/reveal mechanism as the share distribution channel. Every validator files `DkgComplaintMissing` against every other after commit phase, forcing on-chain `DkgShareReveal`. Must aggregate shares BEFORE `FinalizeEpoch` since finalization clears DKG state.
- **Hole card crypto**: Enc share format is `U(32)||V(32)`, decrypt as `V - skPlayer * U = d_j = xHand_j * C1`. Lagrange on group elements yields combined partial decryption `D`. Card recovery: `M = C2 - D`, lookup `M` in precomputed table of `mulBase(BigInt(cardId + 1))` for id 0..51 (uses `id+1` to avoid identity point, matching Go chain's `cardPoint()`).
- **Security items resolved** (2026-02-20): All 8 deferred items addressed — hex length check, threshold check, XSS SECURITY comment + future mitigation path noted, DKG re-fetch between phases, pk mismatch warning, error logging, committed-only complaint filter, module-level card table.
- **Pre-existing coordinator build error**: `apps/coordinator/src/http.ts:218` has a TypeScript null check issue (`config.corsOrigins`) that predates these changes.
- **Vite base path**: Already configured to `/ocp/` in vite.config.ts.
- **GoLevelDB empty-value quirk**: `GoLevelDB.Get()` returns `nil` for keys stored with `[]byte{}` (empty value). `GoLevelDB.Has()` uses `Get()` internally and checks `bytes != nil`, so it returns false for empty values. Iterators still find these keys. This affects IAVL's `SaveEmptyRoot()` which writes `[]byte{}` for empty trees, making `hasVersion()` and `GetRoot()` fail for stores with no data.
- **Store version compatibility**: SDK pseudo-version `v0.54.0-rc.1` requires `cosmossdk.io/store v1.3.0-beta.0` (for `ObjKVStore`), forced via `replace` directive. Both SDK and ibc-go pin this same version.
