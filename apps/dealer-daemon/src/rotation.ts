// The dealer daemon's whole decision about replacing an epoch, as one pure function.
//
//   chain state at one height  +  who I am  +  what only this process knows   ->   at most one action
//
// No I/O, no clock, no SDK client, no disk. Everything the daemon may send to rotate an epoch is a
// member of `Action`. What is not a member cannot be sent: there is no DkgTimeout and no AEAD
// complaint, because the first only brings a slash forward and the second can slash its sender.
//
// Every inequality on a height follows one rule: a transaction sent when the last committed height
// is h is first simulated by the node at h, and then executes at h + 1 or later. The chain must
// accept it at both. So "can still land by D" is h < D, and "is accepted after D" is h > D.

import type {
  BeaconWindow,
  DealerDkg,
  DealerEpoch,
  DealerMember,
  DealerState,
  NodeStatus,
  ValidatorInfo,
  Valoper,
} from "@onchainpoker/ocp-sdk/cosmos";

// ---------------------------------------------------------------------------------------------
// Policy: every number the decision uses.
// ---------------------------------------------------------------------------------------------

export const POLICY = {
  /**
   * DKG windows sent with BeginEpoch, in blocks (5 s each on the live chain). The chain's defaults
   * are 5 blocks each, which a daemon that polls every 2 s and can be held 45 s by one transaction
   * cannot meet: that slashed two validators in the DKG for epoch 43.
   * 120 to commit: a daemon can crash, wait out a 60 s restart backoff, start and still commit.
   * 60 for complaints: the first 30 are for late shares, the last 30 for a complaint.
   * 60 to answer a complaint. The chain does not enforce finalizeBlocks.
   */
  dkgWindows: { commitBlocks: 120, complaintBlocks: 60, revealBlocks: 60, finalizeBlocks: 60 },

  /**
   * Commit to the beacon only in the last 12 blocks of its commit window. A commit with no reveal
   * is the one way the beacon can cost a validator half its stake, so the time between the two is
   * kept to about a minute. Missing the window costs nothing: the chain opens another.
   */
  beaconCommitTailBlocks: 12,

  /**
   * The reveal that brings a window to its threshold makes it binding: from then on every committer
   * must reveal, or BeginEpoch slashes it. That reveal is sent only in the first 8 blocks of the
   * reveal window. The commits, at most 12 blocks before the window, are then still fresh evidence
   * that the validators revealing later are alive, and one that stops right after has the rest of
   * the window, at least 40 blocks, to come back and land its own.
   */
  beaconBindingRevealBlocks: 8,

  /** Daemons that may send the same permissionless message take turns, this many blocks apart. */
  turnStaggerBlocks: 2,

  /**
   * DEALER_PATIENCE_BLOCKS when unset: 10 minutes at 5 s blocks. Ruling 2026-11-22: "how long can a
   * poker table wait for somebody? I say, like 20 seconds". Minutes, not seconds, while the chain
   * takes half an absent validator's stake.
   */
  defaultPatienceBlocks: 120,

  unjail: {
    /** The chain refuses until the jail time is over. Ask it once a minute. */
    askEveryMs: 60_000,
    /** Each unjail that lands doubles the wait before the next: 1 h, 2 h, 4 h, up to a day. */
    firstWaitMs: 3_600_000,
    maxWaitMs: 86_400_000,
    /** After this long with no unjail the count starts again. */
    forgetAfterMs: 7 * 86_400_000,
    /** The daemon's node must hold a block this recent, or the validator would be jailed again for downtime. */
    nodeFreshMs: 30_000,
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** What the chain says. `dealer` is one height. A failed read never becomes a ChainView. */
export type ChainView = {
  readonly dealer: DealerState;
  readonly validators: readonly ValidatorInfo[];
};

/** Who this daemon is. From config, fixed for the process. */
export type Me = {
  readonly validator: Valoper;
  /** DEALER_COMMITTEE_SIZE: the committee asked for when that many validators are bonded. */
  readonly committeeSize: number;
  /** DEALER_THRESHOLD. */
  readonly threshold: number;
  /** DEALER_AUTO_BEGIN_EPOCH. An operator's switch, on for every daemon in normal running. */
  readonly mayBeginEpoch: boolean;
  /** DEALER_AUTO_FINALIZE. */
  readonly mayFinalizeEpoch: boolean;
  /**
   * DEALER_PATIENCE_BLOCKS. How long this process watches the chain unable to deal before it takes
   * a step that it knows gets an absent validator slashed. 0 means never: wait for a person.
   */
  readonly patienceBlocks: number;
};

/** What handlers/dkg.ts knows about the DKG in flight. Produced from disk and the chain, never sent. */
export type KeygenFacts =
  | {
      readonly disk: "ok";
      /** null: my commit is not on chain. false: it is, and the secrets on disk do not produce it. */
      readonly commitMatchesDisk: boolean | null;
      /** Dealers whose share for me is on disk, each checked against that dealer's on-chain commitments. */
      readonly holds: ReadonlySet<Valoper>;
    }
  /** A secrets file for this epoch exists and cannot be read. It is never taken for "no file". */
  | { readonly disk: "unreadable"; readonly reason: string };

/** Whether I can deal in the current epoch. Produced by handlers/dkg.ts once the epoch is final. */
export type ShareStatus =
  | { readonly is: "ready" } // my share times G equals my on-chain pub_share
  | { readonly is: "not-member" }
  | { readonly is: "slashed" } // a member, in epoch.slashed: the chain asks nothing of me
  | { readonly is: "missing"; readonly from: readonly Valoper[] } // dealers whose share I do not hold
  | { readonly is: "mismatch" } // shares held, no sum of them matches pub_share
  | { readonly is: "unreadable"; readonly reason: string };

/** What only this process knows. The daemon shell fills it. Nothing in it is a guess about the chain. */
export type Memory = {
  /** Blocks since this process first saw the chain unable to deal, with no break. 0 if it can deal. */
  readonly waitedBlocks: number;
  /** The secrets directory passed a write, a read back and a delete, with the passphrase. */
  readonly storeUsable: boolean;
  /** Why this daemon would not unjail its validator now, or null when every guard passes. Read only while it is jailed. */
  readonly unjailBlockedBy: string | null;
  /** null when no DKG is in flight or I am not a member. null never leads to a complaint. */
  readonly keygen: KeygenFacts | null;
  readonly share: ShareStatus;
};

// ---------------------------------------------------------------------------------------------
// The model: which of three situations the chain is in.
// ---------------------------------------------------------------------------------------------

export type Situation =
  /** The epoch has at least `threshold` members that are not slashed. Nothing to rotate. */
  | { readonly kind: "dealing"; readonly epoch: DealerEpoch; readonly qualified: readonly DealerMember[] }
  /** No DKG, and the epoch is absent or below threshold. A roll call decides when one may begin. */
  | {
      readonly kind: "rotating";
      readonly reason: "no-epoch" | "below-threshold";
      readonly nextEpochId: number;
      readonly rollCall: RollCall;
    }
  /** A DKG is in flight. Nothing else can start until it is finalized. */
  | { readonly kind: "keygen"; readonly dkg: DealerDkg; readonly phase: KeygenPhase };

/**
 * commit:      h < commitDeadline. A commit sent now can still land.
 * shares:      commitDeadline <= h < revealDeadline. The commit set is final. Shares, complaints, reveals.
 * finalizable: h >= revealDeadline. Nothing more can land in the DKG. FinalizeEpoch is accepted from the next height.
 */
export type KeygenPhase = "commit" | "shares" | "finalizable";

/**
 * The beacon window for nextEpochId, read as a roll call of the bonded validators.
 * "absent" is a bonded validator with no commit. "unrevealed" is a committer with no reveal.
 */
export type RollCall =
  /** Fewer bonded validators with power than the threshold. No committee is possible. */
  | { readonly at: "short-of-validators"; readonly bonded: number }
  /** No window for nextEpochId, or the stored one is consumed. The chain's BeginBlock opens one. */
  | { readonly at: "no-window" }
  /** Commit window. `commitFrom` is the first height at which this daemon commits. */
  | { readonly at: "open"; readonly window: BeaconWindow; readonly commitFrom: number }
  /** Reveal window. The commit set is final, so every daemon computes the same `absent`. */
  | { readonly at: "revealing"; readonly window: BeaconWindow; readonly absent: readonly Valoper[] }
  /** Closed with fewer reveals than the threshold. The chain overwrites it. Nobody is slashed. */
  | { readonly at: "closed-short"; readonly window: BeaconWindow }
  /**
   * Closed with enough reveals, and beginning slashes nobody: no committer lacks a reveal, and
   * every other bonded validator revealed. This daemon's own poll is its own sign of life, so its
   * own reveal is not required.
   */
  | { readonly at: "ready"; readonly window: BeaconWindow; readonly committeeSize: number }
  /**
   * Closed with enough reveals, but beginning would get someone slashed: `unrevealed` by BeginEpoch
   * itself, `absent` (bonded validators other than me with no commit) by the DKG it would start.
   * The chain never overwrites a window in this state, so only patience ends it.
   * `committeeSizeIfBegun` leaves out the unrevealed, which BeginEpoch jails before it samples.
   */
  | {
      readonly at: "blocked";
      readonly window: BeaconWindow;
      readonly absent: readonly Valoper[];
      readonly unrevealed: readonly Valoper[];
      readonly committeeSizeIfBegun: number;
    };

// ---------------------------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------------------------

/** Every transaction the daemon may send to rotate an epoch. DealerDaemon.perform switches on `do`. */
export type Action =
  | { readonly do: "unjail" }
  /** `commitOpenHeight` names the window: the salt is derived from it, so a replaced window gets a new salt. */
  | { readonly do: "beaconCommit"; readonly epochId: number; readonly commitOpenHeight: number }
  | { readonly do: "beaconReveal"; readonly epochId: number; readonly commitOpenHeight: number }
  /** epochId is always the chain's next epoch id, never 0: a stale view is refused by the chain, not reinterpreted. */
  | { readonly do: "beginEpoch"; readonly epochId: number; readonly committeeSize: number; readonly threshold: number }
  /** The four DKG actions carry the DKG record they were decided from, so the sender needs nothing else. */
  | { readonly do: "dkgCommit"; readonly dkg: DealerDkg }
  | { readonly do: "dkgEncryptedShare"; readonly dkg: DealerDkg; readonly recipientIndex: number }
  | { readonly do: "dkgRevealShare"; readonly dkg: DealerDkg; readonly to: Valoper }
  | { readonly do: "dkgComplainMissing"; readonly dkg: DealerDkg; readonly dealer: Valoper }
  | { readonly do: "finalizeEpoch"; readonly epochId: number };

export type Decision = {
  readonly situation: Situation;
  /** At most one. The daemon sends it, then the next poll reads the chain again. */
  readonly action: Action | null;
  /** One sentence for the operator: why this action, or what is being waited for. */
  readonly why: string;
  /** Validators this action knowingly gets slashed. Empty unless patience has ended. */
  readonly costs: readonly Valoper[];
  /** The sentence reports something only a person can fix. */
  readonly alarm: boolean;
};

// ---------------------------------------------------------------------------------------------
// The functions
// ---------------------------------------------------------------------------------------------

/**
 * The members the chain asks to shuffle, in the chain's order: epoch.members as stored, minus
 * epoch.slashed (x/dealer keeper epochQualMembers). The single definition of "qualified".
 */
export function shufflersOf(epoch: DealerEpoch): readonly DealerMember[] {
  return epoch.members.filter((m) => !epoch.slashed.includes(m.validator));
}

/**
 * The decision. Pure and total: for every well-typed input it returns a Decision and never throws.
 * Running it twice on the same input gives the same answer, so a crash between the decision and
 * the send, or after the send, costs one poll.
 */
export function decide(view: ChainView, me: Me, memory: Memory): Decision {
  const situation = assess(view, me);
  const mine = view.validators.find((v) => v.operator === me.validator);

  // A jailed validator is not bonded, so it cannot answer a roll call. Unjail comes first.
  let jailed: string | null = null;
  if (mine?.jailed) {
    const blockedBy = memory.storeUsable
      ? memory.unjailBlockedBy
      : "the state directory failed its probe, and a bonded validator that cannot answer a roll call holds up every rotation";
    if (blockedBy === null) {
      return { situation, action: { do: "unjail" }, why: `Unjail: ${short(me.validator)} is jailed and every guard passes`, costs: [], alarm: false };
    }
    jailed = `Unjail: ${short(me.validator)} is jailed. Not unjailing: ${blockedBy}.`;
  }

  const step = stepFor(situation, view, me, mine, memory);
  return {
    situation,
    action: step.action,
    why: jailed !== null && step.action === null ? `${jailed} ${step.why}` : step.why,
    costs: step.costs ?? [],
    alarm: step.alarm ?? false,
  };
}

/** One short phrase for an action: "dkg commit for epoch 44". Used in every line about it. */
export function describe(action: Action): string {
  switch (action.do) {
    case "unjail":
      return "unjail";
    case "beaconCommit":
      return `beacon commit for epoch ${action.epochId}`;
    case "beaconReveal":
      return `beacon reveal for epoch ${action.epochId}`;
    case "beginEpoch": {
      const w = POLICY.dkgWindows;
      return `begin epoch ${action.epochId} (committee ${action.committeeSize}, threshold ${action.threshold}, windows ${w.commitBlocks}/${w.complaintBlocks}/${w.revealBlocks}/${w.finalizeBlocks})`;
    }
    case "dkgCommit":
      return `dkg commit for epoch ${action.dkg.epochId}`;
    case "dkgEncryptedShare":
      return `dkg encrypted share for index ${action.recipientIndex}`;
    case "dkgRevealShare":
      return `dkg share reveal to ${short(action.to)}`;
    case "dkgComplainMissing":
      return `dkg complaint (missing share) against ${short(action.dealer)}`;
    case "finalizeEpoch":
      return `finalize epoch ${action.epochId}`;
    default:
      return assertNever(action);
  }
}

/**
 * The lines an operator needs once per change: which situation the chain is in, and a roll call
 * that came out complete. `key` changes exactly when the line should be printed again.
 */
export function headlines(view: ChainView, situation: Situation): readonly { slot: "situation" | "rollCall"; key: string; line: string }[] {
  switch (situation.kind) {
    case "dealing": {
      const { epoch, qualified } = situation;
      return [{
        slot: "situation",
        key: `dealing:${epoch.epochId}:${qualified.length}`,
        line: `Rotation: epoch ${epoch.epochId} is dealing (${qualified.length} of ${epoch.members.length} members qualified)`,
      }];
    }
    case "keygen": {
      const d = situation.dkg;
      return [{
        slot: "situation",
        key: `keygen:${d.epochId}`,
        line: `Rotation: DKG for epoch ${d.epochId} began at ${d.startHeight}: commit by ${d.commitDeadline}, complaints by ${d.complaintDeadline}, reveals by ${d.revealDeadline}`,
      }];
    }
    case "rotating": {
      const epoch = view.dealer.epoch;
      const cannot = epoch
        ? `epoch ${epoch.epochId} cannot deal (${shufflersOf(epoch).length} of ${epoch.members.length} members qualified, need ${epoch.threshold})`
        : "there is no epoch";
      const out: { slot: "situation" | "rollCall"; key: string; line: string }[] = [{
        slot: "situation",
        key: `rotating:${epoch?.epochId ?? 0}:${situation.nextEpochId}`,
        line: `Rotation: ${cannot}. Next epoch is ${situation.nextEpochId}.`,
      }];
      const rc = situation.rollCall;
      if (rc.at === "revealing" && rc.absent.length === 0) {
        out.push({
          slot: "rollCall",
          key: `complete:${rc.window.epochId}:${rc.window.commitOpenHeight}`,
          line: `Rotation: roll call for epoch ${rc.window.epochId} complete: every bonded validator committed`,
        });
      }
      return out;
    }
    default:
      return assertNever(situation);
  }
}

/** How long after an unjail landed the next one may be sent, given how many have landed. */
export function unjailWaitMs(landed: number): number {
  if (landed <= 0) return 0;
  return Math.min(POLICY.unjail.maxWaitMs, POLICY.unjail.firstWaitMs * 2 ** (landed - 1));
}

/** The unjails of this validator that this daemon sent. Kept on disk, so a restart does not reset the wait. */
export type UnjailRecord = {
  /** Unjails that landed, counted since the last quiet stretch of POLICY.unjail.forgetAfterMs. */
  readonly landed: number;
  readonly lastLandedAtMs: number;
  /** When the chain was last asked, whatever it answered. */
  readonly lastTriedAtMs: number;
};

/** The record after an unjail landed at `nowMs`. */
export function afterUnjail(record: UnjailRecord, nowMs: number): UnjailRecord {
  const forgotten = record.landed > 0 && nowMs - record.lastLandedAtMs > POLICY.unjail.forgetAfterMs;
  return { landed: (forgotten ? 0 : record.landed) + 1, lastLandedAtMs: nowMs, lastTriedAtMs: nowMs };
}

/**
 * Why this daemon would not unjail its validator now, or null when every guard passes.
 *
 * A validator that is bonded while its node does not sign is jailed again for downtime, and one
 * that is unjailed straight back into the fault that jailed it loses stake each round. So: the
 * node this daemon talks to must be caught up, hold a block from the last 30 s and sign with this
 * validator's consensus key, and each unjail that landed doubles the wait before the next.
 */
export function unjailBlock(facts: {
  readonly nowMs: number;
  readonly record: UnjailRecord;
  readonly node: NodeStatus;
  /** The consensus key the chain holds for my validator. */
  readonly consensusPubkey: Uint8Array | null;
}): string | null {
  const { nowMs, record, node, consensusPubkey } = facts;
  const u = POLICY.unjail;

  if (nowMs - record.lastTriedAtMs < u.askEveryMs) return "the chain was asked less than a minute ago";

  const counted = nowMs - record.lastLandedAtMs > u.forgetAfterMs ? 0 : record.landed;
  const left = record.lastLandedAtMs + unjailWaitMs(counted) - nowMs;
  if (left > 0) {
    return `${counted} ${counted === 1 ? "unjail" : "unjails"} landed lately, so the next one waits ${Math.ceil(left / 60_000)} more minutes`;
  }

  if (node.catchingUp) return "this daemon's node is still catching up";
  if (nowMs - node.latestBlockTimeMs > u.nodeFreshMs) return `this daemon's node holds no block from the last ${u.nodeFreshMs / 1000} s`;
  const signsWithMine =
    node.consensusPubkey !== null &&
    consensusPubkey !== null &&
    node.consensusPubkey.length === consensusPubkey.length &&
    node.consensusPubkey.every((b, i) => b === consensusPubkey[i]);
  if (!signsWithMine) return "this daemon's node does not sign with this validator's consensus key";
  return null;
}

/** "ocpvaloper1la3r…": enough of an operator address to tell validators apart in a log line. */
export function short(validator: Valoper): string {
  return validator.length > 16 ? `${validator.slice(0, 15)}…` : validator;
}

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

// ---- not exported: what decide() is made of ----

type Step = { action: Action | null; why: string; costs?: readonly Valoper[]; alarm?: boolean };

const wait = (why: string): Step => ({ action: null, why });
const alarm = (why: string): Step => ({ action: null, why, alarm: true });
const list = (validators: readonly Valoper[]): string => validators.map(short).join(", ");

/** The validators BeginEpoch samples from: bonded, with power, ascending by operator address. */
function roll(view: ChainView): Valoper[] {
  return view.validators
    .filter((v) => v.bonded && v.power > 0)
    .map((v) => v.operator)
    .sort();
}

function assess(view: ChainView, me: Me): Situation {
  const d = view.dealer;
  if (d.dkg) {
    const phase: KeygenPhase = d.height < d.dkg.commitDeadline ? "commit" : d.height < d.dkg.revealDeadline ? "shares" : "finalizable";
    return { kind: "keygen", dkg: d.dkg, phase };
  }
  if (d.epoch) {
    const qualified = shufflersOf(d.epoch);
    if (qualified.length >= d.epoch.threshold) return { kind: "dealing", epoch: d.epoch, qualified };
  }
  return {
    kind: "rotating",
    reason: d.epoch ? "below-threshold" : "no-epoch",
    nextEpochId: d.nextEpochId,
    rollCall: rollCallOf(view, me),
  };
}

function rollCallOf(view: ChainView, me: Me): RollCall {
  const d = view.dealer;
  const h = d.height;
  const bonded = roll(view);
  if (bonded.length < me.threshold) return { at: "short-of-validators", bonded: bonded.length };

  const b = d.beacon;
  if (!b || b.consumed || b.epochId !== d.nextEpochId) return { at: "no-window" };
  if (h < b.commitCloseHeight) {
    return { at: "open", window: b, commitFrom: Math.max(b.commitOpenHeight, b.commitCloseHeight - POLICY.beaconCommitTailBlocks) };
  }

  const absent = bonded.filter((v) => !b.committed.includes(v));
  if (h < b.revealCloseHeight) return { at: "revealing", window: b, absent };
  if (b.revealed.length < b.threshold) return { at: "closed-short", window: b };

  const unrevealed = b.committed.filter((v) => !b.revealed.includes(v)).sort();
  const absentOthers = absent.filter((v) => v !== me.validator);
  if (unrevealed.length === 0 && absentOthers.length === 0) {
    return { at: "ready", window: b, committeeSize: Math.min(me.committeeSize, bonded.length) };
  }
  const jailedByBegin = unrevealed.filter((v) => bonded.includes(v)).length;
  return {
    at: "blocked",
    window: b,
    absent: absentOthers,
    unrevealed,
    committeeSizeIfBegun: Math.min(me.committeeSize, bonded.length - jailedByBegin),
  };
}

function stepFor(situation: Situation, view: ChainView, me: Me, mine: ValidatorInfo | undefined, memory: Memory): Step {
  switch (situation.kind) {
    case "dealing":
      return dealingNote(situation, memory.share);
    case "rotating":
      return rollCallStep(situation, view, me, mine, memory);
    case "keygen":
      return keygenStep(situation, view, me, memory);
    default:
      return assertNever(situation);
  }
}

function dealingNote(s: Extract<Situation, { kind: "dealing" }>, share: ShareStatus): Step {
  const id = s.epoch.epochId;
  const dealing = `Rotation: epoch ${id} is dealing (${s.qualified.length} of ${s.epoch.members.length} members qualified)`;
  const cannot = "I cannot deal, and the chain slashes this validator at the next hand it misses";
  switch (share.is) {
    case "ready":
      return wait(dealing);
    case "not-member":
      return wait(`${dealing}. This validator is not a member of it.`);
    case "slashed":
      return wait(`${dealing}. This validator is slashed in it, so the chain asks nothing of it.`);
    case "missing":
      return alarm(`DKG: I hold no share of epoch ${id} from ${list(share.from)}. ${cannot}.`);
    case "mismatch":
      return alarm(`DKG: the shares I hold for epoch ${id} do not add up to my on-chain pub_share. ${cannot}.`);
    case "unreadable":
      return alarm(`DKG: the secrets file for epoch ${id} cannot be read (${share.reason}). ${cannot}.`);
    default:
      return assertNever(share);
  }
}

function rollCallStep(
  s: Extract<Situation, { kind: "rotating" }>,
  view: ChainView,
  me: Me,
  mine: ValidatorInfo | undefined,
  memory: Memory,
): Step {
  const h = view.dealer.height;
  const id = s.nextEpochId;
  const rc = s.rollCall;
  const bonded = roll(view);
  const inRoll = bonded.includes(me.validator);
  const patient = me.patienceBlocks > 0 && memory.waitedBlocks >= me.patienceBlocks;
  const waited =
    me.patienceBlocks > 0
      ? `(waited ${memory.waitedBlocks} of ${me.patienceBlocks} blocks)`
      : "(DEALER_PATIENCE_BLOCKS is 0: holding until a person acts)";

  // BeginEpoch needs h > revealClose, a bonded caller and no DKG.
  const beginIfMyTurn = (window: BeaconWindow, committeeSize: number, costs: readonly Valoper[], head: string): Step => {
    if (!me.mayBeginEpoch) return wait(`${head}; BeginEpoch is disabled on this daemon`);
    if (!inRoll) return wait(`${head}; my validator is not bonded, so another daemon has to begin`);
    const order = bonded.filter((v) => window.revealed.includes(v));
    const rank = order.includes(me.validator) ? order.indexOf(me.validator) : order.length;
    const stagger = POLICY.turnStaggerBlocks;
    const first = window.revealCloseHeight + 1;
    if (h < first + rank * stagger) {
      const turn = Math.min(order.length - 1, Math.max(0, Math.floor((h - first) / stagger)));
      return wait(`${head}; BeginEpoch is ${short(order[turn] ?? me.validator)}'s turn until ${first + (turn + 1) * stagger}`);
    }
    return { action: { do: "beginEpoch", epochId: id, committeeSize, threshold: me.threshold }, why: head, costs };
  };

  switch (rc.at) {
    case "short-of-validators":
      return wait(`Rotation: ${rc.bonded} bonded ${rc.bonded === 1 ? "validator" : "validators"}, need ${me.threshold} for a committee. Waiting for an unjail.`);

    case "no-window":
      return wait(`Rotation: no beacon window for epoch ${id} yet. The chain opens one.`);

    case "closed-short":
      return wait(`Rotation: beacon window for epoch ${id} closed below threshold; the chain opens another`);

    case "open": {
      // BeaconCommit needs h + 1 <= commitClose and a bonded validator.
      const w = rc.window;
      if (!inRoll) return wait(`Rotation: my validator ${short(me.validator)} is not bonded; staying out of the roll call for epoch ${id}`);
      if (!memory.storeUsable) {
        return alarm(`Rotation: staying out of the roll call for epoch ${id}: the state directory failed its probe, so no DKG starts that I could not keep secrets for`);
      }
      if (w.committed.includes(me.validator)) {
        const here = bonded.filter((v) => w.committed.includes(v)).length;
        return wait(`Rotation: roll call for epoch ${id}: ${here} of ${bonded.length} bonded validators committed; reveal opens at ${w.commitCloseHeight}`);
      }
      if (h < rc.commitFrom) {
        return wait(`Rotation: roll call for epoch ${id} is open; committing from height ${rc.commitFrom} (commit closes ${w.commitCloseHeight})`);
      }
      return {
        action: { do: "beaconCommit", epochId: w.epochId, commitOpenHeight: w.commitOpenHeight },
        why: `Rotation: answering the roll call for epoch ${id}`,
      };
    }

    case "revealing": {
      // BeaconReveal needs commitClose < h < revealClose, a bonded validator and its commit.
      const w = rc.window;
      const committed = [...w.committed].sort();
      if (!committed.includes(me.validator)) {
        return wait(`Rotation: roll call for epoch ${id}: I did not commit in this window. It closes at ${w.revealCloseHeight}.`);
      }
      if (w.revealed.includes(me.validator)) {
        return wait(`Rotation: beacon for epoch ${id} has ${w.revealed.length} of ${committed.length} reveals; the window closes at ${w.revealCloseHeight}`);
      }
      if (!mine?.bonded) {
        return alarm(`Rotation: my validator is no longer bonded, and the chain takes a reveal only from a bonded one. My beacon commit for epoch ${id} stays without a reveal.`);
      }
      const reveal: Action = { do: "beaconReveal", epochId: w.epochId, commitOpenHeight: w.commitOpenHeight };

      // Already usable by BeginEpoch: a committer with no reveal is the one it slashes. Do not be that one.
      if (w.revealed.length >= w.threshold) {
        return { action: reveal, why: `Rotation: the beacon for epoch ${id} is already usable; revealing so that my commit is not left without a reveal` };
      }

      const complete = rc.absent.length === 0;
      const forced = !complete && patient && committed.length >= w.threshold;
      if (!complete && !forced) {
        return wait(`Rotation: roll call for epoch ${id} incomplete: no commit from ${list(rc.absent)}; not revealing, so no DKG can start without it ${waited}`);
      }

      if (h <= w.commitCloseHeight) {
        return wait(`Rotation: roll call for epoch ${id}: ${committed.length} of ${bonded.length} bonded validators committed; the chain takes reveals from height ${w.commitCloseHeight + 1}`);
      }

      // Reveals go in ascending validator order. A daemon that died after its commit and sorts
      // before the reveal that reaches the threshold stops the reveals short of it: the window
      // closes short, the chain replaces it, nobody is slashed.
      const before = committed.filter((v) => v < me.validator && !w.revealed.includes(v));
      if (before.length > 0) {
        return wait(`Rotation: reveals go in validator order; waiting for ${short(before[0]!)} to reveal first (window closes at ${w.revealCloseHeight})`);
      }

      if (w.revealed.length + 1 >= w.threshold) {
        // On a window shorter than twice the limit, the limit is half the window.
        const length = w.revealCloseHeight - w.commitCloseHeight;
        const since = h - w.commitCloseHeight;
        if (since > Math.min(POLICY.beaconBindingRevealBlocks, Math.ceil(length / 2))) {
          return wait(`Rotation: not revealing for epoch ${id}: my reveal would make this window usable ${since} blocks after the commits, with ${w.revealCloseHeight - h} left for the validators that reveal after me. It closes short and the chain opens another.`);
        }
      }

      if (forced) {
        return {
          action: reveal,
          why: `Rotation: patience ended after ${memory.waitedBlocks} blocks; revealing without ${list(rc.absent)}. The DKG that follows will slash it for a missing commit.`,
          costs: rc.absent,
        };
      }
      return { action: reveal, why: `Rotation: roll call for epoch ${id} complete; revealing` };
    }

    case "ready":
      return beginIfMyTurn(rc.window, rc.committeeSize, [], `Rotation: beacon for epoch ${id} has ${rc.window.revealed.length} reveals`);

    case "blocked": {
      const w = rc.window;
      if (rc.unrevealed.includes(me.validator)) {
        return alarm(`Rotation: I committed to the beacon for epoch ${id} and did not reveal. BeginEpoch will slash this validator by half, and another validator has to send it.`);
      }
      const what =
        rc.unrevealed.length > 0
          ? `${list(rc.unrevealed)} committed and did not reveal. BeginEpoch would slash it by half.`
          : `${list(rc.absent)} took no part. The DKG would slash it for a missing commit.`;
      const closed = `Rotation: beacon for epoch ${id} is closed with ${w.revealed.length} reveals, but ${what}`;
      if (!patient) return wait(`${closed} Holding ${waited}.`);
      if (rc.committeeSizeIfBegun < me.threshold) {
        return wait(`${closed} Patience has ended, but only ${rc.committeeSizeIfBegun} would remain for a committee of at least ${me.threshold}.`);
      }
      const costs = [...rc.unrevealed, ...rc.absent];
      return beginIfMyTurn(
        w,
        rc.committeeSizeIfBegun,
        costs,
        `Rotation: patience ended after ${memory.waitedBlocks} blocks; beginning epoch ${id} without ${list(costs)}, which the chain will slash`,
      );
    }

    default:
      return assertNever(rc);
  }
}

function keygenStep(s: Extract<Situation, { kind: "keygen" }>, view: ChainView, me: Me, memory: Memory): Step {
  const h = view.dealer.height;
  const dkg = s.dkg;
  const id = dkg.epochId;
  const member = dkg.members.find((m) => m.validator === me.validator);

  const duty = member ? memberStep(s, h, me, memory) : null;
  if (duty?.action) return duty;

  if (s.phase === "finalizable") {
    // FinalizeEpoch needs h > revealDeadline. Anyone may send it. A non-member goes last.
    const order = dkg.members.map((m) => m.validator).sort();
    const turn = member ? order.indexOf(me.validator) : order.length;
    const stagger = POLICY.turnStaggerBlocks;
    if (!me.mayFinalizeEpoch) {
      return duty ?? wait(`Rotation: DKG for epoch ${id} can be finalized; DEALER_AUTO_FINALIZE is off on this daemon`);
    }
    const first = dkg.revealDeadline + 1;
    if (h >= first + turn * stagger) {
      return { action: { do: "finalizeEpoch", epochId: id }, why: `Rotation: finalizing epoch ${id}` };
    }
    if (duty) return duty;
    const now = Math.min(order.length - 1, Math.max(0, Math.floor((h - first) / stagger)));
    return wait(`Rotation: DKG for epoch ${id} can be finalized; it is ${short(order[now] ?? me.validator)}'s turn until ${first + (now + 1) * stagger}`);
  }

  if (duty) return duty;
  const committed = dkg.commits.map((c) => c.dealer);
  const silent = dkg.members.map((m) => m.validator).filter((v) => !committed.includes(v));
  if (s.phase === "shares" && silent.length > 0) {
    return wait(`Rotation: DKG for epoch ${id}: no commit from ${list(silent)} and the commit deadline ${dkg.commitDeadline} has passed. Finalize will slash it.`);
  }
  return wait(`Rotation: DKG for epoch ${id} waits for height ${dkg.revealDeadline} to finalize (${committed.length} of ${dkg.members.length} committed, ${dkg.complaints.length} complaints)`);
}

/** What a member owes the DKG now: one action, or a sentence about why it owes nothing. null: nothing to say. */
function memberStep(s: Extract<Situation, { kind: "keygen" }>, h: number, me: Me, memory: Memory): Step | null {
  const dkg = s.dkg;
  const id = dkg.epochId;
  const facts = memory.keygen;

  if (dkg.slashed.includes(me.validator)) {
    return alarm(`Rotation: this validator was slashed in the DKG for epoch ${id}. Nothing more is asked of it.`);
  }
  if (facts?.disk === "unreadable") {
    return alarm(`DKG: the secrets file for epoch ${id} cannot be read (${facts.reason}). Not committing and not sending shares: a new commit would replace secrets that a landed commit may depend on.`);
  }

  if (!dkg.commits.some((c) => c.dealer === me.validator)) {
    // DkgCommit needs h + 1 <= commitDeadline.
    if (s.phase !== "commit") {
      return alarm(`Rotation: DKG for epoch ${id}: no commit from me and the commit deadline ${dkg.commitDeadline} has passed. Finalize will slash this validator.`);
    }
    if (!memory.storeUsable) {
      return alarm(`Rotation: DKG for epoch ${id}: the state directory failed its probe, so I cannot store the secrets a commit needs. Finalize slashes this validator unless that is fixed before height ${dkg.commitDeadline}.`);
    }
    return { action: { do: "dkgCommit", dkg }, why: `Rotation: committing to the DKG for epoch ${id}` };
  }

  if (!facts) return null;
  if (facts.commitMatchesDisk === false) {
    return alarm(`DKG: my commit for epoch ${id} is on chain but the secrets on disk do not match it. I cannot deliver shares. If a member complains, finalize slashes this validator by half.`);
  }
  // Facts taken before my commit landed say nothing about it yet. The next poll has them.
  if (facts.commitMatchesDisk === null) return null;

  // Shares and reveals need h + 1 <= revealDeadline.
  if (h >= dkg.revealDeadline) return null;

  // An unanswered complaint is a slash at finalize, whatever its kind: finalize accepts only a plaintext reveal.
  const complaint = dkg.complaints.find(
    (c) => c.dealer === me.validator && !dkg.reveals.some((r) => r.dealer === me.validator && r.to === c.complainer),
  );
  if (complaint) {
    return { action: { do: "dkgRevealShare", dkg, to: complaint.complainer }, why: `Rotation: answering ${short(complaint.complainer)}'s complaint in the DKG for epoch ${id}` };
  }

  // What is left has no order of its own: the shares I owe, and the complaints that are due. One a
  // poll, a different one each block, so that one the chain keeps refusing does not hold back the rest.
  const owed = dkg.members
    .filter((m) => m.validator !== me.validator && m.ephemeralPubkey !== null)
    .filter((m) => !dkg.encryptedShares.some((e) => e.dealer === me.validator && e.recipientIndex === m.index))
    .sort((a, b) => a.index - b.index)
    .map((m): Step => ({
      action: { do: "dkgEncryptedShare", dkg, recipientIndex: m.index },
      why: `Rotation: sending ${short(m.validator)} its share in the DKG for epoch ${id}`,
    }));

  // A "missing" complaint only against a dealer whose share I do not hold. It is a deadline with a
  // 50% penalty on that dealer, so a DKG where every share arrived has none.
  const lacking = dkg.commits
    .map((c) => c.dealer)
    .filter((d) => d !== me.validator && !facts.holds.has(d) && !dkg.slashed.includes(d))
    .filter((d) => !dkg.complaints.some((c) => c.complainer === me.validator && c.dealer === d));
  // Complaints need commitDeadline <= h + 1 <= complaintDeadline. The first half of the window is left for late shares.
  const from = dkg.commitDeadline + Math.ceil((dkg.complaintDeadline - dkg.commitDeadline) / 2);
  const complaints =
    h >= from && h < dkg.complaintDeadline
      ? lacking.map((dealer): Step => ({
          action: { do: "dkgComplainMissing", dkg, dealer },
          why: `DKG: no usable share from ${short(dealer)} for epoch ${id}; filing a complaint so that it reveals the share`,
        }))
      : [];

  const duties = [...owed, ...complaints];
  if (duties.length > 0) return duties[h % duties.length]!;
  if (lacking.length === 0) return null;
  if (h < from) return wait(`DKG: no usable share from ${list(lacking)} for epoch ${id}; a complaint can be filed from height ${from}`);
  return alarm(`DKG: no usable share from ${list(lacking)} for epoch ${id}, and the complaint deadline ${dkg.complaintDeadline} has passed`);
}
