import {
  OCP_TYPE_URLS,
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
import { deckKey, finalDeckOf, handleShuffle, initialDeck, proveRound, type Ahead } from "./handlers/shuffle.js";
import { handleEncShares } from "./handlers/encshares.js";
import { handlePubShare, pubShareMessage } from "./handlers/pubshares.js";
import {
  maybeFinalizeDeck,
  maybeInitHand,
  maybeTick,
  maybeDealerTimeout,
} from "./handlers/automation.js";
import { dealerTimeoutSecs, holePositions, holeShareMessages } from "./handlers/encshares.js";
import { BLIND_GAS, handSender, type HandSender } from "./handlers/send.js";
import { InFlight, turnOrder } from "./turns.js";

/** A node that could not serve a finalized DKG at its past height is asked again after this many blocks. */
const FINAL_DKG_RETRY_BLOCKS = 120;

/** How often the node is asked whether it committed a new block. Each new block is read and acted on at once. */
const BLOCK_WATCH_MS = 200;

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

/**
 * The cards of the street being revealed, from the one the chain waits for, in the order the chain
 * reveals them (x/poker dealerExpectedRevealPos): the flop's remaining cards, or the showdown's hole
 * cards in ascending position. The turn and the river are one card.
 */
function streetPositions(table: any): number[] {
  const first = expectedRevealPos(table);
  if (first === null) return [];
  const h = table.hand;
  const phase = normalizePhase(h.phase);
  if (phase === "awaitFlop") {
    const cursor = asNumber(h.dealer?.cursor) ?? 0;
    return Array.from({ length: Math.max(0, cursor + 3 - first) }, (_, i) => first + i);
  }
  if (phase !== "awaitShowdown") return [first];
  const holePos: number[] = (pick(h.dealer, "holePos", "hole_pos") ?? []).map((x: unknown) => asNumber(x));
  const inHand = pick(h, "inHand", "in_hand") ?? [];
  const folded = Array.isArray(h.folded) ? h.folded : [];
  const eligible = [];
  for (let seat = 0; seat < 9; seat++) {
    if (!inHand[seat] || folded[seat]) continue;
    for (const p of [holePos[seat * 2], holePos[seat * 2 + 1]]) if (p !== undefined && p >= first && p !== 255) eligible.push(p);
  }
  return eligible.sort((a, b) => a - b);
}

/**
 * Whether `action` by the seat whose turn it is ends the betting round (x/poker logic.go
 * streetComplete): after it, every seat still in, not folded and not all in has matched the bet and
 * acted in this interval. Only a check or a call is taken to end it; anything else is "no".
 */
export function closesStreet(hand: any, action: string): boolean {
  if (action !== "check" && action !== "call") return false;
  const actor = asNumber(pick(hand, "actionOn", "action_on"));
  const inHand = pick(hand, "inHand", "in_hand") ?? [];
  const folded = hand?.folded ?? [];
  const allIn = pick(hand, "allIn", "all_in") ?? [];
  const commit = pick(hand, "streetCommit", "street_commit") ?? [];
  const acted = pick(hand, "lastIntervalActed", "last_interval_acted") ?? [];
  const betTo = String(pick(hand, "betTo", "bet_to") ?? "0");
  const interval = asNumber(pick(hand, "intervalId", "interval_id")) ?? 0;
  if (actor === undefined) return false;
  for (let seat = 0; seat < 9; seat++) {
    if (seat === actor || !inHand[seat] || folded[seat] || allIn[seat]) continue;
    if (String(commit[seat] ?? "0") !== betTo || asNumber(acted[seat]) !== interval) return false;
  }
  return true;
}

/** The cards the street after this betting round reveals, in the chain's order (dealerExpectedRevealPos). */
function nextStreetPositions(table: any): number[] {
  const h = table?.hand;
  const cursor = asNumber(h?.dealer?.cursor) ?? 0;
  const street = String(h?.street ?? "");
  if (street === "STREET_PREFLOP" || street === "1") return [cursor, cursor + 1, cursor + 2];
  if (street === "STREET_FLOP" || street === "2") return [cursor + 3];
  if (street === "STREET_TURN" || street === "3") return [cursor + 4];
  if (street !== "STREET_RIVER" && street !== "4") return [];
  const holePos: number[] = (pick(h.dealer, "holePos", "hole_pos") ?? []).map((x: unknown) => asNumber(x));
  const inHand = pick(h, "inHand", "in_hand") ?? [];
  const folded = Array.isArray(h.folded) ? h.folded : [];
  const out = [];
  for (let seat = 0; seat < 9; seat++) {
    if (!inHand[seat] || folded[seat]) continue;
    for (const p of [holePos[seat * 2], holePos[seat * 2 + 1]]) if (p !== undefined && p !== 255) out.push(p);
  }
  return out.sort((a, b) => a - b);
}

/** A hand's state at the last block, for work the mempool shows the next block makes possible. */
type HandAt = {
  tableId: string;
  handId: string;
  epochId: number;
  table: any;
  dealerHand: any;
  qualified: readonly { validator: string }[];
  threshold: number;
  sender: HandSender;
};

/** A street with cards still to reveal, as the last block showed it. */
type Street = {
  tableId: string;
  handId: string;
  epochId: number;
  dealerHand: any;
  /** The card the chain waits for first. */
  positions: readonly number[];
  /** Validators whose public share of each card is in the chain's state. */
  shared: ReadonlyMap<number, ReadonlySet<string>>;
  qualified: readonly { validator: string }[];
  threshold: number;
  sender: HandSender;
};

/** What dealTables hands each table: the epoch to deal on, who shuffles, and whether a new hand may start. */
type HandDuty = {
  epochId: number;
  threshold: number;
  /** The epoch's members that are not slashed, in the chain's order: shufflers, and the members a step's turn goes to. */
  shufflers: readonly { validator: string; index: number }[];
  startHands: boolean;
  /** Block time of the latest block, in Unix seconds: what a step's deadline is compared with. */
  nowUnix: number;
  sender: HandSender;
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
  private processing = false;
  /** Hand transactions sent and not settled, by step. */
  private readonly inflight = new InFlight();
  /** "table/hand" to the first height this process saw that hand started and not initialized. */
  private readonly uninitializedSince = new Map<string, number>();
  /** The round this daemon shuffles next, while the member before it is shuffling: watched for in the mempool. */
  private shuffleNext: { tableId: string; handId: string; round: number; after: string; pkHand: unknown } | null = null;
  /** That round, proved on the deck the pending round before it leaves. */
  private ahead: Ahead | null = null;
  /** The dealing epoch at the last block, with its public key once read: what an InitHand in the mempool will build its deck from. */
  private dealing: { epochId: number; qualified: readonly { validator: string }[]; pkEpoch: Uint8Array | null } | null = null;
  /** A table with no hand at the last block, and the id its next hand gets. */
  private startable: { tableId: string; handId: string; epochId: number; qualified: readonly { validator: string }[]; sender: HandSender } | null = null;
  /** The street being revealed at the last block, while it has more than one card. */
  private street: Street | null = null;
  /** A hand being shuffled, and one being bet on, at the last block. */
  private shuffling: HandAt | null = null;
  private betting: HandAt | null = null;
  /** "table/hand/pos" of the shares sent ahead of their card's turn, "table/hand/hole" of the hole shares. */
  private readonly sharedAhead = new Set<string>();

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
  }

  /**
   * One poll for every block the node commits, as soon as it has: a step that follows another
   * lands in the next block. Without a new block, a poll still runs every pollIntervalMs.
   */
  private startPolling(): void {
    const signal = this.abortController!.signal;
    void (async () => {
      let seen = 0;
      let polledAt = 0;
      while (!signal.aborted) {
        const height = await this.client.signing.committedHeight().catch(() => null);
        if ((height !== null && height > seen) || Date.now() - polledAt >= this.config.pollIntervalMs) {
          if (height !== null) seen = Math.max(seen, height);
          polledAt = Date.now();
          await this.poll();
        } else {
          await this.aheadOfTheBlock().catch((err) => logError("ahead of the block", err));
          await new Promise((resolve) => setTimeout(resolve, BLOCK_WATCH_MS));
        }
      }
    })();
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
    const status = await this.client.getNodeStatus().catch(() => null);
    if (this.dealing?.epochId !== epoch.epochId) this.dealing = { epochId: epoch.epochId, qualified: shufflersOf(epoch), pkEpoch: null };
    else this.dealing.qualified = shufflersOf(epoch);
    const duty: HandDuty = {
      epochId: epoch.epochId,
      threshold: epoch.threshold,
      shufflers: shufflersOf(epoch),
      startHands: situation.kind === "dealing",
      nowUnix: Math.floor((status?.latestBlockTimeMs ?? Date.now()) / 1000),
      sender: handSender(this.client, this.inflight, view.dealer.height),
    };

    const tableIds = await this.client.getTables().catch(() => [] as string[]);
    for (const tableId of tableIds) {
      await this.processTable(tableId, duty).catch((err) => logError(`table ${tableId} processing error`, err));
    }
  }

  /** Between blocks: work that the mempool shows the next block will make possible. */
  private async aheadOfTheBlock(): Promise<void> {
    if (!this.shuffleNext && !this.street && !this.startable && !this.shuffling && !this.betting && this.dealing?.qualified[0]?.validator !== this.config.validatorAddress) return;
    const pending = await this.client.signing.pendingMessages();
    await this.initAhead(pending);
    await this.holeSharesAhead(pending);
    await this.closeAhead(pending);
    await this.revealAhead(pending);
    await this.proveAhead(pending);
    await this.proveFirstAhead(pending);
  }

  /**
   * The first round, ahead: an InitHand in the mempool builds its deck from the epoch's key, the
   * table, the hand and the height of the block it lands in, which is the next one (initialDeck).
   * The first shuffler proves round 1 on that deck while the block is made; if the InitHand lands
   * later, the chain's deck differs and the proof is not sent (handleShuffle).
   */
  private async proveFirstAhead(pending: Awaited<ReturnType<OcpCosmosClient["signing"]["pendingMessages"]>>): Promise<void> {
    const d = this.dealing;
    const me = this.config.validatorAddress;
    if (!d || d.qualified[0]?.validator !== me) return;
    const init = pending.find((m) => m.typeUrl === OCP_TYPE_URLS.dealer.initHand && Number(m.value.epochId) === d.epochId);
    if (!init) return;
    const tableId = String(init.value.tableId);
    const handId = String(init.value.handId);
    if (this.ahead?.tableId === tableId && this.ahead.handId === handId && this.ahead.round === 1) return;
    if (!d.pkEpoch) {
      const raw = pick(await this.client.getDealerEpoch(), "pkEpoch", "pk_epoch");
      if (!raw) return;
      d.pkEpoch = Uint8Array.from(Buffer.from(String(raw), "base64"));
    }
    const initHeight = (await this.client.getNodeStatus()).latestHeight + 1;
    const { pkHand, deck } = initialDeck({ pkEpoch: d.pkEpoch, epochId: d.epochId, tableId, handId, initHeight });
    this.ahead = { tableId, handId, round: 1, inputKey: deckKey(deck), proofBytes: proveRound(this.config, pkHand, deck, tableId, handId, 1) };
    logProgress(`Shuffle: proved round 1 of table ${tableId} hand ${handId} ahead, on the deck its InitHand in the mempool makes at height ${initHeight}`);
  }

  /**
   * A player's StartHand in the mempool: the member whose turn the hand is sends its InitHand
   * behind it, so the dealer's part starts in the block the hand starts in. One that lands before
   * the StartHand fails alone; the next block sends it again the usual way (maybeInitHand).
   */
  private async initAhead(pending: Awaited<ReturnType<OcpCosmosClient["signing"]["pendingMessages"]>>): Promise<void> {
    const t = this.startable;
    if (!t) return;
    const key = `t${t.tableId}:h${t.handId}:init`;
    if (turnOrder(t.qualified, Number(t.handId))[0] !== this.config.validatorAddress || t.sender.inflight.holds(key, t.sender.height)) return;
    if (!pending.some((m) => m.typeUrl === OCP_TYPE_URLS.poker.startHand && String(m.value.tableId) === t.tableId)) return;
    this.startable = null;
    const sent = await t.sender.send({
      key,
      msgs: [this.client.messages.initHand({ tableId: t.tableId, handId: t.handId, epochId: t.epochId })],
      holdBlocks: 0,
      gasLimit: BLIND_GAS.initHand,
      what: `init hand ${t.handId} of table ${t.tableId}, behind a player's StartHand`,
    });
    if (sent) logProgress(`Automation: init hand ${t.handId} of table ${t.tableId} sent behind a player's StartHand`);
  }

  /**
   * The last round's shuffle in the mempool with FinalizeDeck behind it: the deck that block makes
   * final is that proof's last snapshot (finalDeckOf) and the hole positions follow from the seats
   * (holePositions). The members whose turn the hole shares are send theirs behind, unsimulated,
   * so the betting can open in the shuffle's own block. A batch that lands too early fails, and the
   * block after sends the shares again the usual way.
   */
  private async holeSharesAhead(pending: Awaited<ReturnType<OcpCosmosClient["signing"]["pendingMessages"]>>): Promise<void> {
    const h = this.shuffling;
    if (!h) return;
    const key = `${h.tableId}/${h.handId}/hole`;
    if (this.sharedAhead.has(key) || !turnOrder(h.qualified, h.qualified.length - 1).slice(0, h.threshold).includes(this.config.validatorAddress)) return;
    const ofHand = (m: { value: any }) => String(m.value.tableId) === h.tableId && String(m.value.handId) === h.handId;
    const last = pending.findIndex((m) => m.typeUrl === OCP_TYPE_URLS.dealer.submitShuffle && ofHand(m) && Number(m.value.round) === h.qualified.length);
    if (last < 0 || !pending.slice(last).some((m) => m.typeUrl === OCP_TYPE_URLS.dealer.finalizeDeck && ofHand(m))) return;
    this.sharedAhead.add(key);
    const shares = await holeShareMessages({
      client: this.client,
      config: this.config,
      stateStore: this.stateStore,
      tableId: h.tableId,
      handId: h.handId,
      epochId: h.epochId,
      table: h.table,
      dealerHand: h.dealerHand,
      deck: finalDeckOf(pending[last]!.value.proofShuffle),
      holePos: holePositions(h.table.hand),
      skip: new Set(),
    });
    if (shares.length === 0) return;
    const sent = await h.sender.send({
      key: `t${h.tableId}:h${h.handId}:holeShares`,
      msgs: shares.map((s) => s.msg),
      holdBlocks: 0,
      gasLimit: BLIND_GAS.holeShare * shares.length,
      what: `hole-card shares for table ${h.tableId} hand ${h.handId}, behind the last shuffle`,
    });
    if (sent) logProgress(`EncShares: sent ${shares.length} shares for table ${h.tableId} hand ${h.handId} behind the last shuffle`);
  }

  /**
   * A player's check or call in the mempool that ends the betting round (closesStreet): the next
   * street's first card opens in that block. The members whose turn that card is send their share
   * and FinalizeReveal behind it, unsimulated, and revealAhead carries on with the street's other
   * cards. A guess that lands too early fails, and the block after reveals the card the usual way.
   */
  private async closeAhead(pending: Awaited<ReturnType<OcpCosmosClient["signing"]["pendingMessages"]>>): Promise<void> {
    const b = this.betting;
    if (!b) return;
    const hand = b.table.hand;
    const actor = asNumber(pick(hand, "actionOn", "action_on"));
    const player = actor === undefined ? undefined : b.table.seats?.[actor]?.player;
    const act = pending.find((m) => m.typeUrl === OCP_TYPE_URLS.poker.act && String(m.value.tableId) === b.tableId && m.value.player === player);
    if (!player || !act || !closesStreet(hand, String(act.value.action))) return;
    const positions = nextStreetPositions(b.table);
    const pos = positions[0];
    if (pos === undefined) return;
    this.betting = null;
    this.street = { tableId: b.tableId, handId: b.handId, epochId: b.epochId, dealerHand: b.dealerHand, positions, shared: new Map(), qualified: b.qualified, threshold: b.threshold, sender: b.sender };
    const key = `${b.tableId}/${b.handId}/${pos}`;
    if (this.sharedAhead.has(key) || !turnOrder(b.qualified, pos).slice(0, b.threshold).includes(this.config.validatorAddress)) return;
    const share = await pubShareMessage({ client: this.client, config: this.config, stateStore: this.stateStore, tableId: b.tableId, handId: b.handId, epochId: b.epochId, dealerHand: b.dealerHand, pos });
    if (!share) return;
    this.sharedAhead.add(key);
    const what = `pos ${pos} table ${b.tableId} hand ${b.handId}, behind the action that ends the betting`;
    const keys = `t${b.tableId}:h${b.handId}:`;
    if (!(await b.sender.send({ key: `${keys}pub${pos}`, msgs: [share], holdBlocks: 0, gasLimit: BLIND_GAS.pubShare, what: `public share of ${what}` }))) return;
    await b.sender.send({ key: `${keys}reveal${pos}`, msgs: [this.client.messages.finalizeReveal({ tableId: b.tableId, handId: b.handId, pos })], holdBlocks: 0, gasLimit: BLIND_GAS.finalizeReveal, what: `finalize reveal of ${what}` });
    logProgress(`PubShare: sent for ${what}`);
  }

  /**
   * The chain reveals one card at a time. When the mempool holds enough shares of the card it waits
   * for, and a FinalizeReveal behind them, that card is revealed in the next block: the member whose
   * turn the following card is sends its share and FinalizeReveal behind those, so the next block
   * reveals both. Each such send is a guess at the block's order; one that lands too early fails
   * alone, and the block after sends it again the usual way.
   */
  private async revealAhead(pending: Awaited<ReturnType<OcpCosmosClient["signing"]["pendingMessages"]>>): Promise<void> {
    const st = this.street;
    if (!st) return;
    const me = this.config.validatorAddress;
    const ofHand = (m: { value: any }) => String(m.value.tableId) === st.tableId && String(m.value.handId) === st.handId;
    const revealsNext = (pos: number): boolean => {
      const shared = new Set(st.shared.get(pos) ?? []);
      for (const m of pending) {
        if (!ofHand(m) || Number(m.value.pos) !== pos) continue;
        if (m.typeUrl === OCP_TYPE_URLS.dealer.submitPubShare) shared.add(m.value.validator);
        if (m.typeUrl === OCP_TYPE_URLS.dealer.finalizeReveal && shared.size >= st.threshold) return true;
      }
      return false;
    };
    for (let i = 1; i < st.positions.length && revealsNext(st.positions[i - 1]!); i++) {
      const pos = st.positions[i]!;
      const key = `${st.tableId}/${st.handId}/${pos}`;
      if (!turnOrder(st.qualified, pos).slice(0, st.threshold).includes(me) || st.shared.get(pos)?.has(me) || this.sharedAhead.has(key)) continue;
      const share = await pubShareMessage({ client: this.client, config: this.config, stateStore: this.stateStore, tableId: st.tableId, handId: st.handId, epochId: st.epochId, dealerHand: st.dealerHand, pos });
      if (!share) return;
      this.sharedAhead.add(key);
      const what = `pos ${pos} table ${st.tableId} hand ${st.handId}, ahead of its turn`;
      const keys = `t${st.tableId}:h${st.handId}:`;
      if (!(await st.sender.send({ key: `${keys}pub${pos}`, msgs: [share], holdBlocks: 0, gasLimit: BLIND_GAS.pubShare, what: `public share of ${what}` }))) return;
      await st.sender.send({ key: `${keys}reveal${pos}`, msgs: [this.client.messages.finalizeReveal({ tableId: st.tableId, handId: st.handId, pos })], holdBlocks: 0, gasLimit: BLIND_GAS.finalizeReveal, what: `finalize reveal of ${what}` });
      logProgress(`PubShare: sent for ${what}`);
    }
  }

  /**
   * A shuffle proof takes several seconds of processor time, about a block. The round before mine
   * is in the mempool before its block: proving mine on the deck it leaves, while that block is
   * being made, lets mine land in the next block instead of the one after. The proof is sent only
   * if the chain's deck turns out to be that deck (handleShuffle).
   */
  private async proveAhead(pending: Awaited<ReturnType<OcpCosmosClient["signing"]["pendingMessages"]>>): Promise<void> {
    const next = this.shuffleNext;
    if (!next) return;
    const before = pending.find(
      (m) =>
        m.typeUrl === OCP_TYPE_URLS.dealer.submitShuffle &&
        String(m.value.tableId) === next.tableId &&
        String(m.value.handId) === next.handId &&
        Number(m.value.round) === next.round - 1 &&
        m.value.shuffler === next.after,
    );
    if (!before) return;
    this.shuffleNext = null;
    const deck = finalDeckOf(before.value.proofShuffle);
    const proofBytes = proveRound(this.config, next.pkHand, deck, next.tableId, next.handId, next.round);
    this.ahead = { tableId: next.tableId, handId: next.handId, round: next.round, inputKey: deckKey(deck), proofBytes };
    logProgress(`Shuffle: proved round ${next.round} of table ${next.tableId} hand ${next.handId} ahead, on the deck of round ${next.round - 1} in the mempool`);
  }

  private async processTable(tableId: string, duty: HandDuty): Promise<void> {
    const { epochId, sender } = duty;
    const table = await this.client.getTable(tableId).catch(() => null);
    if (!table) return;

    const hand = table?.hand;
    const handId = String(pick(hand, "handId", "hand_id") ?? "");
    const handKey = handId || String(pick(table, "nextHandId", "next_hand_id") ?? "");
    this.inflight.forgetAllBut(`t${tableId}:`, `t${tableId}:h${handKey}:`);
    for (const k of this.uninitializedSince.keys()) if (k.startsWith(`${tableId}/`) && k !== `${tableId}/${handId}`) this.uninitializedSince.delete(k);
    const turns = { qualified: duty.shufflers, sender };
    if (this.street?.tableId === tableId) this.street = null;
    if (this.startable?.tableId === tableId) this.startable = null;
    if (this.shuffling?.tableId === tableId) this.shuffling = null;
    if (this.betting?.tableId === tableId) this.betting = null;
    if (this.shuffleNext?.tableId === tableId) this.shuffleNext = null;
    for (const k of this.sharedAhead) if (k.startsWith(`${tableId}/`) && !k.startsWith(`${tableId}/${handId}/`)) this.sharedAhead.delete(k);

    if (!hand || !handId) {
      // Only a seated player may start a hand (x/poker StartHand). Its InitHand can land right behind it.
      if (duty.startHands && this.config.autoInitHand && /^\d+$/.test(handKey)) this.startable = { tableId, handId: handKey, epochId, qualified: duty.shufflers, sender };
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
          const seen = `${tableId}/${handId}`;
          if (!this.uninitializedSince.has(seen)) this.uninitializedSince.set(seen, sender.height);
          await maybeInitHand({
            client: this.client,
            config: this.config,
            tableId,
            handId,
            epochId,
            seenSince: this.uninitializedSince.get(seen)!,
            ...turns,
          });
        }
      } else {
        const dealerHand = await this.client.getDealerHand(tableId, handId).catch(() => null);
        const step = Number(pick(dealerHand, "shuffleStep", "shuffle_step") ?? 0);
        if (dealerHand && step >= duty.shufflers.length) {
          await maybeFinalizeDeck({
            client: this.client,
            config: this.config,
            tableId,
            handId,
            shuffledAtUnix: (asNumber(pick(dealerHand, "shuffleDeadline", "shuffle_deadline")) ?? 0) - dealerTimeoutSecs(table),
            nowUnix: duty.nowUnix,
            ...turns,
          });
        } else if (dealerHand) {
          this.shuffling = { tableId, handId, epochId, table, dealerHand, qualified: duty.shufflers, threshold: duty.threshold, sender };
          const me = this.config.validatorAddress;
          const proving = this.ahead?.tableId === tableId && this.ahead.handId === handId && this.ahead.round === step + 2;
          this.shuffleNext =
            duty.shufflers[step + 1]?.validator === me && !proving
              ? { tableId, handId, round: step + 2, after: duty.shufflers[step]!.validator, pkHand: pick(dealerHand, "pkHand", "pk_hand") }
              : null;
          await handleShuffle({
            client: this.client,
            config: this.config,
            tableId,
            handId,
            shufflers: duty.shufflers,
            sender,
            ahead: this.ahead,
          }).catch((err) => logError("shuffle error", err));
        }
      }
    } else if (deckFinalized && phase === "shuffle") {
      // The deck is final and the hole cards wait for their encrypted shares.
      await handleEncShares({
        client: this.client,
        config: this.config,
        stateStore: this.stateStore,
        tableId,
        handId,
        epochId,
        threshold: duty.threshold,
        nowUnix: duty.nowUnix,
        ...turns,
      }).catch((err) => logError("enc shares error", err));
    } else if (
      phase === "awaitFlop" ||
      phase === "awaitTurn" ||
      phase === "awaitRiver" ||
      phase === "awaitShowdown"
    ) {
      // Reveal phases
      const pos = expectedRevealPos(table);
      const positions = streetPositions(table);
      const dealerHand = positions.length > 1 ? await this.client.getDealerHand(tableId, handId).catch(() => null) : null;
      const shared = new Map<number, Set<string>>();
      for (const ps of (pick(dealerHand, "pubShares", "pub_shares") ?? []) as any[]) {
        const p = Number(ps?.pos);
        if (!shared.has(p)) shared.set(p, new Set());
        shared.get(p)!.add(String(ps?.validator));
      }
      this.street = dealerHand ? { tableId, handId, epochId, dealerHand, positions, shared, qualified: duty.shufflers, threshold: duty.threshold, sender } : null;
      if (pos != null) {
        await handlePubShare({
          client: this.client,
          config: this.config,
          stateStore: this.stateStore,
          tableId,
          handId,
          epochId,
          pos,
          threshold: duty.threshold,
          revealDeadline: asNumber(pick(dealer, "revealDeadline", "reveal_deadline")) ?? 0,
          dealerTimeoutSecs: dealerTimeoutSecs(table),
          nowUnix: duty.nowUnix,
          ...turns,
        }).catch((err) => logError("pub share error", err));
      }
    }

    // Betting phase - check for timeouts
    if (phase === "betting") {
      const dealerHand = await this.client.getDealerHand(tableId, handId).catch(() => null);
      if (dealerHand) this.betting = { tableId, handId, epochId, table, dealerHand, qualified: duty.shufflers, threshold: duty.threshold, sender };
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
