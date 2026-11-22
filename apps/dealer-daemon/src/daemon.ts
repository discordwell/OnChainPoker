import {
  txFailureOf,
  type DealerDkg,
  type DealerEpoch,
  type OcpCosmosClient,
  type TxFailure,
  type ValidatorInfo,
} from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "./config.js";
import type { EpochStateStore } from "./state.js";
import { log, logError, logProgress } from "./log.js";
import {
  POLICY,
  afterUnjail,
  assertNever,
  decide,
  describe,
  headlines,
  short,
  shufflersOf,
  unjailBlock,
  unjailWaitMs,
  type Action,
  type ChainView,
  type Decision,
  type Me,
  type Memory,
  type Situation,
} from "./rotation.js";
import { beaconCommitment, beaconSalt } from "./handlers/beacon.js";
import { encryptShareFor, plainShareFor, prepareCommit, settleShare, syncShares, type SecretsStore } from "./handlers/dkg.js";
import { handleShuffle } from "./handlers/shuffle.js";
import { handleEncShares } from "./handlers/encshares.js";
import { handlePubShare } from "./handlers/pubshares.js";
import {
  maybeFinalizeDeck,
  maybeFinalizeReveal,
  maybeTick,
  maybeDealerTimeout,
  maybeStartAndInitHand,
} from "./handlers/automation.js";

/** A node that could not serve a finalized DKG at its past height is asked again after this many blocks. */
const FINAL_DKG_RETRY_BLOCKS = 120;

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
  if (!pick(dh, "finalized", "deckFinalized", "deck_finalized")) return null;

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

/** What dealTables hands each table: the epoch to deal on, who shuffles, and whether a new hand may start. */
type HandDuty = {
  epochId: number;
  shufflers: readonly { validator: string; index: number }[];
  startHands: boolean;
};

function failureSummary(f: Exclude<TxFailure, { kind: "not-a-tx" }>): string {
  switch (f.kind) {
    case "rejected":
      return f.log;
    case "failed":
      return `code ${f.code} at height ${f.height}: ${f.log}`;
    case "expired":
      return `not in any block through ${f.timeoutHeight} (hash ${f.hash})`;
    case "unknown":
      return `${f.why}; it is in a block by height ${f.timeoutHeight} or it is dead (hash ${f.hash})`;
    default:
      return assertNever(f);
  }
}

export class DealerDaemon {
  private readonly client: OcpCosmosClient;
  private readonly config: DealerDaemonConfig;
  private readonly stateStore: EpochStateStore;
  private readonly me: Me;
  private abortController: AbortController | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private processing = false;

  /** Height at which this process first saw the chain unable to deal, with no break since. In memory: a restart waits longer. */
  private rotatingSince: number | null = null;
  /** The last probe of the state directory, and the beacon window it was taken in. */
  private storeProbe: { usable: boolean; window: number | null } | null = null;
  /** Key of the last headline printed per slot, so a change prints once. */
  private readonly printed: Record<string, string> = {};
  /** The epoch, DKG and next id the secrets directory was last pruned for. */
  private prunedFor = "";
  /** A finalized DKG is read at a past height at most once per epoch, and retried no sooner than this height. */
  private finalDkg = { epochId: 0, synced: false, retryAt: 0 };

  constructor(args: {
    client: OcpCosmosClient;
    config: DealerDaemonConfig;
    stateStore: EpochStateStore;
  }) {
    this.client = args.client;
    this.config = args.config;
    this.stateStore = args.stateStore;
    this.me = {
      validator: args.config.validatorAddress,
      committeeSize: args.config.committeeSize,
      threshold: args.config.threshold,
      mayBeginEpoch: args.config.autoBeginEpoch,
      mayFinalizeEpoch: args.config.autoFinalize,
      patienceBlocks: args.config.patienceBlocks,
    };
  }

