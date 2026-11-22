// A model of the dealer module, for searching schedules without a chain. It has the rules that can
// slash a validator or block a rotation, each copied by hand from apps/cosmos/x/dealer/keeper and
// cited by file. It does no cryptography: a commit, a share and a reveal are facts, not bytes.
// The model can be wrong where the Go is subtle. A run on a real three-validator network is the
// authority, and this is the search for the schedule nobody thought of.

import type { BeaconWindow, DealerDkg, DealerEpoch, ValidatorInfo } from "@onchainpoker/ocp-sdk/cosmos";
import type { ChainView } from "../src/rotation.js";

export type Tx =
  | { type: "beaconCommit"; validator: string; epochId: number }
  | { type: "beaconReveal"; validator: string; epochId: number }
  | { type: "beginEpoch"; caller: string; epochId: number; committeeSize: number; threshold: number; commitBlocks: number; complaintBlocks: number; revealBlocks: number }
  | { type: "dkgCommit"; dealer: string; epochId: number }
  | { type: "dkgEncryptedShare"; dealer: string; epochId: number; recipientIndex: number }
  | { type: "dkgComplaintMissing"; complainer: string; epochId: number; dealer: string }
  | { type: "dkgShareReveal"; dealer: string; epochId: number; to: string }
  | { type: "finalizeEpoch"; epochId: number }
  | { type: "unjail"; validator: string };

export type Slash = { validator: string; reason: string; height: number };

type Validator = { operator: string; jailed: boolean; jailedUntil: number; power: number };
type Dkg = {
  epochId: number;
  threshold: number;
  startHeight: number;
  commitDeadline: number;
  complaintDeadline: number;
  revealDeadline: number;
  members: string[];
  committed: string[];
  /** "dealer>recipientIndex" */
  shares: Set<string>;
  complaints: { complainer: string; dealer: string }[];
  /** "dealer>to" */
  reveals: Set<string>;
  slashed: string[];
};
type Beacon = { epochId: number; commitOpen: number; commitClose: number; revealClose: number; threshold: number; committed: string[]; revealed: string[]; consumed: boolean };

const MARK = new Uint8Array(1);
const BEACON_BLOCKS = 50; // beacon.go: beaconCommitBlocksProd, beaconRevealBlocksProd
const JAIL_BLOCKS_DKG = 17_280; // jail_seconds_dkg 86400 at 5 s blocks

export class ModelChain {
  height: number;
  nextEpochId: number;
  epoch: { epochId: number; threshold: number; startHeight: number; members: string[]; slashed: string[] } | null;
  dkg: Dkg | null = null;
  beacon: Beacon | null = null;
  readonly validators: Validator[];
  readonly slashes: Slash[] = [];
  readonly begun: { epochId: number; height: number; committee: string[] }[] = [];
  readonly finalized: { epochId: number; height: number; qualified: number; aborted: boolean }[] = [];
  /** Every transaction that was accepted, with the height of its block. */
  readonly landed: { height: number; tx: Tx }[] = [];
  /** The DKG as it was when it was finalized, which a daemon that was down reads at a past height. */
  readonly finalDkgs = new Map<number, Dkg>();

  /** Starts where the live chain stood: a dead epoch, and a next epoch id that is not the epoch's plus one. */
  constructor(operators: string[], at: { height: number; deadEpochId: number; nextEpochId: number }) {
    this.height = at.height;
    this.nextEpochId = at.nextEpochId;
    this.validators = [...operators].sort().map((operator, i) => ({ operator, jailed: false, jailedUntil: 0, power: 1000 + i }));
    this.epoch = { epochId: at.deadEpochId, threshold: 2, startHeight: 1, members: [...operators].sort(), slashed: [...operators].sort() };
  }

  private bonded(): string[] {
    return this.validators.filter((v) => !v.jailed && v.power > 0).map((v) => v.operator);
  }

