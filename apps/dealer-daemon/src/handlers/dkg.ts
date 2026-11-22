// The DKG's secret arithmetic and its bookkeeping on disk: the polynomial, the shares I owe, the
// shares I am owed, and my share of the epoch key.
//
// Nothing here takes a chain client, so nothing here can send a transaction or read the chain. It
// is handed the DKG or the epoch as the SDK parsed it. When to do each thing is decided in
// rotation.ts.

import { randomBytes } from "node:crypto";
import {
  CURVE_ORDER,
  decryptShareScalar,
  dkgEncShareProve,
  encodeDkgEncShareProof,
  encryptShareScalar,
  evalCommitments,
  groupElementFromBytes,
  groupElementToBytes,
  mulBase,
  mulPoint,
  pointAdd,
  pointEq,
  scalarFromBytes,
  scalarFromBytesModOrder,
  scalarToBytes,
} from "@onchainpoker/ocp-crypto";
import type { DealerDkg, DealerEpoch, DealerMember, Valoper } from "@onchainpoker/ocp-sdk/cosmos";
import { logProgress } from "../log.js";
import type { KeygenFacts, ShareStatus } from "../rotation.js";
import { SecretsUnreadableError, type EpochSecrets, type EpochStateStore } from "../state.js";

/** The two things this file needs of the secrets directory. A read-only caller passes a save that does nothing. */
export type SecretsStore = Pick<EpochStateStore, "load" | "save">;

function modQ(n: bigint): bigint {
  const x = n % CURVE_ORDER;
  return x < 0n ? x + CURVE_ORDER : x;
}

function evalPoly(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n;
  let pow = 1n;
  for (const a of coeffs) {
    acc = modQ(acc + modQ(a) * pow);
    pow = modQ(pow * x);
  }
  return modQ(acc);
}

function nonzeroScalar(): bigint {
  while (true) {
    const s = scalarFromBytesModOrder(randomBytes(64));
    if (s !== 0n) return s;
  }
}

const scalarOf = (hex: string): bigint => BigInt(`0x${hex}`);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

declare const onDisk: unique symbol;

/**
 * What goes into MsgDkgCommit. Only prepareCommit makes one, and it makes one only after the
 * secrets behind it are durable. A commit that is not on disk has no type, so it cannot be sent.
 */
export type StoredCommit = {
  readonly commitments: Uint8Array[];
  readonly ephemeralPubkey: Uint8Array;
  readonly [onDisk]: true;
};

function publicHalf(secrets: EpochSecrets): { commitments: Uint8Array[]; ephemeralPubkey: Uint8Array } {
  return {
    commitments: secrets.polyCoeffs.map((c) => groupElementToBytes(mulBase(scalarOf(c)))),
    ephemeralPubkey: groupElementToBytes(mulBase(scalarOf(secrets.ephemeralSk))),
  };
}

/**
 * The commit for this DKG, the same one every time it is called.
 *
 * The first call draws `dkg.threshold` coefficients and an ephemeral key, saves them durably, and
 * only then returns. Later calls load that file and return the same commitments, so a commit that
 * was sent and lost, or sent and unconfirmed, is sent again byte for byte, and whichever copy lands
 * matches the disk.
 *
 * A file for this epoch id with another coefficient count or member index is left over from
 * something that was not this DKG (the chain never reuses an epoch id). The caller asks for a
 * commit only while its commit is not on chain, so nothing depends on that file yet: it is
 * replaced. A file that cannot be read is not replaced: load() throws.
 */
export async function prepareCommit(stateStore: SecretsStore, dkg: DealerDkg, me: Valoper): Promise<StoredCommit> {
  const member = dkg.members.find((m) => m.validator === me);
  if (!member) throw new Error(`${me} is not a member of the DKG for epoch ${dkg.epochId}`);

  let secrets = await stateStore.load(dkg.epochId);
  const fits = secrets !== null && secrets.polyCoeffs.length === dkg.threshold && secrets.validatorIndex === member.index && secrets.ephemeralSk !== "";
  if (secrets === null || !fits) {
    secrets = {
      epochId: dkg.epochId,
      validatorIndex: member.index,
      polyCoeffs: Array.from({ length: dkg.threshold }, () => nonzeroScalar().toString(16)),
      ephemeralSk: nonzeroScalar().toString(16),
      received: {},
      secretShare: null,
    };
    await stateStore.save(secrets);
    logProgress(`DKG: secrets for epoch ${dkg.epochId} written to disk (index ${member.index})`);
  } else if (Object.keys(secrets.received).length > 0 || secrets.secretShare !== null) {
    // No share of this DKG can have reached me before my commit landed, so these came from elsewhere.
    secrets = { ...secrets, received: {}, secretShare: null };
    await stateStore.save(secrets);
  }
  return publicHalf(secrets) as StoredCommit;
}

async function committedSecrets(stateStore: SecretsStore, dkg: DealerDkg): Promise<EpochSecrets> {
  const secrets = await stateStore.load(dkg.epochId);
  if (!secrets) throw new Error(`no secrets on disk for the DKG for epoch ${dkg.epochId}`);
  return secrets;
}

