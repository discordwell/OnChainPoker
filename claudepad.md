# Claudepad — Session Memory

## Session Summaries

### 2026-03-28T~UTC — Post-Launch Polish (Batches 1-4)
Executed the full polish plan:
- **Batch 1 (Quick Wins)**: Volume slider in sidebar Audio section, identicons in PixiJS seat sprites (cached per-address), collapsible hand history with `<details>`, inline style cleanup skipped (low priority).
- **Batch 2 (Leaderboard)**: Client-side leaderboard in sidebar, aggregated from hand history. Ranked by total winnings, gold/silver/bronze accents for top 3.
- **Batch 3 (Mobile Polish)**: Tablet (768px) and phone (640px) breakpoints. Stacked action buttons, full-width sidebar overlay, hand history hidden on phone, canvas 4:3 on mobile.
- **Batch 4 (OG Image)**: SVG share image at feltprotocol.com/og.svg. Wired og:image + twitter:image on both sites. Immutable cache headers.
- **Infra**: Removed /felt/ subpath from discordwell.com Caddy, fixed broken config from bad sed, favicon added.
- **Dealer infra fix**: Validator was slashed in epoch 33 (missed shuffle deadlines during deploy restarts). Fixed by manually triggering `begin-epoch` (epoch 34) via CLI, then restarting dealer daemon. DKG committed + finalized, hands flowing again.
- **Board card wet test PASSED**: Hand #8550 reached showdown with all 5 board cards visible: 3♦ J♦ 7♦ Q♦ A♣. PixiJS CardSprite face-up rendering confirmed working (cream bg, red/black suits, rank+suit layout).
- **WebGL fallback**: Wired — auto-detects WebGL, falls back to CSS PokerTable if unavailable.
- **Landing URLs**: Configurable via VITE_APP_URL, VITE_API_URL, VITE_GITHUB_URL env vars.

### 2026-03-27T~UTC — feltprotocol.com Launch + Polish
- **feltprotocol.com** live with auto-TLS via Caddy on ovh2. Caddy site config at `/etc/caddy/sites/feltprotocol.com`.
- **Tokenomics**: 4,294,967,295 total supply (2^32-1), three utility cards (buy-ins, staking, rake/burns).
- **Nickname UI**: "Set Display Name" form in sidebar wallet section, wired to coordinator PUT /v1/nicknames/:address with toast feedback.
- **Wet test**: Shuffle phase working (30-60s threshold crypto), 6000+ hands dealt autonomously. Board card flip animations code-verified, pending visual confirmation (shuffle timing).
- Landing page base path fixed for root domain (`/` instead of `/felt/`).

### 2026-03-26T~UTC — Token Launch: Rebrand + PixiJS Poker Table (Phases 0-5)
Full rebrand + PixiJS game engine implementation:
- **Phase 0**: Chose name "Felt Protocol" (FELT). Chain identifiers (`ocp`, `uchips`) unchanged.
- **Phase 1 (done)**: Created `packages/design-tokens/` (tokens.css, tokens.js, colors.js). Extracted `:root` CSS vars. Renamed all strings. Scaffolded `apps/landing/` with Noir Casino Luxe CSS.
- **Phase 2 (done)**: Full PixiJS poker table replacing CSS/HTML table:
  - 10 modules: Tweener, FeltRenderer, CardSprite, SeatSprite, BoardRenderer, PotDisplay, DealAnimation, WinCelebration, TableScene, PixiPokerTable
  - Rich felt with wood frame, gold rim, overhead lighting, table shadow
  - Cards with flip animation (scaleX tween), face-up rendering with rank/suit
  - Multi-marker support (D+SB on same seat in 3-player)
  - Timer ring with urgency state, animated waiting dots
  - Win celebration particle system (confetti + flash)
  - Action panel + hand history stay as React/CSS below canvas
  - PixiJS v8 in separate vendor chunk (146KB gzip)
- **Phase 3 (done)**: Sound system (12 synth sounds via Web Audio API, mute toggle in topbar) + player identity (coordinator nickname endpoints, useNicknames hook, identicon generator, nameResolver in TableScene).
- **Phase 4 (done)**: Toast notification system (useToast + ToastContainer), enhanced lobby (buy-in range, better badges), PlayerStats component in sidebar.
- **Phase 5 (done)**: Landing page deployed to feltprotocol.com with tokenomics (2^32-1 supply), comparison table, CTA.
- **Deploy fix**: discordwell.com DNS → `ovh2` (15.204.59.61). Must use `DEPLOY_TARGETS=ovh2`.
- **Decisions**: PixiJS full game engine, essential sound, coordinator nicknames + color-coded addresses, separate landing site.