  /** keeper/penalty.go: slash, then jail unless it is the last bonded validator. */
  private penalize(validator: string, reason: string): void {
    this.slashes.push({ validator, reason, height: this.height });
    const v = this.validators.find((x) => x.operator === validator);
    if (!v) return;
    const bonded = this.bonded();
    if (!(bonded.length === 1 && bonded[0] === validator)) v.jailed = true;
    v.jailedUntil = Math.max(v.jailedUntil, this.height + JAIL_BLOCKS_DKG);
  }

  /** keeper/beacon.go MaybeAutoOpenBeacon, at a height above beaconStuckRecoveryHeight. */
  private beginBlock(): void {
    const b = this.beacon;
    if (b && !b.consumed) {
      const live = this.height <= b.revealClose;
      const consumable = b.revealed.length >= b.threshold;
      if (live || consumable) return;
    }
    if (this.dkg) return;
    if (b && b.epochId === this.nextEpochId && b.consumed) return;
    const threshold = Math.max(2, this.epoch?.threshold ?? 0);
    this.beacon = {
      epochId: this.nextEpochId,
      commitOpen: this.height,
      commitClose: this.height + BEACON_BLOCKS,
      revealClose: this.height + 2 * BEACON_BLOCKS,
      threshold,
      committed: [],
      revealed: [],
      consumed: false,
    };
  }

  /**
   * What the node answers when a transaction is sent: its simulation, which runs the rules at the
   * last committed height although the block that executes the transaction is one higher (seen on
   * a real chain: "too early to finalize: height=1100342 revealDeadline=1100342"). null, or the
   * reason it was refused. A refused transaction is never broadcast. Changes nothing.
   */
  simulate(tx: Tx): string | null {
    const copy: ModelChain = Object.setPrototypeOf(structuredClone(this), ModelChain.prototype);
    return copy.deliver(tx);
  }

  /** The next block: BeginBlock, then the transactions in order. Each answer is null or the reason it was refused. */
  block(txs: readonly Tx[]): (string | null)[] {
    this.height++;
    this.beginBlock();
    return txs.map((tx) => {
      const refused = this.deliver(tx);
      if (refused === null) this.landed.push({ height: this.height, tx });
      return refused;
    });
  }

