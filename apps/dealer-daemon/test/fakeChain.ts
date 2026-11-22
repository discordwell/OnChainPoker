// A chain for running real DealerDaemons end to end without a node: the model's rules for heights,
// windows and slashing (modelChain.ts), plus the checks the real chain makes on the bytes it is
// sent: a beacon reveal against its commit, an encrypted share against its dealer's commitments, a
// plaintext share likewise, and the epoch's public shares from the commitments at finalize.
// A transaction a daemon sends is the only one in the next block.

import { createHash } from "node:crypto";
import {
  GroupElement,
  decodeDkgEncShareProof,
  dkgEncShareVerify,
  evalCommitments,
  groupElementFromBytes,
  groupElementToBytes,
  mulBase,
  pointAdd,
  pointEq,
  scalarFromBytes,
} from "@onchainpoker/ocp-crypto";
import { OCP_TYPE_URLS } from "@onchainpoker/ocp-sdk/cosmos";
import {
  BeaconState,
  DealerDKG,
  DealerEpoch,
} from "../../../packages/ocp-sdk/dist/cosmos/gen/onchainpoker/dealer/v1/dealer.js";
import { FakeNode, accountOf, type Sent } from "./fakeNode.js";
import { ModelChain, type Tx } from "./modelChain.js";

const MSG = OCP_TYPE_URLS.dealer;
const STORE_KEYS = [0x01, 0x02, 0x03, 0x05];
const consensusKeyOf = (i: number) => new Uint8Array(32).fill(i + 1);

/** x/dealer/committee Commit: sha256 of the domain, then each part behind its length as u32 little-endian. */
function beaconCommit(validator: string, epochId: number, salt: Uint8Array): Uint8Array {
  const h = createHash("sha256").update("ocp/v1/beacon/commit");
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64LE(BigInt(epochId));
  for (const part of [Buffer.from(validator), epoch, Buffer.from(salt)]) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(part.length);
    h.update(length).update(part);
  }
  return h.digest();
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

type Bytes = {
  commitments: Map<string, Uint8Array[]>;
  ephemeral: Map<string, Uint8Array>;
  shares: { dealer: string; recipientIndex: number; u: Uint8Array; v: Uint8Array; proof: Uint8Array; scalarCt: Uint8Array }[];
  reveals: { dealer: string; to: string; share: Uint8Array }[];
};

export class FakeChain {
  readonly model: ModelChain;
  readonly node = new FakeNode();
  /** Every message a daemon sent that the chain accepted. */
  readonly accepted: Sent[] = [];
  /** A test's way to make the chain refuse a message it would accept. Returns the refusal, or null. */
  refuse: (msg: Sent) => string | null = () => null;

  private beaconWindow = 0;
  private beaconCommits = new Map<string, Uint8Array>();
  private beaconSalts = new Map<string, Uint8Array>();
  private dkgEpoch = 0;
  private dkg: Bytes = { commitments: new Map(), ephemeral: new Map(), shares: [], reveals: [] };
  private pubShares = new Map<string, Uint8Array>();
  private pkEpoch = new Uint8Array(32);
  private readonly history = new Map<number, (Uint8Array | null)[]>();

  constructor(operators: string[], at: { height: number; deadEpochId: number; nextEpochId: number }) {
    this.model = new ModelChain(operators, at);
    this.node.answer = (msg) => {
      const refused = this.submit(msg);
      return refused === null ? "land" : { refuse: refused };
    };
    this.node.storeAt = (key, height) => {
      const snapshot = this.history.get(height);
      if (!snapshot) throw new Error("version does not exist");
      return snapshot[STORE_KEYS.indexOf(key)]!;
    };
    this.refresh();
  }

  /** Empty blocks until the chain is at `height`. */
  advanceTo(height: number): void {
    while (this.model.height < height) {
      this.model.block([]);
      this.refresh();
    }
  }

  /**
   * The next height at which a daemon may have something to do: the beacon's commit tail, its two
   * closes and the turns after them, and the DKG's deadlines. A driver that polls only there
   * misses nothing, because between them the chain shows the daemons the same state.
   */
  nextEventHeight(): number {
    const b = this.model.beacon;
    const d = this.model.dkg;
    const marks = [
      ...(b ? [b.commitClose - 12, b.commitClose, b.revealClose, b.revealClose + 1, b.revealClose + 2, b.revealClose + 4, b.revealClose + 6] : []),
      ...(d ? [d.commitDeadline, d.commitDeadline + (d.complaintDeadline - d.commitDeadline) / 2, d.complaintDeadline, d.revealDeadline, d.revealDeadline + 2, d.revealDeadline + 4, d.revealDeadline + 6] : []),
    ].filter((h) => h > this.model.height);
    return marks.length > 0 ? Math.min(...marks) : this.model.height + 1;
  }

