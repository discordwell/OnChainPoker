# Oldpad — Archived Session Summaries

Older session summaries rotated out of claudepad.md (which keeps the 20 most
recent). Newest first.

### 2026-02-21T10:00~UTC — Dealer Daemon Bugfixes + Bot Integration Test
Fixed multiple field-name mismatches and control-flow bugs in the dealer daemon that prevented hands from completing:
- **Shuffle round**: `handleShuffle` now reads `shuffleStep` from `DealerHand` proto (authoritative) instead of poker table metadata.
- **Enc shares**: Read `holePos` from `table.hand.dealer` (poker module metadata), not `DealerHand` proto. Added `seatData.pk` field fallback. Catch "not in shuffle phase" gracefully.
- **Deck finalized**: Use `pick(dealer, "deckFinalized", "deck_finalized")` everywhere (both `processTable` and `expectedRevealPos`).
- **Timeout flow**: Removed `return` from reveal/betting phase handlers so `maybeDealerTimeout` always runs.
- **Result**: Full hands flow autonomously — DKG → shuffle → enc shares → preflop → flop → turn → river → showdown → next hand. Bots (calling-station + TAG) playing continuously.

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