  private deliver(tx: Tx): string | null {
    const h = this.height;
    const bonded = this.bonded();
    switch (tx.type) {
      case "beaconCommit": {
        // beacon.go BeaconCommit
        const b = this.beacon;
        if (!bonded.includes(tx.validator)) return "not an active bonded validator";
        if (!b) return "no beacon window open";
        if (tx.epochId !== b.epochId) return "epoch_id mismatch";
        if (h < b.commitOpen) return "commit window not yet open";
        if (h > b.commitClose) return "commit window closed";
        if (b.committed.includes(tx.validator)) return "commit already submitted";
        b.committed.push(tx.validator);
        return null;
      }
      case "beaconReveal": {
        // beacon.go BeaconReveal
        const b = this.beacon;
        if (!bonded.includes(tx.validator)) return "not an active bonded validator";
        if (!b) return "no beacon window open";
        if (tx.epochId !== b.epochId) return "epoch_id mismatch";
        if (h <= b.commitClose) return "reveal window not yet open";
        if (h > b.revealClose) return "reveal window closed";
        if (!b.committed.includes(tx.validator)) return "no commit from this validator";
        if (b.revealed.includes(tx.validator)) return "reveal already submitted";
        b.revealed.push(tx.validator);
        return null;
      }
      case "beginEpoch": {
        // msg_server.go BeginEpoch, beacon.go consumeBeaconForEpoch, committee/weighted.go SampleByPower.
        // A failure anywhere reverts the whole message, so nothing is changed before the last check.
        if (tx.threshold < 2) return "threshold must be >= 2";
        if (tx.committeeSize < tx.threshold) return "committee_size must be >= threshold";
        if (!bonded.includes(tx.caller)) return "caller is not an active bonded validator";
        if (this.dkg) return "dkg already in progress";
        if (tx.epochId !== this.nextEpochId) return `unexpected epoch_id: expected ${this.nextEpochId} got ${tx.epochId}`;
        const b = this.beacon;
        if (!b || b.epochId !== tx.epochId || h <= b.revealClose) return "production chain requires a closed beacon window";
        if (b.revealed.length < b.threshold) return "beacon below threshold";
        const unrevealed = b.committed.filter((v) => !b.revealed.includes(v));
        const eligible = bonded.filter((v) => !unrevealed.includes(v));
        if (eligible.length < tx.committeeSize) return `not enough eligible candidates: have ${eligible.length} need ${tx.committeeSize}`;

        for (const v of unrevealed) this.penalize(v, "beacon-missing-reveal");
        b.consumed = true;
        const committee = eligible.slice(0, tx.committeeSize);
        this.dkg = {
          epochId: tx.epochId,
          threshold: tx.threshold,
          startHeight: h,
          commitDeadline: h + tx.commitBlocks,
          complaintDeadline: h + tx.commitBlocks + tx.complaintBlocks,
          revealDeadline: h + tx.commitBlocks + tx.complaintBlocks + tx.revealBlocks,
          members: committee,
          committed: [],
          shares: new Set(),
          complaints: [],
          reveals: new Set(),
          slashed: [],
        };
        this.nextEpochId = tx.epochId + 1;
        this.begun.push({ epochId: tx.epochId, height: h, committee });
        return null;
      }
      case "dkgCommit": {
        // msg_server.go DkgCommit
        const d = this.dkg;
        if (!d) return "no dkg in progress";
        if (tx.epochId !== d.epochId) return "epoch_id mismatch";
        if (h > d.commitDeadline) return "commit deadline passed";
        if (!d.members.includes(tx.dealer)) return "dealer not in committee";
        if (d.committed.includes(tx.dealer)) return "commit already submitted";
        d.committed.push(tx.dealer);
        return null;
      }
      case "dkgEncryptedShare": {
        // msg_server.go DkgEncryptedShare
        const d = this.dkg;
        if (!d) return "no dkg in progress";
        if (tx.epochId !== d.epochId) return "epoch_id mismatch";
        if (h > d.revealDeadline) return "reveal deadline passed";
        if (!d.members.includes(tx.dealer)) return "dealer not in committee";
        const recipient = d.members[tx.recipientIndex - 1];
        if (!recipient) return "recipient_index not in committee";
        if (recipient === tx.dealer) return "dealer cannot address itself";
        if (!d.committed.includes(recipient)) return "recipient has no ephemeral_pubkey yet";
        if (!d.committed.includes(tx.dealer)) return "dealer has not committed";
        const key = `${tx.dealer}>${tx.recipientIndex}`;
        if (d.shares.has(key)) return "encrypted share already submitted";
        d.shares.add(key);
        return null;
      }
      case "dkgComplaintMissing": {
        // msg_server.go DkgComplaintMissing
        const d = this.dkg;
        if (!d) return "no dkg in progress";
        if (tx.epochId !== d.epochId) return "epoch_id mismatch";
        if (h < d.commitDeadline) return "complaints not yet allowed";
        if (h > d.complaintDeadline) return "complaint deadline passed";
        if (!d.members.includes(tx.complainer) || !d.members.includes(tx.dealer)) return "not in committee";
        if (d.complaints.some((c) => c.complainer === tx.complainer && c.dealer === tx.dealer)) return "complaint already filed";
        d.complaints.push({ complainer: tx.complainer, dealer: tx.dealer });
        return null;
      }
      case "dkgShareReveal": {
        // msg_server.go DkgShareReveal
        const d = this.dkg;
        if (!d) return "no dkg in progress";
        if (tx.epochId !== d.epochId) return "epoch_id mismatch";
        if (h > d.revealDeadline) return "reveal deadline passed";
        if (!d.complaints.some((c) => c.complainer === tx.to && c.dealer === tx.dealer)) return "no complaint for this dealer/to";
        const key = `${tx.dealer}>${tx.to}`;
        if (d.reveals.has(key)) return "reveal already submitted";
        if (!d.committed.includes(tx.dealer)) return "dealer has not committed";
        d.reveals.add(key);
        return null;
      }
      case "finalizeEpoch": {
        // msg_server.go FinalizeEpoch, ops.go finalizeEpoch
        const d = this.dkg;
        if (!d) return "no dkg in progress";
        if (tx.epochId !== d.epochId) return "epoch_id mismatch";
        if (h <= d.revealDeadline) return "too early to finalize";
        const slash = (v: string, reason: string) => {
          if (d.slashed.includes(v)) return;
          d.slashed.push(v);
          this.penalize(v, reason);
        };
        for (const m of d.members) if (!d.committed.includes(m)) slash(m, "dkg-missing-commit");
        for (const c of d.complaints) {
          if (d.slashed.includes(c.dealer)) continue;
          if (!d.committed.includes(c.dealer)) slash(c.dealer, "dkg-missing-commit");
          else if (!d.reveals.has(`${c.dealer}>${c.complainer}`)) slash(c.dealer, "dkg-complaint-unresolved");
        }
        const qualified = d.members.filter((m) => !d.slashed.includes(m));
        this.finalDkgs.set(d.epochId, d);
        this.dkg = null;
        const aborted = qualified.length < d.threshold;
        this.finalized.push({ epochId: d.epochId, height: h, qualified: qualified.length, aborted });
        // Below threshold the DKG is deleted and the old epoch stays. The next epoch id is not rolled back.
        if (!aborted) this.epoch = { epochId: d.epochId, threshold: d.threshold, startHeight: d.startHeight, members: d.members, slashed: [...d.slashed].sort() };
        return null;
      }
      case "unjail": {
        // x/slashing Unjail: refused until the jail time is over.
        const v = this.validators.find((x) => x.operator === tx.validator);
        if (!v || !v.jailed) return "validator not jailed";
        if (h < v.jailedUntil) return "validator still jailed; cannot be unjailed";
        v.jailed = false;
        return null;
      }
    }
  }