/** The fields of MsgDkgEncryptedShare for one recipient: ElGamal of f(j)G, its proof, and the AEAD of f(j). */
export async function encryptShareFor(
  stateStore: SecretsStore,
  dkg: DealerDkg,
  recipientIndex: number,
): Promise<{ recipientIndex: number; u: Uint8Array; v: Uint8Array; proof: Uint8Array; scalarCt: Uint8Array }> {
  const secrets = await committedSecrets(stateStore, dkg);
  const recipient = dkg.members.find((m) => m.index === recipientIndex);
  if (!recipient?.ephemeralPubkey) throw new Error(`member ${recipientIndex} of the DKG for epoch ${dkg.epochId} has published no ephemeral key`);

  const coeffs = secrets.polyCoeffs.map(scalarOf);
  const pkR = groupElementFromBytes(recipient.ephemeralPubkey);
  const s = evalPoly(coeffs, BigInt(recipientIndex));
  // Fresh randomness on every call is fine: the chain keeps the first share per dealer and recipient.
  const r = nonzeroScalar();
  const u = mulBase(r);
  const v = pointAdd(mulBase(s), mulPoint(pkR, r));
  const proof = encodeDkgEncShareProof(
    dkgEncShareProve({ commitments: coeffs.map(mulBase), j: recipientIndex, pkR, u, v, s, r, ws: nonzeroScalar(), wr: nonzeroScalar() }),
  );
  return {
    recipientIndex,
    u: groupElementToBytes(u),
    v: groupElementToBytes(v),
    proof,
    scalarCt: encryptShareScalar({ pkR, r, s, proofBytes: proof }),
  };
}

/** The 32-byte f(j) for the member `to`, to answer that member's complaint in the clear. */
export async function plainShareFor(stateStore: SecretsStore, dkg: DealerDkg, to: Valoper): Promise<Uint8Array> {
  const secrets = await committedSecrets(stateStore, dkg);
  const recipient = dkg.members.find((m) => m.validator === to);
  if (!recipient) throw new Error(`${to} is not a member of the DKG for epoch ${dkg.epochId}`);
  return scalarToBytes(evalPoly(secrets.polyCoeffs.map(scalarOf), BigInt(recipient.index)));
}

/** A dealer's share for me as the DKG record holds it: the encrypted one if it opens, else its plaintext reveal. */
function sharesOffered(dkg: DealerDkg, dealer: Valoper, me: DealerMember, ephemeralSk: string): bigint[] {
  const offered: bigint[] = [];
  const encrypted = dkg.encryptedShares.find((e) => e.dealer === dealer && e.recipientIndex === me.index);
  if (encrypted && ephemeralSk !== "") {
    try {
      offered.push(decryptShareScalar({ skR: scalarOf(ephemeralSk), u: groupElementFromBytes(encrypted.u), proofBytes: encrypted.proof, ct: encrypted.scalarCt }));
    } catch {
      // It does not open. The dealer is asked for it again with a "missing" complaint, which cannot slash me.
    }
  }
  const revealed = dkg.reveals.find((r) => r.dealer === dealer && r.to === me.validator);
  if (revealed) {
    try {
      offered.push(scalarFromBytes(revealed.share));
    } catch {
      // Not a canonical scalar. The chain refuses such a reveal, so this is not expected.
    }
  }
  return offered;
}

/**
 * Brings the disk up to date with the DKG and says what I hold.
 *
 * For each dealer that committed, other than me, whose share is not yet on disk: its encrypted
 * share for my index if it opens, else its plaintext reveal to me. A share is stored only if
 * share * G equals that dealer's commitments evaluated at my index, which is the chain's own check.
 * A share that fails is not stored and the dealer is not in `holds`.
 *
 * Writes only when something new arrived. Safe to call every poll and after a restart.
 */
export async function syncShares(stateStore: SecretsStore, dkg: DealerDkg, me: Valoper): Promise<KeygenFacts> {
  let secrets: EpochSecrets | null;
  try {
    secrets = await stateStore.load(dkg.epochId);
  } catch (err) {
    if (err instanceof SecretsUnreadableError) return { disk: "unreadable", reason: err.reason };
    throw err;
  }
  const member = dkg.members.find((m) => m.validator === me);
  const myCommit = dkg.commits.find((c) => c.dealer === me);
  if (!myCommit) return { disk: "ok", commitMatchesDisk: null, holds: new Set() };
  if (!secrets || !member?.ephemeralPubkey || secrets.ephemeralSk === "") return { disk: "ok", commitMatchesDisk: false, holds: new Set() };

  const mine = publicHalf(secrets);
  const commitMatchesDisk =
    mine.commitments.length === myCommit.commitments.length &&
    mine.commitments.every((c, i) => sameBytes(c, myCommit.commitments[i]!)) &&
    sameBytes(mine.ephemeralPubkey, member.ephemeralPubkey);
  if (!commitMatchesDisk) return { disk: "ok", commitMatchesDisk: false, holds: new Set() };

  const received = { ...secrets.received };
  let arrived = false;
  for (const commit of dkg.commits) {
    if (commit.dealer === me || received[commit.dealer] !== undefined) continue;
    const expected = evalCommitments(commit.commitments.map(groupElementFromBytes), member.index);
    const share = sharesOffered(dkg, commit.dealer, member, secrets.ephemeralSk).find((s) => pointEq(mulBase(s), expected));
    if (share === undefined) continue;
    received[commit.dealer] = share.toString(16);
    arrived = true;
  }
  if (arrived) {
    await stateStore.save({ ...secrets, received });
    logProgress(`DKG: holding shares from ${Object.keys(received).length} of ${dkg.commits.length - 1} other dealers for epoch ${dkg.epochId}`);
  }
  return { disk: "ok", commitMatchesDisk: true, holds: new Set(Object.keys(received)) };
}