  async start(): Promise<void> {
    log(`Daemon starting for validator ${this.config.validatorAddress}`);
    log(`Poll interval: ${this.config.pollIntervalMs}ms`);
    await this.probeStore(null);

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

  private async readView(): Promise<ChainView> {
    // A failed read rejects here and ends the poll. Nothing is sent on a guess.
    return { dealer: await this.client.getDealerState(), validators: await this.client.getValidators() };
  }

  private async pollOnce(): Promise<void> {
    const view = await this.readView();

    // Disk only: store shares that arrived, derive my share once the epoch is final.
    const memory = await this.remember(view, this.stateStore);
    this.pruneSecrets(view);

    const decision = decide(view, this.me, memory);
    this.report(view, decision, memory);

    // At most one rotation transaction per poll. The next poll reads the chain again.
    if (decision.action) await this.perform(decision.action);

    await this.dealTables(view, decision.situation);
  }

  /**
   * For `--explain`: one read, one probe, one decision, printed. Sends nothing, runs no hand
   * handler and leaves every secrets file as it is (the probe writes and deletes its own).
   */
  async explain(): Promise<void> {
    const view = await this.readView();
    const { dealer } = view;
    const readOnly: SecretsStore = { load: (epochId) => this.stateStore.load(epochId), save: async () => {} };
    const decision = decide(view, this.me, await this.remember(view, readOnly));

    logProgress(`Explain: height ${dealer.height}, next epoch ${dealer.nextEpochId}`);
    for (const { line } of headlines(view, decision.situation)) logProgress(line);
    const b = dealer.beacon;
    logProgress(
      b
        ? `Explain: beacon window for epoch ${b.epochId}${b.consumed ? " (consumed)" : ""}: commit ${b.commitOpenHeight} to ${b.commitCloseHeight}, reveal to ${b.revealCloseHeight}, threshold ${b.threshold}, committed [${b.committed.map(short).join(", ")}], revealed [${b.revealed.map(short).join(", ")}]`
        : "Explain: no beacon window"
    );
    const bonded = view.validators.filter((v) => v.bonded && v.power > 0);
    const mine = view.validators.find((v) => v.operator === this.me.validator);
    const mineIs = !mine ? "is not a validator" : mine.jailed ? "is jailed" : mine.bonded ? "is bonded" : "is not bonded";
    logProgress(`Explain: ${bonded.length} bonded with power: ${bonded.map((v) => `${short(v.operator)} (${v.power})`).join(", ")}; mine ${mineIs}`);
    logProgress(decision.action ? `Explain: would send: ${describe(decision.action)}. ${decision.why}` : `Explain: would wait: ${decision.why}`);
    logProgress("Explain: nothing was sent");
  }

  private async probeStore(window: number | null): Promise<void> {
    const result = await this.stateStore.probe();
    const was = this.storeProbe?.usable;
    this.storeProbe = { usable: result.ok, window };
    if (!result.ok) {
      logError(`State: ${this.config.stateDir} failed its write-read probe (${result.reason}). Staying out of roll call.`);
    } else if (was !== true) {
      logProgress(`State: ${this.config.stateDir} writable, passphrase opens it`);
    }
  }

  /**
   * Fills Memory. Touches the disk and, for a daemon that was down at finalize, reads a past
   * height. Sends nothing. Everything it does is safe to do twice.
   */
  private async remember(view: ChainView, secrets: SecretsStore): Promise<Memory> {
    const { dealer } = view;
    const me = this.me.validator;

    // Probed at start, then once per beacon window while the chain cannot deal: a roll call is
    // answered only on a fresh probe. The chain opens windows all the time, so not while it deals.
    const window = dealer.beacon?.commitOpenHeight ?? null;
    if (this.storeProbe === null || (this.rotatingSince !== null && this.storeProbe.window !== window)) await this.probeStore(window);

    const dkg = dealer.dkg;
    const epoch = dealer.epoch;
    const mine = view.validators.find((v) => v.operator === me);
    return {
      waitedBlocks: this.rotatingSince === null ? 0 : dealer.height - this.rotatingSince,
      storeUsable: this.storeProbe?.usable ?? false,
      unjailBlockedBy: mine?.jailed ? await this.unjailBlockedBy(mine) : null,
      keygen: dkg && dkg.members.some((m) => m.validator === me) ? await syncShares(secrets, dkg, me) : null,
      share: epoch ? await settleShare(secrets, epoch, me, () => this.readFinalDkg(epoch, dealer.height)) : { is: "not-member" },
    };
  }

  /**
   * The guards on unjailing my own validator, from the record on disk and this daemon's node. A
   * record or a node that cannot be read holds the unjail back: neither is taken for "fine".
   */
  private async unjailBlockedBy(mine: ValidatorInfo): Promise<string | null> {
    try {
      return unjailBlock({
        nowMs: Date.now(),
        record: this.stateStore.loadUnjailRecord(),
        node: await this.client.getNodeStatus(),
        consensusPubkey: mine.consensusPubkey,
      });
    } catch (err) {
      return `its guards could not be checked (${err instanceof Error ? err.message : String(err)})`;
    }
  }

  /** Asks the chain to unjail my validator. The try is on disk before it is sent, the landing after. */
  private async unjail(): Promise<void> {
    const me = this.me.validator;
    const record = this.stateStore.loadUnjailRecord();
    this.stateStore.saveUnjailRecord({ ...record, lastTriedAtMs: Date.now() });
    try {
      await this.client.slashingUnjail({ validator: me });
    } catch (err) {
      // "Unknown" may have landed. Counting it only lengthens the wait before the next one.
      if (txFailureOf(err).kind === "unknown") this.stateStore.saveUnjailRecord(afterUnjail(record, Date.now()));
      throw err;
    }
    const landed = afterUnjail(record, Date.now());
    this.stateStore.saveUnjailRecord(landed);
    const wait = unjailWaitMs(landed.landed) / 3_600_000;
    logProgress(`Unjail: ${short(me)} unjailed (attempt ${landed.landed}; the next one waits at least ${wait} h)`);
  }

  /**
   * The DKG record as it was at its reveal deadline, for a daemon that was down when it was
   * finalized and deleted. Two reads at past heights: at epoch.startHeight the DKG exists and names
   * its own reveal deadline, and at that height it holds every share that was accepted.
   * null when the node no longer holds those states, and once the record has been read.
   */
  private async readFinalDkg(epoch: DealerEpoch, now: number): Promise<DealerDkg | null> {
    if (this.finalDkg.epochId !== epoch.epochId) this.finalDkg = { epochId: epoch.epochId, synced: false, retryAt: 0 };
    if (this.finalDkg.synced || now < this.finalDkg.retryAt) return null;
    try {
      const begun = (await this.client.getDealerState({ height: epoch.startHeight })).dkg;
      if (begun?.epochId !== epoch.epochId) throw new Error(`no DKG for epoch ${epoch.epochId} at height ${epoch.startHeight}`);
      const final = (await this.client.getDealerState({ height: begun.revealDeadline })).dkg;
      if (final?.epochId !== epoch.epochId) throw new Error(`no DKG for epoch ${epoch.epochId} at height ${begun.revealDeadline}`);
      this.finalDkg.synced = true;
      return final;
    } catch (err) {
      this.finalDkg.retryAt = now + FINAL_DKG_RETRY_BLOCKS;
      logError(`DKG: cannot read the finalized DKG for epoch ${epoch.epochId} at a past height`, err);
      return null;
    }
  }

  /** Epoch ids are never reused, so a file below the next id that is neither the epoch's nor the DKG's is dead. */
  private pruneSecrets(view: ChainView): void {
    const { epoch, dkg, nextEpochId } = view.dealer;
    const key = `${epoch?.epochId ?? 0}:${dkg?.epochId ?? 0}:${nextEpochId}`;
    if (key === this.prunedFor) return;
    const keep = [epoch?.epochId, dkg?.epochId].filter((id): id is number => id !== undefined);
    const removed = this.stateStore.prune(keep, nextEpochId);
    this.prunedFor = key;
    if (removed.length > 0) logProgress(`State: removed the secrets of ${removed.length === 1 ? "epoch" : "epochs"} ${removed.sort((a, b) => a - b).join(", ")}, which nothing can use any more`);
  }

  /** Prints one line when `key` differs from the last one printed in `slot`. */
  private once(slot: string, key: string, line: string): void {
    if (this.printed[slot] === key) return;
    this.printed[slot] = key;
    logProgress(line);
  }

  /** Prints the decision, and keeps the count of blocks this process has watched the chain unable to deal. */
  private report(view: ChainView, decision: Decision, memory: Memory): void {
    if (decision.situation.kind !== "rotating") this.rotatingSince = null;
    else this.rotatingSince ??= view.dealer.height;

    const lines = headlines(view, decision.situation);
    for (const { slot, key, line } of lines) this.once(slot, key, line);
    const dkg = view.dealer.dkg;
    if (dkg && memory.keygen?.disk === "ok" && memory.keygen.commitMatchesDisk) {
      this.once("commit", String(dkg.epochId), `DKG: my commit for epoch ${dkg.epochId} is on chain and matches the secrets on disk`);
    }

    if (decision.action === null) {
      if (decision.alarm) logError(decision.why);
      // A chain that deals can stay as it is for weeks: what there is to say beyond the headline is said once.
      else if (decision.situation.kind !== "dealing") log(decision.why);
      else if (lines.some((l) => l.line === decision.why)) this.printed.dealing = "";
      else this.once("dealing", decision.why, decision.why);
    } else if (decision.costs.length > 0) {
      // A step that gets a validator slashed is announced every time, before it is sent.
      logProgress(decision.why);
    }
  }

  /**
   * Sends one rotation transaction and classifies the result. The only place a rotation
   * transaction is sent. It never retries: the next poll reads the chain and decides again.
   */
  private async perform(action: Action): Promise<void> {
    const me = this.me.validator;
    try {
      switch (action.do) {
        case "unjail":
          await this.unjail();
          return;
        case "beaconCommit":
          await this.client.dealerBeaconCommit({ validator: me, epochId: action.epochId, commit: beaconCommitment(this.config, action) });
          break;
        case "beaconReveal":
          await this.client.dealerBeaconReveal({ validator: me, epochId: action.epochId, salt: beaconSalt(this.config, action) });
          break;
        case "beginEpoch":
          await this.client.dealerBeginEpoch({
            epochId: action.epochId,
            committeeSize: action.committeeSize,
            threshold: action.threshold,
            ...POLICY.dkgWindows,
          });
          break;
        case "dkgCommit": {
          // prepareCommit returns only after the secrets are on disk, and the same commit every time.
          const stored = await prepareCommit(this.stateStore, action.dkg, me);
          await this.client.dealerDkgCommit({
            dealer: me,
            epochId: action.dkg.epochId,
            commitments: stored.commitments,
            ephemeralPubkey: stored.ephemeralPubkey,
          });
          break;
        }
        case "dkgEncryptedShare":
          await this.client.dealerDkgEncryptedShare({
            dealer: me,
            epochId: action.dkg.epochId,
            ...(await encryptShareFor(this.stateStore, action.dkg, action.recipientIndex)),
          });
          break;
        case "dkgRevealShare":
          await this.client.dealerDkgShareReveal({
            dealer: me,
            epochId: action.dkg.epochId,
            to: action.to,
            share: await plainShareFor(this.stateStore, action.dkg, action.to),
          });
          break;
        case "dkgComplainMissing":
          await this.client.dealerDkgComplaintMissing({ complainer: me, epochId: action.dkg.epochId, dealer: action.dealer });
          break;
        case "finalizeEpoch":
          await this.client.dealerFinalizeEpoch({ epochId: action.epochId });
          break;
        default:
          assertNever(action);
      }
      logProgress(`Rotation: ${describe(action)} landed`);
    } catch (err) {
      const failure = txFailureOf(err);
      if (failure.kind === "not-a-tx") throw err;
      log(`Rotation: ${describe(action)} ${failure.kind}: ${failureSummary(failure)}`);
    }
  }

  /**
   * Hands. Runs when an epoch exists, in every situation: a hand on an epoch that cannot deal still
   * needs its Timeout so that the chain aborts and refunds it. What changes with the situation is
   * only whether new hands are started.
   */
  private async dealTables(view: ChainView, situation: Situation): Promise<void> {
    const epoch = view.dealer.epoch;
    if (!epoch) return;
    const duty: HandDuty = { epochId: epoch.epochId, shufflers: shufflersOf(epoch), startHands: situation.kind === "dealing" };

    const tableIds = await this.client.getTables().catch(() => [] as string[]);
    for (const tableId of tableIds) {
      await this.processTable(tableId, duty).catch((err) => logError(`table ${tableId} processing error`, err));
    }
  }

  private async processTable(tableId: string, duty: HandDuty): Promise<void> {
    const { epochId } = duty;
    const table = await this.client.getTable(tableId).catch(() => null);
    if (!table) return;

    const hand = table?.hand;
    const handId = String(pick(hand, "handId", "hand_id") ?? "");

    if (!hand || !handId) {
      // No active hand — maybe start one, but not on an epoch that cannot deal it.
      if (duty.startHands) {
        await maybeStartAndInitHand({
          client: this.client,
          config: this.config,
          tableId,
          epochId,
        }).catch(() => {});
      }
      return;
    }

    const phase = normalizePhase(hand.phase);
    const dealer = hand.dealer ?? hand.dealerState;

    const deckFinalized = !!(pick(dealer, "deckFinalized", "deck_finalized"));

    if (phase === "shuffle" && !deckFinalized) {
      // If the poker hand was started externally (e.g., by a bot) without
      // dealerInitHand, the dealer epoch_id will be 0.  Init it now.
      const dealerEpochId = asNumber(pick(dealer, "epochId", "epoch_id")) ?? 0;
      if (dealerEpochId === 0) {
        if (duty.startHands) {
          log(`Table ${tableId} hand ${handId}: dealer hand not initialized, calling initHand`);
          await this.client.dealerInitHand({ tableId, handId, epochId }).catch((err) =>
            logError(`initHand for table ${tableId} hand ${handId} failed`, err)
          );
        }
      } else {
        // Try to shuffle (handleShuffle reads authoritative shuffleStep from DealerHand)
        await handleShuffle({
          client: this.client,
          config: this.config,
          tableId,
          handId,
          shufflers: duty.shufflers,
        }).catch((err) => logError("shuffle error", err));

        // Always attempt finalization — maybeFinalizeDeck checks readiness internally
        await maybeFinalizeDeck({
          client: this.client,
          config: this.config,
          tableId,
          handId,
        }).catch(() => {});
      }
    } else if (deckFinalized && (phase === "shuffle" || phase === "betting")) {
      // After deck finalization, submit enc shares for hole cards
      // Phase may still be SHUFFLE (poker module transitions after enc shares) or BETTING
      await handleEncShares({
        client: this.client,
        config: this.config,
        stateStore: this.stateStore,
        tableId,
        handId,
        epochId,
      }).catch((err) => logError("enc shares error", err));
    } else if (
      phase === "awaitFlop" ||
      phase === "awaitTurn" ||
      phase === "awaitRiver" ||
      phase === "awaitShowdown"
    ) {
      // Reveal phases
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
    }

    // Betting phase - check for timeouts
    if (phase === "betting") {
      await maybeTick({
        client: this.client,
        config: this.config,
        tableId,
      }).catch(() => {});
    }

    // Dealer timeout check — always runs; covers shuffle, enc share, and reveal deadlines
    await maybeDealerTimeout({
      client: this.client,
      config: this.config,
      tableId,
      handId,
    }).catch(() => {});
  }
}