  /** The dealer state and validators as the SDK hands them to the daemon. */
  view(): ChainView {
    return { dealer: { height: this.height, nextEpochId: this.nextEpochId, epoch: this.epochView(), dkg: this.dkgView(this.dkg), beacon: this.beaconView() }, validators: this.validatorsView() };
  }

  validatorsView(): ValidatorInfo[] {
    return this.validators.map((v) => ({ operator: v.operator, bonded: !v.jailed, jailed: v.jailed, power: v.power, consensusPubkey: MARK }));
  }

  private epochView(): DealerEpoch | null {
    const e = this.epoch;
    return e && { epochId: e.epochId, threshold: e.threshold, startHeight: e.startHeight, slashed: e.slashed, members: e.members.map((validator, i) => ({ validator, index: i + 1, pubShare: MARK, ephemeralPubkey: MARK, power: 1000 })) };
  }

  dkgView(d: Dkg | null): DealerDkg | null {
    return d && {
      epochId: d.epochId,
      threshold: d.threshold,
      startHeight: d.startHeight,
      commitDeadline: d.commitDeadline,
      complaintDeadline: d.complaintDeadline,
      revealDeadline: d.revealDeadline,
      members: d.members.map((validator, i) => ({ validator, index: i + 1, pubShare: null, ephemeralPubkey: d.committed.includes(validator) ? MARK : null, power: 1000 })),
      commits: d.committed.map((dealer) => ({ dealer, commitments: [] })),
      encryptedShares: [...d.shares].map((key) => {
        const [dealer, index] = key.split(">");
        return { dealer: dealer!, recipientIndex: Number(index), u: MARK, v: MARK, proof: MARK, scalarCt: MARK };
      }),
      complaints: d.complaints.map((c) => ({ ...c, kind: "missing" })),
      reveals: [...d.reveals].map((key) => {
        const [dealer, to] = key.split(">");
        return { dealer: dealer!, to: to!, share: MARK };
      }),
      slashed: d.slashed,
    };
  }

  private beaconView(): BeaconWindow | null {
    const b = this.beacon;
    return b && { epochId: b.epochId, commitOpenHeight: b.commitOpen, commitCloseHeight: b.commitClose, revealCloseHeight: b.revealClose, threshold: b.threshold, committed: [...b.committed].sort(), revealed: [...b.revealed].sort(), consumed: b.consumed };
  }
}