  private submit(msg: Sent): string | null {
    const v = msg.value;
    const refusal = this.refuse(msg) ?? this.check(msg);
    if (refusal !== null) return refusal;
    const tx = this.txOf(msg);
    if (tx === null) return `not modelled: ${msg.typeUrl}`;

    const [refused] = this.model.block([tx]);
    if (refused === null) {
      this.accepted.push(msg);
      switch (msg.typeUrl) {
        case MSG.beaconCommit:
          this.beaconCommits.set(v.validator, v.commit);
          break;
        case MSG.beaconReveal:
          this.beaconSalts.set(v.validator, v.salt);
          break;
        case MSG.dkgCommit:
          this.dkg.commitments.set(v.dealer, v.commitments);
          this.dkg.ephemeral.set(v.dealer, v.ephemeralPubkey);
          break;
        case MSG.dkgEncryptedShare:
          this.dkg.shares.push({ dealer: v.dealer, recipientIndex: v.recipientIndex, u: v.u, v: v.v, proof: v.proof, scalarCt: v.scalarCt });
          break;
        case MSG.dkgShareReveal:
          this.dkg.reveals.push({ dealer: v.dealer, to: v.to, share: v.share });
          break;
        case MSG.finalizeEpoch:
          this.publishShares(Number(v.epochId));
          break;
      }
    }
    this.refresh();
    return refused ?? null;
  }

  /** The checks the chain makes on bytes, which the model does not carry. */
  private check(msg: Sent): string | null {
    const v = msg.value;
    switch (msg.typeUrl) {
      case MSG.beaconCommit:
        return v.commit.length === 32 ? null : "commit must be 32 bytes";
      case MSG.beaconReveal: {
        const commit = this.beaconCommits.get(v.validator);
        if (!commit) return "no commit from this validator";
        return same(beaconCommit(v.validator, Number(v.epochId), v.salt), commit) ? null : "reveal does not match commit";
      }
      case MSG.dkgCommit:
        for (const c of [...v.commitments, v.ephemeralPubkey]) groupElementFromBytes(c);
        return null;
      case MSG.dkgEncryptedShare: {
        const commitments = this.dkg.commitments.get(v.dealer);
        const recipient = this.model.dkg?.members[v.recipientIndex - 1];
        const pkR = recipient && this.dkg.ephemeral.get(recipient);
        if (!commitments || !pkR) return null; // the model refuses these by its own rules
        const ok = dkgEncShareVerify({
          commitments: commitments.map(groupElementFromBytes),
          j: v.recipientIndex,
          pkR: groupElementFromBytes(pkR),
          u: groupElementFromBytes(v.u),
          v: groupElementFromBytes(v.v),
          proof: decodeDkgEncShareProof(v.proof),
        });
        return ok && v.scalarCt.length === 48 ? null : "invalid encrypted-share proof";
      }
      case MSG.dkgShareReveal: {
        const commitments = this.dkg.commitments.get(v.dealer);
        const index = (this.model.dkg?.members.indexOf(v.to) ?? -1) + 1;
        if (!commitments || index === 0) return null;
        const expected = evalCommitments(commitments.map(groupElementFromBytes), index);
        return pointEq(mulBase(scalarFromBytes(v.share)), expected) ? null : "share does not match commitments";
      }
      default:
        return null;
    }
  }

  private txOf(msg: Sent): Tx | null {
    const v = msg.value;
    const epochId = Number(v.epochId);
    const caller = () => this.model.validators.find((x) => accountOf(x.operator) === v.caller)?.operator ?? v.caller;
    switch (msg.typeUrl) {
      case MSG.beaconCommit:
        return { type: "beaconCommit", validator: v.validator, epochId };
      case MSG.beaconReveal:
        return { type: "beaconReveal", validator: v.validator, epochId };
      case MSG.beginEpoch:
        return { type: "beginEpoch", caller: caller(), epochId, committeeSize: v.committeeSize, threshold: v.threshold, commitBlocks: Number(v.commitBlocks), complaintBlocks: Number(v.complaintBlocks), revealBlocks: Number(v.revealBlocks) };
      case MSG.dkgCommit:
        return { type: "dkgCommit", dealer: v.dealer, epochId };
      case MSG.dkgEncryptedShare:
        return { type: "dkgEncryptedShare", dealer: v.dealer, epochId, recipientIndex: v.recipientIndex };
      case MSG.dkgComplaintMissing:
        return { type: "dkgComplaintMissing", complainer: v.complainer, epochId, dealer: v.dealer };
      case MSG.dkgShareReveal:
        return { type: "dkgShareReveal", dealer: v.dealer, epochId, to: v.to };
      case MSG.finalizeEpoch:
        return { type: "finalizeEpoch", epochId };
      case OCP_TYPE_URLS.slashing.unjail:
        return { type: "unjail", validator: v.validatorAddr };
      default:
        return null;
    }
  }

