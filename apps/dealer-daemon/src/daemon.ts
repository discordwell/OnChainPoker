import WebSocket from "ws";
import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "./config.js";
import type { EpochStateStore } from "./state.js";
import { log, logError } from "./log.js";
import {
  handleDkgCommit,
  handleDkgComplaints,
  handleDkgReveals,
  handleDkgAggregate,
} from "./handlers/dkg.js";
import { handleShuffle } from "./handlers/shuffle.js";
import { handleEncShares } from "./handlers/encshares.js";
import { handlePubShare } from "./handlers/pubshares.js";
import {
  maybeBeginEpoch,
  maybeFinalizeEpoch,
  maybeFinalizeDeck,
  maybeFinalizeReveal,
  maybeTick,
  maybeDealerTimeout,
  maybeStartAndInitHand,
} from "./handlers/automation.js";

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function pick(obj: any, ...keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return obj[k];
    }
  }
  return undefined;
}

function normalizePhase(raw: unknown): string {
  const s = String(raw ?? "").toLowerCase();
  const clean = s.startsWith("hand_phase_") ? s.slice("hand_phase_".length) : s;
  if (clean === "betting") return "betting";
  if (clean === "shuffle") return "shuffle";
  if (clean === "await_flop") return "awaitFlop";
  if (clean === "await_turn") return "awaitTurn";
  if (clean === "await_river") return "awaitRiver";
  if (clean === "await_showdown") return "awaitShowdown";
  if (clean === "showdown") return "showdown";
  return clean;
}

function expectedRevealPos(table: any): number | null {
  const h = table?.hand;
  const dh = h?.dealer;
  if (!h || !dh) return null;
  if (!dh.finalized) return null;

  const phase = normalizePhase(h.phase);

  const explicitPos = asNumber(pick(dh, "revealPos", "reveal_pos"));
  if (explicitPos != null && Number.isFinite(explicitPos) && explicitPos >= 0 && explicitPos !== 255) {
    return explicitPos;
  }

  if (phase === "awaitFlop" || phase === "awaitTurn" || phase === "awaitRiver") {
    const cursor = asNumber(dh.cursor) ?? 0;
    const boardLen = Array.isArray(h.board) ? h.board.length : 0;
    return cursor + boardLen;
  }

  if (phase === "awaitShowdown") {
    const holePosRaw = pick(dh, "holePos", "hole_pos");
    const holePos: number[] = Array.isArray(holePosRaw)
      ? holePosRaw.map((x: unknown) => asNumber(x)).filter((x): x is number => x !== undefined)
      : [];
    if (holePos.length !== 18) return null;

    const reveals = new Set<number>();
    for (const r of (dh.reveals ?? []) as any[]) {
      const rp = asNumber(r?.pos);
      if (rp != null && Number.isFinite(rp)) reveals.add(rp);
    }

    const inHand = Array.isArray(pick(h, "inHand", "in_hand")) ? pick(h, "inHand", "in_hand") : [];
    const folded = Array.isArray(h.folded) ? h.folded : [];
    const eligible: number[] = [];
    for (let seat = 0; seat < 9; seat++) {
      if (!inHand[seat] || folded[seat]) continue;
      const p0 = asNumber(holePos[seat * 2]);
      const p1 = asNumber(holePos[seat * 2 + 1]);
      if (p0 != null && p0 >= 0 && p0 !== 255) eligible.push(p0);
      if (p1 != null && p1 >= 0 && p1 !== 255) eligible.push(p1);
    }
    eligible.sort((a, b) => a - b);
    for (const p of eligible) {
      if (!reveals.has(p)) return p;
    }
  }

  return null;
}

function parseMembersFromEpoch(epoch: any): Array<{ validator: string; index: number }> {
  const raw = epoch?.members ?? epoch?.Members ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m: any) => {
      const validator = String(m?.validator ?? m?.Validator ?? m?.validatorId ?? "");
      const index = asNumber(m?.index ?? m?.Index);
      if (!validator || index === undefined) return null;
      return { validator, index };
    })
    .filter((x: any): x is { validator: string; index: number } => x !== null);
}

export class DealerDaemon {
  private readonly client: OcpCosmosClient;
  private readonly config: DealerDaemonConfig;
  private readonly stateStore: EpochStateStore;
  private abortController: AbortController | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private processing = false;

  constructor(args: {
    client: OcpCosmosClient;
    config: DealerDaemonConfig;
    stateStore: EpochStateStore;
  }) {
    this.client = args.client;
    this.config = args.config;
    this.stateStore = args.stateStore;
  }

  async start(): Promise<void> {
    log(`Daemon starting for validator ${this.config.validatorAddress}`);
    log(`Gamemaster: ${this.config.isGamemaster}, Poll interval: ${this.config.pollIntervalMs}ms`);

    this.abortController = new AbortController();
    this.startPolling();
  }

  async stop(): Promise<void> {
    log("Daemon stopping");
    this.abortController?.abort();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startPolling(): void {
    // Initial poll
    void this.poll();
    // Then interval
    this.pollTimer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      await this.pollOnce();
    } catch (err) {
      logError("poll error", err);
    } finally {
      this.processing = false;
    }
  }