type Sum = { is: "ready"; share: bigint; dealers: number } | Extract<ShareStatus, { is: "missing" | "mismatch" }>;

/**
 * My share as the sum of f_d(my index) over the dealers the chain counted at finalize.
 *
 * The chain fixed my pub_share from the dealers that were not slashed at finalize. epoch.slashed
 * starts as that list and then grows with every hand timeout, so a member slashed today may still
 * be part of the key. Members that are not slashed certainly count. For slashed members whose share
 * I hold, the chain's pub_share decides: the subset that makes share * G equal it is the one.
 */
function sumShares(secrets: EpochSecrets, epoch: DealerEpoch, member: DealerMember): Sum {
  const others = epoch.members.filter((m) => m.validator !== member.validator).map((m) => m.validator);
  const certain = others.filter((v) => !epoch.slashed.includes(v));
  const missing = certain.filter((v) => secrets.received[v] === undefined);
  if (missing.length > 0) return { is: "missing", from: missing };
  if (!member.pubShare) return { is: "mismatch" };

  const target = groupElementFromBytes(member.pubShare);
  const base = certain.reduce(
    (sum, v) => modQ(sum + scalarOf(secrets.received[v]!)),
    evalPoly(secrets.polyCoeffs.map(scalarOf), BigInt(member.index)),
  );
  const maybe = others.filter((v) => epoch.slashed.includes(v) && secrets.received[v] !== undefined).slice(0, 16);
  for (let subset = 0; subset < 1 << maybe.length; subset++) {
    const extra = maybe.filter((_, i) => subset & (1 << i));
    const share = extra.reduce((sum, v) => modQ(sum + scalarOf(secrets.received[v]!)), base);
    if (pointEq(mulBase(share), target)) return { is: "ready", share, dealers: 1 + certain.length + extra.length };
  }
  return { is: "mismatch" };
}

/**
 * My share of a finalized epoch's key. Computed after finalize, not before, because finalize itself
 * can remove a dealer. It is saved only if share * G equals my pub_share on chain: that one check
 * shows that the disk, the decryption and the member order all agree with the chain before a hand
 * depends on them.
 *
 * `readFinalDkg` is asked only when the shares on disk do not make the sum, which means this
 * daemon was down between a share landing and finalize. It reads the DKG at a past height.
 */
export async function settleShare(
  stateStore: SecretsStore,
  epoch: DealerEpoch,
  me: Valoper,
  readFinalDkg: () => Promise<DealerDkg | null>,
): Promise<ShareStatus> {
  const member = epoch.members.find((m) => m.validator === me);
  if (!member) return { is: "not-member" };
  if (epoch.slashed.includes(me)) return { is: "slashed" };

  try {
    let secrets = await stateStore.load(epoch.epochId);
    if (secrets?.secretShare != null) return { is: "ready" };

    let sum = secrets ? sumShares(secrets, epoch, member) : null;
    if (sum?.is !== "ready") {
      const dkg = await readFinalDkg();
      if (dkg) {
        const held = Object.keys(secrets?.received ?? {}).length;
        logProgress(`DKG: epoch ${epoch.epochId} finalized while I held shares from ${held} of ${epoch.members.length - 1} dealers; read the DKG at height ${dkg.revealDeadline}`);
        await syncShares(stateStore, dkg, me);
        secrets = await stateStore.load(epoch.epochId);
        sum = secrets ? sumShares(secrets, epoch, member) : null;
      }
    }
    if (!secrets || !sum) return { is: "missing", from: epoch.members.map((m) => m.validator).filter((v) => v !== me && !epoch.slashed.includes(v)) };
    if (sum.is !== "ready") return sum;

    await stateStore.save({ ...secrets, secretShare: sum.share.toString(16) });
    logProgress(`DKG: share for epoch ${epoch.epochId} matches my on-chain pub_share (${sum.dealers} qualified dealers)`);
    return { is: "ready" };
  } catch (err) {
    if (err instanceof SecretsUnreadableError) return { is: "unreadable", reason: err.reason };
    throw err;
  }
}

export { nonzeroScalar, modQ, evalPoly };