  /** ops.go finalizeEpoch: Y_j is the sum, over the dealers not slashed, of that dealer's commitments at j. */
  private publishShares(epochId: number): void {
    const final = this.model.finalDkgs.get(epochId);
    if (!final || this.model.epoch?.epochId !== epochId) return;
    const qualified = final.members.filter((m) => !final.slashed.includes(m)).map((m) => this.dkg.commitments.get(m)!.map(groupElementFromBytes));
    this.pubShares = new Map(
      final.members.map((m, i) => [m, groupElementToBytes(qualified.reduce((sum, c) => pointAdd(sum, evalCommitments(c, i + 1)), GroupElement.zero()))]),
    );
    this.pkEpoch = groupElementToBytes(qualified.reduce((sum, c) => pointAdd(sum, c[0]!), GroupElement.zero()));
  }

  /** Copies the model's state, with the bytes, into what the node serves, and keeps it for reads at this height. */
  private refresh(): void {
    const { model, node } = this;
    if (model.beacon && model.beacon.commitOpen !== this.beaconWindow) {
      this.beaconWindow = model.beacon.commitOpen;
      this.beaconCommits = new Map();
      this.beaconSalts = new Map();
    }
    if (model.dkg && model.dkg.epochId !== this.dkgEpoch) {
      this.dkgEpoch = model.dkg.epochId;
      this.dkg = { commitments: new Map(), ephemeral: new Map(), shares: [], reveals: [] };
    }
    const member = (validator: string, i: number) => ({
      validator,
      index: i + 1,
      consPubkey: consensusKeyOf(model.validators.findIndex((x) => x.operator === validator)),
      power: "1000",
    });

    node.height = model.height;
    node.nextEpochId = model.nextEpochId;
    node.validators = model.validators.map((x, i) => ({
      operator: x.operator,
      status: x.jailed ? "BOND_STATUS_UNBONDING" : "BOND_STATUS_BONDED",
      jailed: x.jailed,
      tokens: String(x.power * 1_000_000),
      consensusKey: consensusKeyOf(i),
    }));
    const b = model.beacon;
    node.beacon = b && BeaconState.fromPartial({
      epochId: String(b.epochId),
      commitOpenHeight: String(b.commitOpen),
      commitCloseHeight: String(b.commitClose),
      revealCloseHeight: String(b.revealClose),
      threshold: b.threshold,
      commits: [...b.committed].sort().map((validator) => ({ validator, commit: this.beaconCommits.get(validator) })),
      reveals: [...b.revealed].sort().map((validator) => ({ validator, salt: this.beaconSalts.get(validator) })),
      final: b.consumed ? new Uint8Array(32).fill(1) : new Uint8Array(),
    });
    const d = model.dkg;
    node.dkg = d && DealerDKG.fromPartial({
      epochId: String(d.epochId),
      threshold: d.threshold,
      members: d.members.map((m, i) => ({ ...member(m, i), ephemeralPubkey: this.dkg.ephemeral.get(m) })),
      startHeight: String(d.startHeight),
      commitDeadline: String(d.commitDeadline),
      complaintDeadline: String(d.complaintDeadline),
      revealDeadline: String(d.revealDeadline),
      commits: d.committed.map((dealer) => ({ dealer, commitments: this.dkg.commitments.get(dealer) })),
      encryptedShares: this.dkg.shares,
      complaints: d.complaints.map((c) => ({ epochId: String(d.epochId), ...c, kind: "missing" })),
      reveals: this.dkg.reveals.map((r) => ({ epochId: String(d.epochId), ...r })),
      slashed: d.slashed,
    });
    const e = model.epoch;
    node.epoch = e && DealerEpoch.fromPartial({
      epochId: String(e.epochId),
      threshold: e.threshold,
      pkEpoch: this.pkEpoch,
      startHeight: String(e.startHeight),
      slashed: e.slashed,
      members: e.members.map((m, i) => ({ ...member(m, i), pubShare: this.pubShares.get(m) ?? new Uint8Array(32) })),
    });
    this.history.set(model.height, STORE_KEYS.map((key) => node.storeValue(key)));
  }
}