### 2026-03-20T~UTC — VC Polish: App.tsx Decomposition + Documentation
Full repo polish for VC demo presentation:
- **App.tsx decomposition**: Broke 3,029-line monolith into well-organized modules. App.tsx is now 13 lines. Created `hooks/useGameState.ts` (all state + logic), `components/GameView.tsx` (game mode UI), `components/AdminView.tsx` (admin/control room UI), `lib/types.ts`, `lib/constants.ts`, `lib/utils.ts`, `lib/playerKeys.ts`, `lib/coordinatorUrl.ts`.
- **Documentation**: Rewrote README.md with VC-facing value prop, live demo link, architecture table. Created ARCHITECTURE.md with system overview, ASCII data flow diagram, component map, crypto pipeline, security model. Added MIT LICENSE file (was missing).
- **Deploy + wet test**: Deployed to discordwell.com/ocp, verified both game mode and admin view render correctly, zero console errors, WebSocket connected, coordinator health green.
- **Pre-existing issues noted**: coordinator http-dealer-next test failure, web tsc --noEmit type errors (both pre-existing, not caused by refactoring).

### 2026-03-08T~UTC — Fix Coordinator LCD Queries + Epoch Mismatch Timeout
Fixed two blockers preventing the live testnet from being playable:
- **Coordinator LCD queries**: CometChainAdapter was using broken legacy ABCI queries (`/table/1`). Added `lcdUrl` to adapter, switched all queries to LCD REST (`/onchainpoker/poker/v1/tables/1`). Fixed v0 route guards from `chain.kind !== "comet"` to `!chain.queryJson`. Added snake_case fallbacks in `parsePlayerTable.ts` for LCD JSON format (e.g., `small_blind`, `hand_id`, `in_hand`).
- **Epoch mismatch timeout**: Hand #164 was stuck in shuffle phase — referenced epoch 1 but chain was on epoch 3. The `dealer/timeout` handler rejected timeouts when epoch didn't match. Fixed `ops.go` to abort the hand (refund all commits) when the epoch has rotated, instead of erroring.
- **Snake_case handling**: Updated coordinator `http.ts` v0 routes, `v0ExpectedRevealPos`, and `v0TableToTableInfo` to handle both camelCase and snake_case field names from LCD. Updated phase checks for proto enum names (`HAND_PHASE_SHUFFLE`, etc.).
- **Result**: Table #1 live with 3 bots (FishyMcFish, LimpLarry, TightTanya), hands flowing autonomously through all phases.

### 2026-03-08T~UTC — Make OCP Playable (6-Step User Journey Fix)
Audited and fixed the full user journey from visit → spectate → connect → play:
- **Keplr chain suggestion**: Added `experimentalSuggestChain()` before `keplr.enable()` in `connectWallet()` with full OCP chain config (bech32 prefixes, currencies, gas price steps). Extended `KeplrLike` type. Wrapped in try/catch for wallet compat.
- **Coordinator adapter fix**: Changed `COORDINATOR_CHAIN_ADAPTER=cosmos` → `comet` in `deploy/ocp-coordinator.service`. The `cosmos` adapter blocked v0 ABCI table queries; `comet` adapter works.
- **Spectator mode**: Added `spectatorTable` memo parsing `rawTable.data` via `parsePlayerTable()` for wallet-free table viewing. Modified `renderPokerTable()` to fall back to spectator data. Replaced blocking onboarding overlay with lobby overlay (no table selected) + floating spectator banner (table selected). Users can browse and watch tables without connecting.
- **URL table sharing**: `selectedTableId` initialized from `?table=X` URL param. Effect syncs URL on table selection via `replaceState`. Added copy-link button (chain icon) in topbar center. `loadTables` validates URL-specified table against known tables.
- **Game mode table creation**: Extracted `renderCreateTableForm()` helper (shared between game modal and admin view). Added `showCreateTableModal` state, "+ Create Table" button in lobby, modal with click-outside dismiss. Auto-closes on success.
- **CSS**: Added `.spectator-banner` (absolute bottom-center, glass panel, flexbox with action buttons).

### 2026-03-08T~UTC — Game Room Redesign (Dark Casino Luxury)
Full UI redesign from developer "Control Room" dashboard to immersive dark casino poker room:
- **Dark theme**: Replaced all CSS variables (--bg-a, --bg-b, --panel, --ink, --line, etc.) with dark palette. Updated body gradients, input/select/pre backgrounds, error banners, badges, table rows for dark mode.
- **View mode toggle**: Added `viewMode` state ("game" | "admin"). Game mode is default — immersive poker room. Admin mode preserves the full 3-column dashboard verbatim (now dark-themed).
- **Game layout**: New CSS classes — game-shell (flex column full viewport), game-topbar (48px sticky header with logo/table tabs/table info/balance/wallet/icons), game-stage (centered poker table), game-sidebar (360px slide-in drawer), game-footer (chat), onboard-overlay (3-step onboarding: connect wallet → choose table → sit down).
- **Balance display**: Added playerBalance state with LCD polling every 10s, shown as gold chip icon + formatted CHIPS in topbar.
- **Responsive**: Breakpoints at 1024px (sidebar full-width), 768px (hide topbar center), 640px (compact tabs/logo).
- **No PokerTable.css changes**: Existing Emerald Velvet theme complements the dark body naturally.