  private async pollOnce(): Promise<void> {
    // 1. Check epoch/DKG state
    const epoch = await this.client.getDealerEpoch().catch(() => null);
    const dkg = await this.client.getDealerDkg().catch(() => null);

    if (!epoch && !dkg) {
      // No epoch and no DKG — try to begin one
      await maybeBeginEpoch({ client: this.client, config: this.config });
      return;
    }

    // If DKG is in progress, handle the full multi-party DKG flow
    if (dkg) {
      const dkgMembers = parseMembersFromEpoch(dkg);
      const epochId = asNumber(pick(dkg, "epochId", "epoch_id")) ?? 0;

      if (dkgMembers.length > 0 && epochId > 0) {
        // Phase 1: Submit our polynomial commitment
        await handleDkgCommit({
          client: this.client,
          config: this.config,
          stateStore: this.stateStore,
          epochId,
          members: dkgMembers,
        }).catch((err) => logError("DKG commit error", err));

        // Re-fetch DKG state after commit to pick up new commits/complaints
        const dkgAfterCommit = await this.client.getDealerDkg().catch(() => null);
        if (!dkgAfterCommit) return;

        // Phase 2: File "missing" complaints for all other members
        // (forces on-chain share reveals since there's no off-chain channel)
        await handleDkgComplaints({
          client: this.client,
          config: this.config,
          epochId,
          members: dkgMembers,
          dkg: dkgAfterCommit,
        }).catch((err) => logError("DKG complaint error", err));

        // Re-fetch DKG state after complaints to pick up new reveals
        const dkgAfterComplaints = await this.client.getDealerDkg().catch(() => null);
        if (!dkgAfterComplaints) return;

        // Phase 3: Reveal shares for complaints targeting us
        await handleDkgReveals({
          client: this.client,
          config: this.config,
          stateStore: this.stateStore,
          epochId,
          members: dkgMembers,
          dkg: dkgAfterComplaints,
        }).catch((err) => logError("DKG reveal error", err));

        // Re-fetch DKG state after reveals for aggregation
        const dkgAfterReveals = await this.client.getDealerDkg().catch(() => null);
        if (!dkgAfterReveals) return;

        // Phase 4: Aggregate secret share from reveals (must happen BEFORE finalization)
        const aggregated = await handleDkgAggregate({
          stateStore: this.stateStore,
          config: this.config,
          epochId,
          members: dkgMembers,
          dkg: dkgAfterReveals,
        }).catch(() => false);

        // Phase 5: Try to finalize epoch (only after aggregation succeeds)
        if (aggregated) {
          await maybeFinalizeEpoch({
            client: this.client,
            config: this.config,
            epochId,
          }).catch((err) => logError("maybeFinalizeEpoch error", err));
        }
      }
      return;
    }

    if (!epoch) return;

    const epochId = asNumber(pick(epoch, "epochId", "epoch_id", "EpochId")) ?? 0;
    const epochMembers = parseMembersFromEpoch(epoch);

    // Verify our secret share was computed during DKG (should already be set)
    const secrets = this.stateStore.load(epochId);
    if (secrets && secrets.secretShare === "0") {
      log(`WARNING: epoch ${epochId} finalized but secret share not computed — DKG may have been incomplete`);
    }

    // 2. List tables and process each
    const tableIds = await this.client.getTables().catch(() => [] as string[]);

    for (const tableId of tableIds) {
      await this.processTable(tableId, epochId, epochMembers).catch((err) =>
        logError(`table ${tableId} processing error`, err)
      );
    }
  }

  private async processTable(
    tableId: string,
    epochId: number,
    epochMembers: Array<{ validator: string; index: number }>
  ): Promise<void> {
    const table = await this.client.getTable(tableId).catch(() => null);
    if (!table) return;

    const hand = table?.hand;
    const handId = String(pick(hand, "handId", "hand_id") ?? "");

    if (!hand || !handId) {
      // No active hand — maybe start one
      await maybeStartAndInitHand({
        client: this.client,
        config: this.config,
        tableId,
        epochId,
      }).catch(() => {});
      return;
    }

    const phase = normalizePhase(hand.phase);
    const dealer = hand.dealer ?? hand.dealerState;

    if (phase === "shuffle") {
      const shuffleStep = asNumber(dealer?.shuffleStep ?? dealer?.shuffle_step) ?? 0;

      // Try to shuffle
      await handleShuffle({
        client: this.client,
        config: this.config,
        tableId,
        handId,
        shuffleStep,
        epochMembers,
      }).catch((err) => logError("shuffle error", err));

      // Check if all shuffles done, try to finalize deck
      const qualCount = epochMembers.length;
      if (shuffleStep >= qualCount) {
        await maybeFinalizeDeck({
          client: this.client,
          config: this.config,
          tableId,
          handId,
        }).catch(() => {});
      }
      return;
    }

    // After deck finalization, submit enc shares for hole cards
    if (dealer?.finalized && phase === "betting") {
      await handleEncShares({
        client: this.client,
        config: this.config,
        stateStore: this.stateStore,
        tableId,
        handId,
        epochId,
      }).catch((err) => logError("enc shares error", err));
      return;
    }

    // Reveal phases
    if (
      phase === "awaitFlop" ||
      phase === "awaitTurn" ||
      phase === "awaitRiver" ||
      phase === "awaitShowdown"
    ) {
      const pos = expectedRevealPos(table);
      if (pos != null) {
        await handlePubShare({
          client: this.client,
          config: this.config,
          stateStore: this.stateStore,
          tableId,
          handId,
          epochId,
          pos,
        }).catch((err) => logError("pub share error", err));

        // Try to finalize the reveal
        await maybeFinalizeReveal({
          client: this.client,
          config: this.config,
          tableId,
          handId,
          pos,
        }).catch(() => {});
      }
      return;
    }

    // Betting phase - check for timeouts
    if (phase === "betting") {
      await maybeTick({
        client: this.client,
        config: this.config,
        tableId,
      }).catch(() => {});
      return;
    }

    // Dealer timeout check
    if (dealer && !dealer.finalized && phase !== "shuffle") {
      await maybeDealerTimeout({
        client: this.client,
        config: this.config,
        tableId,
        handId,
      }).catch(() => {});
    }
  }
}
