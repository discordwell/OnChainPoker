# Claudepad — Session Memory

## Session Summaries

### 2026-06-18T~UTC (latest) — Web Hole-Card Recovery Unbroken + Bot Short-Stack Raise + Test-Orchestration Gaps
Maintenance pass (local-only; no deploys). Repo started green/clean. Dispatched bug-hunt subagents over the least-recently-touched TS apps (web, sim, bot) and verified every finding against the chain protos/source before acting; an independent code-review subagent then cleared the whole change set (no correctness defects). Four fixes, each with a test; full root `pnpm test` green end-to-end (exit 0).

**Web hole-card decryption was broken end-to-end on the cosmos runtime (HIGH)** (`apps/coordinator/src/http.ts`, `apps/coordinator/src/chain/mock.ts`, `apps/web/src/components/useHoleCards.ts`, `holeCardCrypto.ts`):
- The web `useHoleCards` hook recovers a seated human's hole cards via the coordinator's `/v1/dealer/hand/.../{enc-shares,ciphertext}` proxy routes. Those routes read deck/`encShares` off `table.hand.dealer` — the **poker** module's thin `DealerMeta` (proto `poker.proto:68`: only epoch_id/deck_size/deck_finalized/hole_pos/cursor/reveal_pos/reveal_deadline). It has NO deck, NO enc_shares, NO members — so the routes always returned empty → the hook looped forever on "Waiting for validator enc shares…". The deck + per-position enc-shares live on the **dealer** module's rich `DealerHand` (`dealer.proto:236`), served at `/onchainpoker/dealer/v1/tables/{t}/hands/{h}` — exactly what the SDK/bot's proven `getDealerHand`→`decryptHoleCards` path already uses. (Bots worked; the web UI the README advertises did not. Likely broke at the 2026-03-08 LCD migration, same class as the `http-dealer-next` stub drift.)
- Fix: new `fetchDealerHand()` helper points the enc-shares + ciphertext routes at the dealer endpoint and **forwards `DealerEncShare.index`** (the validator's 1-based Shamir x-coord, field 3) — the routes had been dropping it. The hook now reads `share.index` straight off each share (new tested helper `decryptIndexedShares`) instead of rebuilding a validator→index map from a `members` array the DealerMeta never carried. Threshold sanity-check rebased on shares-present. `hole-positions` route left alone (correctly reads DealerMeta.hole_pos).
- Tests: `apps/coordinator/test/http-dealer-hand.test.ts` (4, incl. a regression asserting the routes 404 rather than sourcing from a poker-table payload) + `decryptIndexedShares` cases in the re-enabled web suite. Added `queryJson` to `MockChainAdapter` (was why these routes had zero tests).

**Bot emits an illegal raise when too short to clear betTo (MEDIUM)** (`apps/bot/src/bot.ts`, new `apps/bot/src/sanitizeAction.ts`):
- The chain reads a bet/raise `amount` as a raise-**to** total and rejects `desiredCommit <= currentBetTo` (`logic.go:240`). When a bot faces a bet larger than its whole stack and the strategy says raise, the sanitizer capped `amount` to `allIn <= betTo` → a sub-betTo "raise" the chain rejects ("BetTo must exceed current betTo") → bot never acts, gets timed out. A subagent fuzz flagged 1227 such submissions (all short-stack-facing-over-bet). Fix: when `allIn <= betTo`, downgrade to `call` (chain caps the call to remaining stack = all-in-for-less, `logic.go:315-318`) or `check` when nothing owed. Logic extracted to pure `sanitizeAction()` + 8 tests.

**Revealed cards rendered as raw text, not card faces (LOW/cosmetic)** (`apps/web/src/components/CardFace.tsx`):
- Hand-history showdown reveals feed `cardIdFromLabel` the chain's `Card.String()` letter labels ("As","Th"), but it only parsed glyph labels ("A♠") → every reveal returned null → plain-text fallback. Fix: parse both formats (added c/d/h/s suit letters + "T"/"10" rank); encoding `suit*13+(rank-2)` matches `cards.Card`. 52-card round-trip test.

**Test-orchestration gaps fixed** (`package.json`, `apps/web/vitest.config.ts`):
- `apps/bot`'s 87 tests were never in root `pnpm test`/CI (only the `-r` sweep ran them) — added `pnpm -C apps/bot test` to `test:unit` so the bot fix (and strategy suite) is actually CI-guarded.
- `apps/web/test/useHoleCards.test.ts` (20 crypto tests for the hole-card primitives) was orphaned — vitest `include` was `src/**` only. Extended to `test/**`; the 20 tests now run.

**Verification:** root `pnpm test` exits 0 (runtime-check, all packages, sim, **bot**, coordinator 68→72, dealer-daemon, web 77→104 incl. tsc, web:build, apps/chain go). Code-review subagent: no defects, confirmed camelCase/snake_case handling vs the dealer LCD, the `index<=0` skip making `?? 0` safe, and the card-encoding round-trip. No chain/Go source touched (coordinator+web+bot TS only) → no replay concerns, no deploy.

### 2026-06-17T~UTC — Coordinator Crash-Resilience: Total `sendJson` + Isolated Chain-Event Dispatch
Maintenance pass (local-only; no deploys). Orienting review found the repo green and clean (zero TODO/FIXME, holdem-eval/pots/engine all correct, scout-flagged dealer-daemon "bugs" were false positives — DKG member indices are 1-based per `committee/dealer_members.go:37` so the `dkg.ts:176` `j>0` guard is harmless, and `u64le(Number(tableId))` can't collapse because `BigInt(NaN)` throws and real chain IDs are numeric). The one genuine, high-value finding: a reachable **coordinator process-crash** in the always-on relay.

**The bug** (`apps/coordinator/src/ws.ts`, `chain/cosmos.ts`, `chain/comet.ts`):
- `sendJson` did a bare `ws.send(JSON.stringify(msg))`. The chain adapters' RPC-WebSocket `message` handler dispatched events via `for (const cb of this.subscribers) cb(ev)` with NO try/catch, and there is NO process-level `uncaughtException`/`unhandledRejection` handler anywhere in the coordinator (grep-confirmed).
- Crash path: chain event → subscriber (`server.ts:51`) → `broadcastChainEvent` → `sendJson` → `ws.send`/`JSON.stringify` throws (a client socket that raced to CLOSING after the readyState check, or any unserializable payload) → escapes the `message` handler as an uncaught exception → **whole coordinator dies, disconnecting every player**. A throw also aborted delivery to the *remaining* clients in the broadcast loop.

**The fix (two layers):**
- **Part A (root cause)** — `sendJson` is now total: `ws.send(JSON.stringify(msg))` wrapped in try/catch (best-effort delivery; drop one client's copy, never throw). This makes all broadcast paths (`broadcastChainEvent`/`broadcastToTopic`/`broadcast`) and every single-client reply safe at once. All 20 call sites are fire-and-forget `void` — swallowing hides nothing actionable (verified by code-review subagent).
- **Part B (defense-in-depth)** — new `apps/coordinator/src/chain/dispatch.ts` exports `dispatchChainEvents(subscribers, events, onError?)` that catches per-subscriber throws (no escape, no sibling starvation). Wired into both `cosmos.ts` and `comet.ts`, replacing the bare nested loop byte-for-byte plus a `console.error` onError net. Covers any future non-`sendJson` subscriber too.

**Tests (every fix requires a test):**
- `test/chain-dispatch.test.ts` (4): happy-path exactly-once delivery, throwing-subscriber-first doesn't starve siblings or escape, no-`onError` path still swallows, empty-batch no-op.
- `test/ws-broadcast-resilience.test.ts` (1): end-to-end through real `createCoordinatorServer` + `MockChainAdapter` — publishing an event with a BigInt in `data` does NOT throw and the relay keeps delivering a subsequent `HandStarted`. **Proven a genuine regression guard**: reverting `sendJson` to the throwing form fails it with `TypeError: Do not know how to serialize a BigInt`.

**Verification:** coordinator suite 63→68 (all pass); coordinator `tsc` build clean; full root `pnpm test` exits 0 end-to-end (packages, web tsc+vite build, `apps/chain` go). Code-review subagent: no substantive findings, tests deterministic (5/5 runs). cosmos go untouched (TS-only change). No deploy.

### 2026-06-17T~UTC — Coordinator Hardening (XFF rate-limit bypass, memory bounds) + CI Go-version
Maintenance pass (local-only; no deploys). Dispatched bug-hunt subagents over the dealer-daemon (clean — only a low-sev dead-code note: `daemon.ts:86`'s `dh.reveals` fallback reads a field the poker `DealerMeta` proto doesn't have, but the explicit `revealPos` path covers it) and the untrusted coordinator (3 findings, all closed). Also confirmed the prior session's shuffle "step 4/3" finding was already fixed in `1713655` (drop-modulo). Five changes, two commits:

**XFF rate-limit / faucet-cooldown bypass (HIGH)** (`apps/coordinator/src/clientIp.ts` [new], `http.ts`, `ws.ts`, `config.ts`):
- `getClientId` + the WS per-IP cap read the LEFTMOST `X-Forwarded-For` hop, which is fully client-controlled. `deploy/nginx-ocp.conf` uses `$proxy_add_x_forwarded_for` (APPENDS the real peer as the RIGHT-most hop), so an attacker rotating a spoofed XFF prefix minted a fresh "IP" per request → bypassed the write rate limiter, faucet per-IP cooldown, and WS chat cap. The 2026-05-19 session set first-hop deliberately ("cap fires behind nginx") but that reasoning missed that nginx *appends*.
- New `clientIpFromForwarded(header, directIp, trustedHops=1)` reads the `trustedHops`-th hop from the RIGHT (Express `trust proxy: n` semantics); fails safe to the socket peer when the chain is shorter than expected or `trustedHops<=0`. Configurable via `COORDINATOR_TRUSTED_PROXY_HOPS` (default 1 = the single checked-in nginx). **NOT verified against the live prod proxy topology** — operator should confirm the hop count before deploy (documented in `deploy/coordinator.env.example`). Centralized in one helper (was duplicated in http+ws). 9 unit tests pin the spoof-collapse property.

**Unbounded nicknames map (MEDIUM)** (`apps/coordinator/src/nicknames.ts` [new], `http.ts`):
- `PUT /v1/nicknames/:address` validated only `startsWith("ocp")` into an unbounded Map. Prod `requireWriteAuth` defaults true, but the browser nickname UI implies this deployment disables it → public unbounded growth. New `NicknameRegistry` caps at 50k (FIFO-evict oldest; never evicts an in-place update); handler now requires a checksum-valid bech32 `ocp` address via existing `decodeBech32Prefix`. 5 unit + 2 HTTP tests.

**Faucet evictExcess (LOW)** (`apps/coordinator/src/faucet.ts`):
- Evicted by Map insertion order, which could re-arm a freshly-renewed long cooldown. Extracted exported `evictSoonestToExpire(map, max)` (evict soonest-to-expire first; callers already pruned expired). 3 unit tests.

**CI Go-version** (`.github/workflows/ci.yml`):
- The two cosmos-building jobs (`test`, `cosmos-dealer-e2e`) installed Go from `apps/chain/go.mod` (`go 1.25.0`) and relied on `GOTOOLCHAIN=auto` to fetch 1.25.7 mid-test for `apps/cosmos` (`go 1.25.7`). Now point `go-version-file` at `apps/cosmos/go.mod` so the toolchain satisfies both up front; `dealer-smoke` (chain-only) stays on `apps/chain/go.mod`. Closes the 2026-06-17 observation.

**Verification:** full `pnpm test` exits 0 end-to-end (coordinator 44→63 tests, dealer-daemon 29, web 77+tsc, chain go, all packages); `apps/cosmos go test ./...` green on local 1.25.7; coordinator `tsc` build clean. Code-review subagent: no findings. No deploy (orchestrator pushes after its safety check).

### 2026-06-17T~UTC — Fixed 3-Month-Red `pnpm test` / CI (README runtime-check marker)
Maintenance pass (local-only; no deploys). Found and fixed the root `pnpm test` command — and therefore CI's "Unit Tests + Build" job — failing at its **very first step** since 2026-03-20.

**Root cause** (`README.md`, `scripts/check-runtime-target.sh`):
- `test:unit` (= `pnpm test`) starts with `pnpm runtime:check`, which greps `README.md` for the literal `Production target:` to keep the legacy(`apps/chain`)/production(`apps/cosmos`) runtime split documented.
- Commit `d4e44b8` (2026-03-20, "VC-ready docs" README rewrite) deleted the `- **Production target:** \`apps/cosmos\`` line — and dropped any mention of `apps/chain` at all — so `runtime:check` has exited 1 ever since, aborting the whole suite before any package test ran.
- **Why nobody caught it for ~3 months:** prior "all green" verifications used `pnpm -r --if-present test`, which runs each *workspace package's* own `test` script and **skips the root `test:unit` orchestration**. The root-only steps (`runtime:check`, `node --test scripts/test/*.test.mjs`, `pnpm web:build`, `pnpm chain:test`) were never exercised by that sweep. See new Key Finding.
- Knock-on: CI's `test` job aborts at "Unit Tests + Build", so its *next* step "Cosmos Go Tests" (`apps/cosmos go test ./...`) also hasn't run since 2026-03-20.

**Fix:**
- Restored the `**Production target:** \`apps/cosmos\` …` paragraph to README (also re-adds the genuinely useful "apps/chain is a legacy CometBFT scaffold, not a deploy target" note the rewrite had dropped).
- Added a hidden `<!-- … -->` HTML comment above it explaining the two literals are load-bearing for `check-runtime-target.sh`, so a future reword can't silently drop them again.

**Verification:** full `pnpm test` now exits 0 end-to-end — every previously-unvalidated root step passes: `runtime:check` ✓, `scripts/test` (4) ✓, dealer-daemon (29) ✓, web tsc+vitest (77) ✓, `web:build` (vite) ✓, `chain:test` (apps/chain go) ✓, plus all other package suites. `apps/cosmos go test ./...` green standalone (x/dealer + x/poker keepers).

**Observation for a future session (not changed):** CI `setup-go` reads `go-version-file: apps/chain/go.mod` (`go 1.25.0`) in all three jobs, but `apps/cosmos/go.mod` needs `go 1.25.7`; the now-unblocked "Cosmos Go Tests" step relies on `GOTOOLCHAIN=auto` to fetch 1.25.7. Consider bumping apps/chain's `go` directive to 1.25.7 (verified to still build/test locally on 1.25.7) or pointing CI at `apps/cosmos/go.mod`.

### 2026-06-11T~UTC — Maintenance Pass: All Suites Green + Beacon Threshold Inheritance
Routine maintenance pass (local-only; no deploys). Closed the epoch-threshold quirk from the prior session's notes and got every test suite in the workspace green simultaneously — the coordinator and ocp-shuffle suites had been red since March/April. Two summaries from 2026-02-19 rotated to a new `oldpad.md` (20-summary cap).

**Beacon auto-open threshold inheritance** (`apps/cosmos/x/dealer/keeper/beacon.go`):
- `MaybeAutoOpenBeacon` no longer hardcodes `openBeacon(ctx, nextEpoch, 0, 0, 2)`; it now uses `max(2, currentEpoch.Threshold)` so a future wider committee (t>2) can't auto-open a beacon that finalizes below the epoch's own security parameter. This was the explicitly-deferred quirk from the 2026-05-19 beacon-recovery-tests session.
- Replay-safe WITHOUT a height gate: every historical epoch ran threshold ∈ {1,2}, so `max(2,t)` reproduces the previously hardcoded 2 at all past heights → byte-identical state on replay. `GetEpoch` is read only on the actually-opening path, preserving the BeginBlocker first-read short-circuit contract noted in module.go.
- 3 new regression tests in `msg_server_beacon_recovery_test.go`: inherit t=3 on plain auto-open, floor legacy t=1 to 2, inherit t=3 through the stuck-overwrite recovery branch.
- Code-review altitude note for a future session: beacon threshold arguably belongs in module Params (needs proto regen) — manual `MsgOpenBeaconWindow` takes `req.Threshold` while auto-open now reads epoch state; two sources of truth at different depths. Also the deeper semantic wrinkle: beacon participants are ALL bonded validators while `epoch.Threshold` describes the DKG committee.

**Coordinator suite green (44/44, first time since ~March)** (`apps/coordinator/test/http-dealer-next.test.ts`):
- The two perpetually-failing tests stubbed the legacy ABCI path `/table/N` and `dealer.finalized`; the route moved to LCD `/onchainpoker/poker/v1/tables/N` + `deckFinalized` in the 2026-03-08 LCD migration and nobody updated the stubs. Stubs now mirror the real LCD shape (`{table:{...}}` wrapper). The route's base64-decode path they exercise (`decodeU8Array` string branch) is still live code.

**ocp-shuffle suite green (21/21, was 6/21)** (`packages/ocp-shuffle/package.json`):
- Test script ran bare `node --test`, which unlike vitest does NOT set `NODE_ENV=test`, so the April audit's `seedUnsafeForTestsOnly` guard threw in 15 tests. The suite was designed for NODE_ENV=test (seed_guard.test.ts's `withEnv` comment says so). Fix: `NODE_ENV=test` prefix in the script. Verified with `env -u NODE_ENV pnpm test`. The April session likely had NODE_ENV set in-shell, masking this.

**Web `tsc --noEmit` green (20 pre-existing errors fixed)** (`apps/web`):
- The web `test` script IS `tsc --noEmit`, so the web "suite" had been failing since ~March too. Vite/esbuild never type-checks, so these lingered invisibly.
- 13 of 20: Tweener `TweenOptions.target` was `Record<string, number>` — too narrow for Pixi `ObservablePoint`/`CardSprite`/`Graphics` targets. Widened to `object` (impl already casts internally).
- 4: TS 5.7+ `Uint8Array<ArrayBufferLike>` vs `BufferSource` at crypto.subtle boundaries — annotated the fresh-allocating base64 decoders + params as `Uint8Array<ArrayBuffer>` (`keyEncryption.ts`, `passwordDigest.ts`, `utils.ts:base64ToUint8`).
- 2: coordinatorUrl.test.ts window mock now casts `as unknown as Window & typeof globalThis` (dropped the unused `@ts-expect-error`).
- 1: `parsePlayerTable.ts` pot loop `BigInt(tc ?? 0)` on unknown → explicit string/integer-number branches, garbage (objects/null/booleans/NaN/Infinity/floats) sums as 0n instead of throwing. New `parsePlayerTable.test.ts` (6 tests) pins pot computation incl. snake_case fallback. (Code-review pass caught that bare `typeof tc === "number"` still let NaN/floats throw → added `Number.isInteger` guard.)

**Verification:** full `pnpm -r --if-present test` sweep green with NODE_ENV scrubbed (coordinator 44, dealer-daemon 29, web 77 vitest + tsc, ocp-shuffle 21, ocp-crypto, ocp-sdk, poker-engine, holdem-eval, sim all pass); `go test ./...` in apps/cosmos green; `pnpm -r build` clean. No chain/daemon deploy needed for the test-only fixes; beacon.go change ships with the next regular chain deploy (replay-safe per analysis above).

### 2026-05-19T~UTC — Housekeeping + Beacon-Recovery Tests + Shuffle "step N/3" Finding
Closed three of the four leftover items the prior session log called out: server housekeeping on ovh2, missing Go regression tests for the beacon stuck-recovery paths, and the stuck-epoch-41-hand audit. One new bug surfaced incidentally and is reported but not yet fixed.

**Housekeeping (ovh2):**
- Pruned `/opt/ocp/bin/ocpd.{prev,with-consumable-fix,pre-stuck-fix}` rollback binaries (~343 MB).
- All three node `config.toml` switched to `indexer = "null"`; `tx_index.db` directories removed under each `/opt/ocp/chain/node{0,1,2}/data/`. Total reclaim ~3.9 GB (3.7 GB on node0 alone). Disk went from 84G/88% → 80G/83% used (13G → 17G free).
- Rolling restart kept BFT quorum (2 of 3) up at all times; chain advanced ~1 block per node-down window (5 s). Validator set returned to 3/3 signing within seconds of each node coming back.
- `/root/ocp-new-validator-mnemonics.txt` already `rw-------` root-only — no action needed.
- Caddy still blocks `/ocp/rpc/tx_search` publicly (verified 404 post-cleanup). Internal code never called the indexer (`grep -rn "tx_search\|TxSearch" apps packages` returned zero).

**Beacon-recovery tests** (`522f49c`):
- New file `apps/cosmos/x/dealer/keeper/msg_server_beacon_recovery_test.go` (303 LoC, 9 tests) drives `WithBlockHeight` past `beaconStuckRecoveryHeight = 1_036_000` so the post-upgrade branch actually executes. Pre-existing beacon tests all run at height 10 and exercised only the legacy path.
- Covers all three branches of the `live || consumable || preUpgrade` guard in both entry points (`openBeacon` + `MaybeAutoOpenBeacon`): pre-upgrade preserve-expired, post-upgrade overwrite-stuck (the f658ecb path), post-upgrade preserve-consumable (the b2393b1 regression), post-upgrade preserve-live, post-upgrade preserve-consumed audit row.
- One implementation quirk noted by the test author: `MaybeAutoOpenBeacon`'s recovery branch hardcodes `threshold = 2` (call site is `openBeacon(ctx, nextEpoch, 0, 0, 2)`), independent of the current `epoch_size` config. Fine while the live `committee_size=3, threshold=2` matches, but a wider committee would auto-open with a threshold below its intended value. Not in scope to fix this pass.

**Stuck-hand audit:** clean. Table 1 is healthily mid-hand 15163 (now 15164+ as new hands roll over) on epoch 42, t=2, n=3. The pre-v2 `init_hash_salt=null` hand 15048 the prior session was worried about resolved cleanly once dealer-0's null-guard fix (`1d3ed6c`) stopped the crash loop. No state needing manual intervention.

**NEW finding — shuffle "step 4/3" log** (NOT fixed):
- During the node0 restart spike on table 1 hand 15164, dealer-2 logged `Shuffle: our turn (step 4/3) for table 1 hand 15164` and then `submitting proof for round 4`, which the chain rejected with `deck already finalized`. Hand self-resolved (table moved on) but the position-computation path is producing impossible step indices. Three-member committee should only emit step ∈ {1,2,3} (or {0,1,2}), never 4. Plausible causes: dealer-2 is using the wrong validator index when computing position, or the daemon's retry loop is incrementing step without re-reading chain state, or a race after the brief node0 outage left dealer-2 with stale state. Worth a focused look the next time someone touches `apps/dealer-daemon/src/handlers/shuffle.ts`.

**Live state at end of session:** epoch 42, t=2/n=3, height ≈1,041,950, all 3 validators signing, all 3 dealers active, disk at 83% used (17 G free).

### 2026-05-19T~UTC — Audit Findings 1 + 3 Closed (DKG AEAD Complaint + MsgSit Password Commitment)
Closed the last two audit deferrals from the prior session. Both required proto regen + buf/protoc-gen-gogo workflow; that workflow is now also documented in the codebase paths used here.

**Finding 1 — DKG AEAD complaint path** (`apps/cosmos/proto/onchainpoker/dealer/v1/tx.proto`, `apps/cosmos/x/dealer/keeper/msg_server.go:659-870`, `apps/dealer-daemon/src/handlers/dkg.ts:244-340`):
- New `MsgDkgComplaintAEADBad` lets a recipient surface a malformed `scalar_ct`. Complainant publishes `dh = skR*U` + 96-byte Chaum-Pedersen DLEQ proof binding `dh` to `(pkR=skR*G, U)`. Chain runs `ocpcrypto.ChaumPedersenVerify(pkR, U, dh, proof)`, then `ocpcrypto.DkgScalarAeadOpen(dh, scalar_ct, aad=stored_proof)`.
- Three outcomes: AEAD tag fail → slash dealer; decrypt-but `s'*G != V - dh` → slash dealer; everything checks out → slash complainer for griefing. Mirrors `DkgComplaintInvalid`'s slash pattern including the `if dkgSlash(...) { applyPenalty(...) }` idempotency guard (code review catch — first cut omitted it; would have slashed a dealer once per recipient who filed against them).
- DLEQ exploits the fact that `(pkR, U)` are uniquely fixed per `(epoch, dealer, recipient_index)` on-chain, so the proof binding implicitly covers the whole tuple even though the Chaum-Pedersen transcript only commits to `(pkR, U, dh, a, b)`.
- `ocpcrypto.DkgScalarAeadOpen` exported (was internal `deriveScalarAeadKey + manual AES-GCM`) so the keeper can decrypt without inlining stdlib crypto.
- Daemon (`dkg.ts:244-340`) refactored: AEAD throws or `s*G != v-skR*u` mismatch now fires `chaumPedersenProve` (TS counterpart from `@onchainpoker/ocp-crypto`) + `client.dealerDkgComplaintAEADBad(...)`. Idempotency via filtered `dkg.complaints` lookup for prior `aead-bad`/`aead-spurious` from this validator.
- 10 new Go tests in `apps/cosmos/x/dealer/keeper/msg_server_aead_complaint_test.go` — happy paths, spurious slashing, bad DLEQ, both window boundaries, duplicate rejection, recipient_index mismatch, length validation, and crucially `TestDkgComplaintAEADBad_DoubleComplaintSlashesOnce` (regression guard for the code-review C1 bug).

**Finding 3 — MsgSit / MsgCreateTable password commitment** (`apps/cosmos/proto/onchainpoker/poker/v1/{tx,poker}.proto`, `apps/cosmos/x/poker/keeper/msg_server.go:42-220`, `apps/web/src/lib/passwordDigest.ts`, `apps/bot/src/bot.ts:185-211`, `packages/ocp-sdk/src/cosmos/client.ts`):
- Clean break: `MsgSit.password = 6` (string) and `MsgCreateTable.password = 12` (string) → `reserved 6;` `reserved 12;`. Replaced with `bytes password_commitment = 13;` `bytes password_salt = 14;` (CreateTable) and `bytes password_proof = 7;` (Sit). `TableParams.password_salt = 11;` new field; semantic of `password_hash = 10` shifted from "SHA256(pw)" to "SHA256(salt || pw)".
- All clients compute the digest themselves before broadcast: web via `crypto.subtle.digest`, bot via the same (Node 22 supports `crypto.subtle`). Plaintext never crosses the wire. Coordinator + SDK + frontend types updated to carry `passwordSalt` alongside `passwordHash`.
- Legacy-table dual path: pre-v2 tables with empty `password_salt` and unsalted `SHA256(pw)` in `password_hash` still authenticate because the v2 client computes `SHA256("" || pw) = SHA256(pw)` — byte-equal on the chain comparison. Verified by `TestSitPasswordLegacyTableBitCompat`.
- `x/poker.ConsensusVersion` bumped 1→2; `apps/cosmos/x/poker/keeper/migrations.go` stands up `keeper.Migrator` + `Migrate1to2` no-op (iterates tables, logs count + how many had passwords, returns nil — the proto3 default already populates `password_salt = []` on existing rows). Registers via `cfg.RegisterMigration(types.ModuleName, 1, m.Migrate1to2)` in `module.go:RegisterServices`.
- 4 new Go tests: `TestSitPasswordLegacyTableBitCompat`, `TestSitPasswordProofWrongLength`, `TestMigrate1to2_NoopOnEmptyKeeper`, `TestMigrate1to2_PreservesPasswordHash`. Existing `TestSitPasswordRequired`, `TestCreateTableWithPassword`, and `TestCreateTable_RejectsMalformedPasswordFields` rewritten for the new wire shape.

**Proto regen workflow** (cosmetic but worth recording for future sessions): `cd apps/cosmos/proto && PATH="/Users/discordwell/go/bin:$PATH" buf generate` for Go; for TS use `buf generate --template buf.gen.ts.yaml` (NOT `--config` — buf v1.68.2 misparses that). Outputs: Go to `apps/cosmos/x/{poker,dealer}/types/*.pb.go`, TS to `packages/ocp-sdk/src/cosmos/gen/onchainpoker/*`.

**Code review** (`/code-review` skill via subagent) caught the critical C1 bug: AEAD complaint handler discarded `dkgSlash`'s return → applyPenalty fired even when the validator was already in `dkg.Slashed`. Multi-recipient complaint scenario would have slashed the same dealer N times. Fixed in-line by mirroring the `DkgComplaintInvalid` pattern (slash + penalty + event all gated by `if slashedNow`). Reviewer also flagged that reserved-field replay drops historical plaintext silently — acceptable for testnet.

**Tests green**: 10/10 AEAD complaint tests, 7/7 password+migration tests; full Go suite ok; pnpm -r build clean across all 13 projects; coordinator tests 42/44 (the 2 `http-dealer-next` failures are pre-existing per the prior claudepad entry).

**Files modified/created** (29 total): proto x3, regen `.pb.go` x3, regen `.ts` x3; chain Go x5 (msg_server x2, codec, migrations [new], module, ocpcrypto/dkg_scalar_aead); test Go x3 (aead [new], migrations [new], msg_server_test); SDK TS x2 (ocp.ts, client.ts); daemon TS x2 (dkg.ts, daemon.ts); web TS x4 (passwordDigest [new], useGameState, parsePlayerTable, types); coordinator TS x2 (chain/cosmos.ts, types.ts); bot TS x1.

### 2026-05-19T~UTC — Threshold≥2 Operational + Five Medium Findings Closed
Continued from the partial rollout earlier. Closed the beacon protocol gap; chain successfully advanced to epoch 42 with `threshold=2, members=3`. Architecture claim "no single validator can see unrevealed cards" is now TRUE on the live testnet.

**Beacon stuck-recovery (the actual fix):**
- `f658ecb` height-gated MaybeAutoOpenBeacon + openBeacon to allow overwriting truly-stuck beacons. Initial naive form had a bug: it overwrote ANY unconsumed beacon whose reveal window had expired, including beacons that had collected enough reveals and were just waiting for BeginEpoch to consume them. Symptom: the beacon for epoch 42 cycled forever (open / 3 commits / window expires / overwrite / repeat).
- `b2393b1` second fix: only consider a beacon "stuck" (overwrite-eligible) when `len(Reveals) < Threshold`. Beacons with enough reveals are "consumable" — leave them alone for BeginEpoch.
- Gate is `beaconStuckRecoveryHeight = 1_036_000` so historical replay matches old app-hashes. Chain crossed gate ~10:43 UTC. New beacon for epoch 42 opened with windows `[1036000-1036050, 1036050-1036100]` initially, then cycled once (the buggy first version) before stabilizing on `[1036101-1036151, 1036151-1036201]` after the second fix landed.
- BeginEpoch fired manually at h=1036205 (just past reveal_close=1036201). Daemons did DKG commit + encrypted-share + complaint-resolution. Finalized at h~1036240. pk_epoch = `iLbmDQcrZicYdNy0NfF4J/UH3DR0Zk2zpzanIse8x2g=`. All 3 members carry distinct `pub_share` + `ephemeral_pubkey` (DKG-v2 path engaged).

**Five medium-severity findings closed (`f50c21d`):**
- Finding 2 — `IsDevnetChainID` substring → anchored regex `^[a-z0-9]+-(devnet|localnet|local)(-[a-z0-9]+)*$`. Blocks "bare DEVNET" + "ocp-mainnet-local-fork" + "mydevnet-foo" tricks. Live chain id "onchainpoker-testnet-1" correctly rejected (unchanged).
- Finding 4 — `MsgStartHand` griefing → 5-block inter-hand cooldown stamped to a new keeper-internal kv prefix `0x03` (no proto change). Defeats blind-drain-AFK-opponent.
- Finding 5 — `settleKnownShowdown` silent pot-burn → refund pro-rata across `EligibleSeats` when no eligible reveals; lone-revealer fast-path added; `PotRefunded` event emitted.
- Finding 6 — folded player can't `Leave` mid-hand → one-line guard relaxation; folded seats can leave (their commits are already debited).
- Finding 7 — `MsgCreateTable` unbounded params → caps: Label/Password 64, ActionTimeout 600s, DealerTimeout 1800s, BuyIn 1M CHIPS.
- Finding 8 — `chatByTable` unbounded map keys → `table_chat` rejects with "unknown table" when `store.getTable(tableId)` is null; defense-in-depth check in `store.addChatMessage` too.

Findings 1 (DkgEncryptedShare AEAD complaint path) and 3 (MsgSit plaintext password salt) DEFERRED — both require proto additions and buf/protoc-gen-gogo regen. Worth a focused future session.

**Post-rollout wet-test reproductions:** all earlier security fixes still hold — faucet bogus-address returns "invalid address" + IP-cooldown; RPC blocklist /dump_consensus_state etc return 404; WS chat sender server-derives to `anon-XXXX` (the spoofed `ocp1FAKE_IMPOSTOR_SHOULD_BE_IGNORED` ignored).

**Live state:** epoch 42 active, t=2 / n=3, chain at h≈1036250, all 3 validators signing. Coordinator + dealer daemons all up. Threshold cryptography genuinely threshold-protected now.

**Tests green throughout:** Go `apps/cosmos/...` ok. Coordinator `pnpm test` 42/44 pass (the 2 pre-existing http-dealer-next failures unchanged).

**Server housekeeping items still pending:**
- `/root/ocp-new-validator-mnemonics.txt` — root-readable backup of validator1/2 mnemonics (also embedded in dealer-1/2.env files)
- `/opt/ocp/bin/ocpd.{prev,with-consumable-fix,pre-stuck-fix}` rollback binaries — can prune
- `tx_index.db` still 3.7GB/node; you blocked `tx_search` at Caddy so it indexes for nothing. Setting `indexer = "null"` in config.toml and restarting would slowly reclaim that.

### 2026-05-19T~UTC — 3-Validator Rollout Attempt + Beacon Protocol Gap
Continued the security wet-test pass. Attempted to take the live testnet from `threshold=1, members=[1 validator]` to `threshold=2, members=[3 validators]` per the plan in `~/.claude/plans/mutable-humming-orbit.md`. Got most of the way; hit a real protocol gap that couldn't be unstuck in this session without more careful chain surgery. Left chain alive at epoch 41/t=1 with 3 bonded validators ready to participate once the gap is closed.

**What landed (good, deployed):**
- `1d3ed6c` dealer-daemon null-guard for pre-v2 init_hash_salt (== undefined → == null) — fixed a crash loop on hand 15048 (epoch 41, started before v2 init-salt field was added). DEPLOYED.
- `44771c9` dealer-daemon beacon commit/reveal participation. Added `dealerBeaconCommit` + `dealerBeaconReveal` SDK methods, `OPENBEACONWINDOW/COMMIT/REVEAL` type-URL registration, and a new `handlers/beacon.ts` that derives the salt deterministically as `HMAC-SHA256(state-passphrase, "ocp/v1/beacon/salt/v1" || validator || u64LE(epochId))` so daemon restarts don't need persisted secrets. Mirrors the Go `Commit()` hash domain exactly. Wired into the poll loop. DEPLOYED.
- `0136797` regression tests for the four security auth gates (bech32 decoder, WS identity, MsgTick seated-only-pre-deadline, MsgInitHand non-creator-non-validator-rejected). 36 TS + Go suite green. NOT deployment-critical (test-only).
- `867c2a8` chain-side threshold>=2 floor in MsgBeginEpoch + MsgOpenBeaconWindow + MaybeAutoOpenBeacon. 8 test files updated; all go tests pass. PUSHED but NOT DEPLOYED (a deploy would trigger restart and the chain currently can't advance past epoch 41 anyway).

**Operational state on ovh2:**
- 3 validators bonded, all in active set, all signing blocks. validator0=ocpvaloper1hffw87y…/6.561B tokens (existing), validator1=ocpvaloper1la3rhdxje7l5z…/9B tokens (new), validator2=ocpvaloper1g42mpe4ahl78t…/9B tokens (new). Mnemonics archived at /root/ocp-new-validator-mnemonics.txt (root-readable only). Operator keys are in node0's `--keyring-backend test` keyring under names `validator`, `validator1`, `validator2`.
- node0 RPC 26657 / LCD 1317 / P2P 26656 / ABCI 26658. node1 RPC 36657 / LCD 1318 / P2P 36656 / ABCI 36658. node2 RPC 46657 / LCD 1319 / P2P 46656 / ABCI 46658. Full-mesh persistent_peers. `addr_book_strict=false` + `allow_duplicate_ip=true` on all three so localhost peering works. pprof ports 6060/36060/46060. grpc 9090/9091/9092, grpc-web 9091/9191/9292.
- Snapshot config: `snapshot-interval=10, snapshot-keep-recent=2` on all three. node1 and node2 state-synced from node0 at trust_height=1035100. App-hashes match across all three nodes.
- dealer-0.env, dealer-1.env, dealer-2.env each have COMMITTEE_SIZE=3, THRESHOLD=2. dealer-1/2 have AUTO_BEGIN_EPOCH=false (only dealer-0 races; race is benign per Plan-agent analysis but cleaner without it). DEALER_STATE_DIR per instance under /opt/ocp/state/dealer-{0,1,2}. dealer-1/2 mnemonics point at validator1/validator2 respectively.

**What went sideways (and is reverted):**
- `c51c588` + `45c878a` tried to unstick the epoch-42 beacon by letting MaybeAutoOpenBeacon overwrite an expired-unconsumed beacon. The first commit was incomplete (the bypass was after both guards, but `openBeacon` has its OWN internal "window already open" guard that I didn't bypass). The second commit relaxed the same-epoch guard but caused the deployed chain to crash on restart: BeginBlock called MaybeAutoOpenBeacon → that called openBeacon → openBeacon's internal guard rejected → error propagated up → `error during handshake: error on replay`. Live chain wouldn't start. Recovered via `cp /opt/ocp/bin/ocpd.prev /opt/ocp/bin/ocpd`. Both commits reverted in `910926c`.

**Beacon protocol gap (the actual blocker):**
- Commit `1732ff7` added a BeginBlocker that auto-opens beacon windows AND enforces that production chain ids (anything not matching `devnet|local`) require a finalized beacon for BeginEpoch's `rand_epoch`. Before today, no validator process participated in BeaconCommit/Reveal — the auto-open kept firing, windows kept expiring with zero reveals, no beacon ever finalized. By the time I tried to advance to epoch 42 there was a stuck beacon with `epoch_id=42, commit_open=1033424, commit_close=1033474, reveal_close=1033524, threshold=1, Final=∅` and the chain was already past block 1035300 — both windows long expired.
- The daemon-side beacon participation I added in `44771c9` is correct code but it can't help with the stuck beacon: the chain refuses to open a new beacon (any guard) AND refuses to consume an unfinalized one. Forward progress needs an explicit "clear stuck" recovery path in `openBeacon` itself, or a separate `MsgDiscardStuckBeacon` admin msg. Anything that touches `openBeacon`'s internal guard MUST be validated on a local dev chain first — that's what burned us.
- Fast path back to a working state would be option B from the earlier review (add "testnet" to `IsDevnetChainID`'s substring match). That trades the threshold>=2 win for an immediate unstick but widens medium-severity Finding 2 (proposer-influenceable randomness on any chain id containing "testnet"). I declined this option at the time and stand by that, but flagging it here as the documented escape hatch.

**Repo state:** main = `910926c` (revert). Local commits all pushed. No outstanding diffs in working tree. Chain code in main builds + passes all tests. Deploy would not regress production (would re-apply the threshold floor + daemon beacon code that's already deployed via NO_RESTART staging, plus the test-only changes). The stuck-beacon issue persists regardless.

**Files to know for the next session:**
- `apps/cosmos/x/dealer/keeper/beacon.go:88` — `openBeacon` internal guard at line ~96-103 is where a future fix needs to allow stuck-beacon overwrite (with a height-vs-RevealCloseHeight check, mirroring what I tried to do upstream in MaybeAutoOpenBeacon).
- `apps/dealer-daemon/src/handlers/beacon.ts` — daemon participation; correctness validated against the chain (no hash-mismatch errors observed; only "commit window closed" / "epoch_id mismatch" from environmental issues).
- `/root/ocp-new-validator-mnemonics.txt` on ovh2 — validator1/validator2 mnemonics in case of rotation.

### 2026-05-19T~UTC — Security Wet-Test + Three Live-Exploit Fixes
Continuous-wet-test session against production at `discordwell.com/ocp`. Confirmed THREE live-exploitable bugs, then dispatched three parallel opus sub-agents (faucet, ws, chain-auth) to close them in disjoint files. Code-review surfaced one prod blocker (WS per-IP cap collapsed behind nginx without X-Forwarded-For honoring) which was fixed in-line. Pre-existing `coordinator-outage.test.ts` initially regressed on the WS tableId regex tightening — relaxed `TABLE_ID_RE` from `^[1-9][0-9]{0,9}$` to `^[a-zA-Z0-9_-]{1,32}$` so mock-chain table IDs like "t1" still parse; the per-IP rate cap is the real memory-growth defense, not the regex.
- **Faucet hardening** (`apps/coordinator/src/{faucet.ts,http.ts}`). Inlined BIP-173 bech32 decoder (no new deps — pnpm strict resolution blocks reaching transitive @cosmjs/encoding). Now decodes + HRP-matches before any chain interaction. Per-IP spam cooldown (clamped `min(ipCooldownMs, 60_000)`) is SET on entry to every request, before bech32 validation, preventing the 10/s drain pattern I observed live (was: cooldowns only set on success → bogus addresses bypassed gating). On-success path still sets the full `ipCooldownMs` (overrides the short one). HTTP handler now allowlists known-safe error prefixes; everything else becomes generic `"faucet error"` with `console.error` server-side — closes the `/Users/discordwell/go/pkg/mod/cosmossdk.io/errors@v1.1.0/errors.go:165` filesystem-path leak.
- **WS chat impersonation** (`apps/coordinator/src/ws.ts`). Server-derives per-connection `identity = anon-NNNN` via `randomUUID()`; the client-supplied `sender` field is now ignored (chat_history shows the anon-id, not whatever the client claimed). Per-IP-per-minute cap (30 chats) on top of the existing per-WS 1 msg/sec — defeats the multi-connection bypass I demonstrated (10 conns × 1 msg/s = 10× impersonation throughput). XFF first-hop is honored mirroring `http.ts:getClientId` so the cap fires behind nginx. `TABLE_ID_RE` filter on subscribe/unsubscribe prevents arbitrary-string `chatByTable` growth.
- **MsgTick + MsgInitHand auth gaps** (`apps/cosmos/x/{poker,dealer}/keeper/msg_server.go`). `Tick`: caller bech32-validated + must be seated UNLESS `BlockTime() >= h.ActionDeadline` (post-deadline path stays permissionless to keep AFK seats unstickable). `InitHand`: gamemaster bypass (`req.Caller == t.Creator`) else falls through to existing `requireActiveBondedCaller` helper (same path as `MsgOpenBeaconWindow`). Uses `ErrInvalidRequest.Wrap` in poker (no `ErrUnauthorized` sentinel in that types pkg) and `ErrUnauthorized` in dealer.
- **Wet-test confirmed exploits before fix**: chat as `ocp1dsjqvwna99c5ahgq5vsex5f5x02pk20erz0uvx` (real faucet operator address) succeeded; 10× parallel faucet drips with bogus bech32 completed in 186ms with zero rate-limit; CometBFT RPC at `/ocp/rpc/` publicly exposed including `broadcast_tx_async` (accepts `tx=0xff` returns hash). Threshold-1 single-validator on the live testnet means the validator holds the full epoch secret — the architecture's "no single validator can see cards" claim is broken at the deployment-config level (not in this fix scope; testnet operator decision).
- **Code-review** (opus sub-agent) verdict: ready-to-merge with the XFF fix applied. Tests-after follow-up flagged: regression tests for the 4 auth gates (bech32 decoder, ws identity, MsgTick seated-only-pre-deadline, MsgInitHand non-creator-non-validator-rejected) all required by "every fix requires a test" rule.
- **Tests green**: `pnpm -r build` clean (all 13 projects); coordinator 16/16 pass including `coordinator-outage` and `http-faucet`; `go test ./apps/cosmos/...` all packages pass. Pre-existing `http-dealer-next.test.ts` still failing (unchanged by this work).

### 2026-04-19T~UTC — Beacon: OpenBeaconWindow + Keeper Tests
Closed the last two audit follow-ups from the post-merge review:
- **`MsgOpenBeaconWindow`** — new RPC + keeper handler (`apps/cosmos/x/dealer/keeper/beacon.go`). Gates on active-bonded caller; rejects reopen while a window is live; localnet defaults (5/5 blocks, threshold=1). Emits `BeaconOpened` event. Previously `consumeBeaconForEpoch` was unreachable on any non-devnet chain id because nothing wrote `BeaconState` — only a doc-comment gestured at this message.
- **24 keeper tests** — `msg_server_beacon_test.go` covering full beacon lifecycle (open/commit/reveal/consume). Catches the bug classes flagged by the original review: validator-address double-cast (now prevented by a non-bonded-rejected test), missing reveal-side auth gate (symmetric non-bonded test), devnet-vs-production gating, below-threshold fallback, committed-but-not-revealed slashing (inspects emitted events). Extended `fakeDealerStakingKeeper.Validator(...)` to look up into `bonded` so `SlashAndJailValidator` resolves correctly in tests — purely additive.
- **Stale-comment cleanup** — removed the 15-line `dealer_beacon_regen` build-tag preambles from `beacon.go` and `codec_beacon.go` (tags dropped in 0983b2e), fixed the "no-op in default build" comment in `codec.go`, corrected reference to `beacon_select.go` → `beacon_select_beacon.go` in `msg_server.go`.
- Commit `c2a3fc9`. `go test ./apps/cosmos/...` green.

### 2026-04-19T~UTC (later) — DKG v2 Follow-ups: Primitive + Chain + Daemon
Landed the critical cryptographic fix from the audit — encrypted-share DKG replacing the plaintext reveal leak — across three commits:
- **6689552** Go port of DkgEncShare NIZK primitive + cross-lang test vector in both `docs/test-vectors/ocp-crypto-v1.json` and the cosmos testdata mirror. TS and Go now byte-for-byte verify the same 160-byte proof.
- **0983b2e** Hybrid scalar-AEAD primitive (AES-256-GCM, key=SHA256(domain||r·pkR), iv=0^12, AAD=proof bytes, 48-byte ct) resolving the scalar-witness gap from DKG-V2.md §4. Proto additions (`MsgDkgEncryptedShare`, `DealerDKGEncryptedShare`, `DealerMember.ephemeral_pubkey`, `MsgDkgCommit.ephemeral_pubkey`). Keeper handler validates NIZK + stores ct. Fix to pre-commit code review: `BeaconCommit` address double-cast and `BeaconReveal` missing auth gate.
- **01347c9** Dealer daemon wired: `handleDkgCommit` now generates per-epoch ElGamal keypair and publishes pkR. New `handleDkgEncryptedShares` submits one proof+ct per recipient. `collectEncryptedShareScalars` decrypts incoming shares + AEAD + consistency-checks `s·G==v−skR·u`. `handleDkgAggregate` prefers encrypted scalars, falls back to plaintext reveals for any dealer still on v1. SDK client gains `dealerDkgEncryptedShare` method.

Status: both flows coexist. Chain accepts `MsgDkgShareReveal` and `MsgDkgEncryptedShare`. Once all daemons publish encrypted shares, the reveal path is idle in practice. Remaining: `params.DkgVersion` governance switch to hard-deprecate reveals at an epoch boundary — separate PR.

Follow-up #2 (align `apps/chain/internal/app/dealer.go`) closed **without porting**: the app is explicitly labeled legacy/devnet-only in its own README, gated behind `OCP_CHAIN_PROFILE=devnet`, and enforced as such by `scripts/check-runtime-target.sh`. Aligning it with cosmos-tree security fixes was ruled low-value given zero production exposure. Verified `apps/chain` still builds + all its tests still pass (untouched by the session).

### 2026-04-19T~UTC — Cryptographic Audit + 10-Issue Fix Integration
Full crypto audit of the dealer protocol, then 10 parallel opus sub-agents (one per finding) in isolated worktrees, manually merged back:
- **Critical finding**: DKG reveals were publishing plaintext shares `f_i(j)` on-chain — every observer could Lagrange-interpolate the full epoch secret. Threshold trust was effectively null.
- **Fix #1** (Agent 1 — ocp-crypto): New NIZK primitive `dkgEncShareProve`/`dkgEncShareVerify` at `packages/ocp-crypto/src/proofs/dkgEncShare.ts` (160-byte proof, domain `"ocp/v1/dkg/encshare"`). Proves ElGamal ciphertext `(U,V)` under recipient pk is consistent with Feldman commitments evaluated at recipient index. Design doc at `docs/DKG-V2.md` (not yet wired on-chain).
- **Fix #2** (Agent 2): Moved `packages/dkg` (toy 61-bit Schnorr, default `seed="seed"`, `hmacToy`) → `deprecated/dkg-prototype/` with `DEPRECATED.md`. Removed from workspace scripts.
- **Fix #3** (Agent 3): Commit-reveal randomness beacon replacing proposer-influenceable `DevnetRandEpoch` for committee selection. New proto msgs `MsgBeaconCommit`/`MsgBeaconReveal`, `BeaconState` object, `beacon.go` pure helpers (commit/reveal/final), keeper handlers, `selectRandEpochForSampling` gated to devnet chain ids. Fallback only on chain id matching `/devnet|local/i`.
- **Fix #4** (Agent 4): Per-hand forward-secrecy hedge. `deriveHandScalar` v2 signature `(epochID, tableID, handID, initHeight int64, initSalt []byte)` with domain `"ocp/v1/dealer/hand-derive/v2"`. `DealerHand` proto gains `init_height=20` / `init_hash_salt=21`; `InitHand` captures `sdkCtx.BlockHeader().LastBlockId.Hash`; `SubmitEncShare`/`SubmitPubShare` read from `dh`. Daemon-side TS updated too.
- **Fix #5** (Agent 5): argon2id KDF in `apps/dealer-daemon/src/state.ts` via `@node-rs/argon2` (memoryCost 64 MiB, timeCost 3, ~80ms on M4 Max). v2 file format `0x02 || salt(16) || iv(12) || tag(16) || ct`; v1 legacy auto-migrates on next save. Empty passphrase throws unless `DEALER_STATE_ALLOW_UNENCRYPTED=1`. `save`/`load` now async — all callers `await`ed.
- **Fix #6** (Agent 6): Shuffle proof v2 binds `(tableId, handId, round, shuffler)` into every Fiat-Shamir transcript (TS + Go). Wire format: `u64le(tableId)||u64le(handId)||u16le(round)||u16le(shufflerLen)||shuffler_utf8`. `BuildShuffleContext` helper added in both languages. v1 path retained for backward compat.
- **Fix #7** (Agent 7): `ShuffleProveOpts.seed` → `seedUnsafeForTestsOnly`; throws unless `NODE_ENV=test` or `OCP_ALLOW_UNSAFE_SEED=1`. Prevents nonce-reuse leakage (rho recovery via `(z1-z2)/(e1-e2)`). Production daemon now uses library's internal `randomBytes(32)`.
- **Fix #8** (Agent 8): `dkgTranscriptRoot` replaced `json.Marshal` with canonical length-prefixed binary encoding (domain `"ocp/v1/dkg/transcript/v2"`). Defensive sort of all slices. 32 field-sensitivity subtests.
- **Fix #9** (Agent 9): `Transcript.challengeScalar` folds challenge digest back into persistent state in both TS and Go. Structured so single-challenge callers produce byte-identical outputs (every existing proof still verifies — vectors unchanged).
- **Fix #10** (Agent 10): `pointToCardID` O(1) map lookup via `init()`-populated `cardPointByBytes`. Benchmark: ~65-130x faster.
- **Integration**: Manual 3-way merges on `logic.go` (agents 4+8+10), `msg_server.go` (3+4+6), `dealer.proto` (3+4), `encshares.ts`/`pubshares.ts` (4+5), `msg_server_overflow_test.go` (3+6). Installed `buf` + `protoc-gen-gogo` via `go install`; regen'd `.pb.go`; dropped `dealer_beacon_regen` build tags.
- **Tests**: Go `apps/cosmos/...` + `apps/chain/...` green. `pnpm -r build` clean (13 projects). ocp-crypto 27/27, ocp-shuffle 21/21, dealer-daemon 26/26. Pre-existing coordinator `http-dealer-next` 2 failures unchanged (not touched by any agent).

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

## Key Findings

- **Client IP behind nginx = the RIGHT-most `X-Forwarded-For` hop, not the left**: `deploy/nginx-ocp.conf` uses `$proxy_add_x_forwarded_for`, which APPENDS the real peer to whatever the client sent. So the trustworthy client IP is the last element (with 1 proxy in front); reading `split(",")[0]` trusts a fully client-controlled value and lets an attacker mint a fresh rate-limit key per request. Coordinator IP extraction is centralized in `apps/coordinator/src/clientIp.ts` (`clientIpFromForwarded`, `trustedHops` from the right, default 1 via `COORDINATOR_TRUSTED_PROXY_HOPS`). If the prod topology ever gains another proxy (CDN), bump the hop count or the cap collapses all clients into one bucket.
- **Verify with `pnpm test`, not `pnpm -r test`**: The root `test:unit` script (what `pnpm test` runs, and what CI's "Unit Tests + Build" step runs) has orchestration-only steps that the recursive per-package runner never executes: `pnpm runtime:check` (`scripts/check-runtime-target.sh`), `node --test scripts/test/*.test.mjs`, `pnpm web:build`, and `pnpm chain:test` (`apps/chain` go test). A `pnpm -r --if-present test` sweep can be 100% green while `pnpm test` is red. A README reword silently broke `runtime:check` and went unnoticed for ~3 months (2026-03-20 → 2026-06-17) for exactly this reason. Always run the root `pnpm test` before declaring suites green.
- **DKG share distribution**: Uses the chain's complaint/reveal mechanism as the share distribution channel. Every validator files `DkgComplaintMissing` against every other after commit phase, forcing on-chain `DkgShareReveal`. Must aggregate shares BEFORE `FinalizeEpoch` since finalization clears DKG state.
- **Hole card crypto**: Enc share format is `U(32)||V(32)`, decrypt as `V - skPlayer * U = d_j = xHand_j * C1`. Lagrange on group elements yields combined partial decryption `D`. Card recovery: `M = C2 - D`, lookup `M` in precomputed table of `mulBase(BigInt(cardId + 1))` for id 0..51 (uses `id+1` to avoid identity point, matching Go chain's `cardPoint()`).
- **TWO dealer data sources — don't confuse them**: `table.hand.dealer` from the **poker** module's table query (`/onchainpoker/poker/v1/tables/{id}`) is a thin `DealerMeta` (poker.proto:68) — ONLY epoch_id/deck_size/deck_finalized/hole_pos/cursor/reveal_pos/reveal_deadline. The encrypted **deck**, per-position **enc_shares**, pub_shares, and reveals live on the **dealer** module's `DealerHand` (dealer.proto:236), served at `/onchainpoker/dealer/v1/tables/{t}/hands/{h}` (SDK `getDealerHand` unwraps `.hand`). Each `DealerEncShare` already carries the validator's 1-based Shamir `index` (field 3) — read it straight off the share for Lagrange; there is NO `members` array on either the DealerMeta or the DealerHand (members live on `DealerEpoch`). Anything needing deck/shares (coordinator `/v1/dealer/hand/.../{enc-shares,ciphertext}`, the web `useHoleCards` hook) MUST hit the dealer endpoint; reading them off the poker DealerMeta silently yields empty. Hole **positions** are the exception — they ARE on DealerMeta.hole_pos.
- **Card label encoding**: `cards.Card` id = `suit*13 + (rank-2)`, suits `c/d/h/s` = 0..3, ranks 2..14. `Card.String()` emits letter labels ("As","Th","2c") — that's what HoleCardRevealed events carry. The web `CardFace.cardIdFromLabel` parses both that letter format and the internal glyph format ("A♠","10♥"); `CardFace` render decodes the numeric id the same way.
- **Security items resolved** (2026-02-20): All 8 deferred items addressed — hex length check, threshold check, XSS SECURITY comment + future mitigation path noted, DKG re-fetch between phases, pk mismatch warning, error logging, committed-only complaint filter, module-level card table.
- **Pre-existing coordinator build error**: `apps/coordinator/src/http.ts:218` has a TypeScript null check issue (`config.corsOrigins`) that predates these changes.
- **Vite base path**: Already configured to `/ocp/` in vite.config.ts.
- **GoLevelDB empty-value quirk**: `GoLevelDB.Get()` returns `nil` for keys stored with `[]byte{}` (empty value). `GoLevelDB.Has()` uses `Get()` internally and checks `bytes != nil`, so it returns false for empty values. Iterators still find these keys. This affects IAVL's `SaveEmptyRoot()` which writes `[]byte{}` for empty trees, making `hasVersion()` and `GetRoot()` fail for stores with no data.
- **Store version compatibility**: SDK pseudo-version `v0.54.0-rc.1` requires `cosmossdk.io/store v1.3.0-beta.0` (for `ObjKVStore`), forced via `replace` directive. Both SDK and ibc-go pin this same version.
- **Coordinator has NO process-level safety net**: there is no `process.on("uncaughtException"|"unhandledRejection")` handler anywhere in `apps/coordinator`. Any synchronous throw inside the chain adapters' RPC-WebSocket `message` handler (`cosmos.ts`/`comet.ts`) crashes the entire relay and disconnects every player. Two invariants now keep that handler total: (1) `sendJson` (`ws.ts`) swallows `ws.send`/`JSON.stringify` failures — best-effort, never throws; keep it that way. (2) Chain-event fan-out goes through `chain/dispatch.ts` `dispatchChainEvents`, which isolates per-subscriber throws. If you ever add a process-global handler, prefer logging + graceful shutdown over silently swallowing (a swallowed `uncaughtException` can leave the process in a corrupt state).