### 2026-03-08T~UTC — Stale RPC Connection Fix + Chain Reinit
Fixed the final blocker preventing hands from completing on the public testnet:
- **Socket hang up fix**: CosmJS `SigningStargateClient` keeps persistent HTTP connections to CometBFT RPC. During ~20s shuffle proof computation, the connection goes stale (server closes idle keep-alive). Added reconnect-on-socket-error logic in `signAndBroadcastAuto()` — detects socket/ECONNRESET errors on `simulate()`, `signAndBroadcastSync()`, and `signAndBroadcast()`, then reconnects and retries once. Changed `client` to `let` with `get client()` accessor on the returned object.
- **Dealer timeout too short**: Genesis had `dealer_timeout_secs: 30` but shuffle takes ~20s compute + network time. Increased to 120s. Required chain reinit.
- **GoLevelDB empty-value DB wrapper**: Created `dbfix.go` wrapping the database at the `DB` layer (not just query layer). `Get()` falls back to iterator seek when nil. `Has()` uses same fallback. Wired in `NewOcpApp` before `app.Load()`.
- **Deploy script**: Changed from hardcoded 3 dealers to dynamic detection of `dealer-*.env` files.
- **Result**: Full hands play autonomously — shuffle proofs submit reliably, hands complete end-to-end, bots playing continuously.

### 2026-03-07T~UTC — Public Testnet: Faucet + Bot Deploy Infrastructure
Implemented public testnet infrastructure for anyone to play poker at discordwell.com/ocp:
- **Faucet service**: New `FaucetService` class in coordinator with `GET /v1/faucet/status` and `POST /v1/faucet` endpoints. Address/IP rate limiting with configurable cooldowns, bech32 prefix validation, signing mutex, bounded cooldown maps. 7 new tests (18 total).
- **Frontend faucet button**: "Get Testnet CHIPS" button in wallet panel with pending/success/error states and 8s auto-clear.
- **Testnet genesis script**: `apps/cosmos/scripts/testnet-genesis.sh` — creates validator, faucet, bot-0/1/2 keys with mnemonic backup, pre-seeds table #1 (5k/10k blinds), patches denom metadata.
- **Deploy fixes**: VITE env vars set at build time (relative paths for reverse proxy), bot restart detection (scans `bot-*.env`), coordinator ocp-sdk dependency wired for VPS.
- **Config**: `FaucetConfig` type with 10 fields parsed from env, reuses existing COORDINATOR_COSMOS_* URLs as fallbacks.

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

## Key Findings

- **DKG share distribution**: Uses the chain's complaint/reveal mechanism as the share distribution channel. Every validator files `DkgComplaintMissing` against every other after commit phase, forcing on-chain `DkgShareReveal`. Must aggregate shares BEFORE `FinalizeEpoch` since finalization clears DKG state.
- **Hole card crypto**: Enc share format is `U(32)||V(32)`, decrypt as `V - skPlayer * U = d_j = xHand_j * C1`. Lagrange on group elements yields combined partial decryption `D`. Card recovery: `M = C2 - D`, lookup `M` in precomputed table of `mulBase(BigInt(cardId + 1))` for id 0..51 (uses `id+1` to avoid identity point, matching Go chain's `cardPoint()`).
- **Security items resolved** (2026-02-20): All 8 deferred items addressed — hex length check, threshold check, XSS SECURITY comment + future mitigation path noted, DKG re-fetch between phases, pk mismatch warning, error logging, committed-only complaint filter, module-level card table.
- **Pre-existing coordinator build error**: `apps/coordinator/src/http.ts:218` has a TypeScript null check issue (`config.corsOrigins`) that predates these changes.
- **Vite base path**: Already configured to `/ocp/` in vite.config.ts.
- **GoLevelDB empty-value quirk**: `GoLevelDB.Get()` returns `nil` for keys stored with `[]byte{}` (empty value). `GoLevelDB.Has()` uses `Get()` internally and checks `bytes != nil`, so it returns false for empty values. Iterators still find these keys. This affects IAVL's `SaveEmptyRoot()` which writes `[]byte{}` for empty trees, making `hasVersion()` and `GetRoot()` fail for stores with no data.
- **Store version compatibility**: SDK pseudo-version `v0.54.0-rc.1` requires `cosmossdk.io/store v1.3.0-beta.0` (for `ObjKVStore`), forced via `replace` directive. Both SDK and ibc-go pin this same version.
