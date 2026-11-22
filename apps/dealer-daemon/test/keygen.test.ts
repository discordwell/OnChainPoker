// Tests of handlers/dkg.ts and state.ts with a real EpochStateStore in a temp directory and DKG
// records built with the real crypto package. No chain: the DKG record is assembled the way the
// chain assembles it, and the epoch's public shares are computed by the chain's rule (finalizeEpoch
// in x/dealer: Y_j is the sum, over the dealers not slashed, of that dealer's commitments at j).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GroupElement,
  dkgEncShareVerify,
  decodeDkgEncShareProof,
  evalCommitments,
  groupElementFromBytes,
  groupElementToBytes,
  mulBase,
  pointAdd,
  pointEq,
  scalarFromBytes,
  scalarToBytes,
} from "@onchainpoker/ocp-crypto";
import type { DealerDkg, DealerEpoch } from "@onchainpoker/ocp-sdk/cosmos";
import { encryptShareFor, plainShareFor, prepareCommit, settleShare, syncShares } from "../src/handlers/dkg.js";
import { EpochStateStore, SecretsUnreadableError, type EpochSecrets } from "../src/state.js";

const FAST_KDF = { memoryCost: 8, timeCost: 1, parallelism: 1 };
const PASSPHRASE = "a passphrase for tests only";
const EPOCH = 44;
const VALIDATORS = ["ocpvaloper1a", "ocpvaloper1b", "ocpvaloper1c"];
const [A, B, C] = VALIDATORS as [string, string, string];

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const newDir = () => mkdtempSync(join(tmpdir(), "dealer-keygen-test-"));
const storeAt = (dir: string, passphrase = PASSPHRASE) => new EpochStateStore(dir, passphrase, FAST_KDF);
const never = async (): Promise<DealerDkg | null> => assert.fail("the finalized DKG was read although the disk held every share");

type Dealer = { validator: string; index: number; dir: string; store: EpochStateStore };

function dealers(): Dealer[] {
  return VALIDATORS.map((validator, i) => {
    const dir = newDir();
    return { validator, index: i + 1, dir, store: storeAt(dir) };
  });
}

/** A DKG as BeginEpoch writes it: members, no commits. */
function begun(threshold = 2): DealerDkg {
  return {
    epochId: EPOCH,
    threshold,
    startHeight: 1000,
    commitDeadline: 1120,
    complaintDeadline: 1180,
    revealDeadline: 1240,
    members: VALIDATORS.map((validator, i) => ({ validator, index: i + 1, pubShare: null, ephemeralPubkey: null, power: 1000 })),
    commits: [],
    encryptedShares: [],
    complaints: [],
    reveals: [],
    slashed: [],
  };
}

/** What MsgDkgCommit does to the record: the commitments are stored and the member gets its ephemeral key. */
async function commit(dkg: DealerDkg, d: Dealer): Promise<DealerDkg> {
  const stored = await prepareCommit(d.store, dkg, d.validator);
  return {
    ...dkg,
    members: dkg.members.map((m) => (m.validator === d.validator ? { ...m, ephemeralPubkey: stored.ephemeralPubkey } : m)),
    commits: [...dkg.commits, { dealer: d.validator, commitments: stored.commitments }],
  };
}

/** What MsgDkgEncryptedShare does to the record, for every share `from` owes. */
async function shares(dkg: DealerDkg, from: Dealer): Promise<DealerDkg> {
  const sent = [];
  for (const to of dkg.members) {
    if (to.validator === from.validator || to.ephemeralPubkey === null) continue;
    sent.push({ dealer: from.validator, ...(await encryptShareFor(from.store, dkg, to.index)) });
  }
  return { ...dkg, encryptedShares: [...dkg.encryptedShares, ...sent] };
}

/** A DKG in which all three committed and every encrypted share is on chain. */
async function complete(): Promise<{ dkg: DealerDkg; all: Dealer[] }> {
  const all = dealers();
  let dkg = begun();
  for (const d of all) dkg = await commit(dkg, d);
  for (const d of all) dkg = await shares(dkg, d);
  return { dkg, all };
}

/** finalizeEpoch: the epoch whose public shares come from the dealers not in `slashedAtFinalize`. */
function finalized(dkg: DealerDkg, slashedAtFinalize: string[] = [], slashedSince: string[] = []): DealerEpoch {
  const qualified = dkg.commits.filter((c) => !slashedAtFinalize.includes(c.dealer));
  return {
    epochId: dkg.epochId,
    threshold: dkg.threshold,
    startHeight: dkg.startHeight,
    slashed: [...slashedAtFinalize, ...slashedSince].sort(),
    members: dkg.members.map((m) => ({
      ...m,
      pubShare: groupElementToBytes(
        qualified.reduce((sum, c) => pointAdd(sum, evalCommitments(c.commitments.map(groupElementFromBytes), m.index)), GroupElement.zero()),
      ),
    })),
  };
}

const fileOf = (d: Dealer) => join(d.dir, `epoch-${EPOCH}.json.enc`);
const onDisk = async (d: Dealer): Promise<EpochSecrets | null> => storeAt(d.dir).load(EPOCH);

describe("a DKG commit is stored before it can be sent, and is the same every time", () => {
  it("the commit prepareCommit returns is on disk when it returns", async () => {
    const [a] = dealers();
    const stored = await prepareCommit(a!.store, begun(), A);
    const saved = await onDisk(a!);
    assert.deepEqual(saved!.polyCoeffs.map((c) => hex(groupElementToBytes(mulBase(BigInt(`0x${c}`))))), stored.commitments.map(hex));
  });

  it("a second prepareCommit, in a new process, returns the same commitments and the same ephemeral key", async () => {
    const [a] = dealers();
    const first = await prepareCommit(a!.store, begun(), A);
    const again = await prepareCommit(storeAt(a!.dir), begun(), A);
    assert.deepEqual([again.commitments.map(hex), hex(again.ephemeralPubkey)], [first.commitments.map(hex), hex(first.ephemeralPubkey)]);
  });

  it("commits to as many coefficients as the DKG's threshold", async () => {
    const [a] = dealers();
    assert.equal((await prepareCommit(a!.store, begun(3), A)).commitments.length, 3);
  });

  it("replaces a leftover file made for another threshold or another member index", async () => {
    for (const leftover of [{ polyCoeffs: ["1", "2", "3"] }, { validatorIndex: 3 }]) {
      const [a] = dealers();
      await a!.store.save({ epochId: EPOCH, validatorIndex: 1, polyCoeffs: ["1", "2"], ephemeralSk: "5", received: {}, secretShare: null, ...leftover });
      const stored = await prepareCommit(storeAt(a!.dir), begun(), A);
      const saved = await onDisk(a!);
      assert.deepEqual([stored.commitments.length, saved!.polyCoeffs.length, saved!.validatorIndex], [2, 2, 1], JSON.stringify(leftover));
    }
  });

  it("keeps the polynomial of a leftover file that fits, and drops shares that cannot be this DKG's", async () => {
    const [a] = dealers();
    await a!.store.save({ epochId: EPOCH, validatorIndex: 1, polyCoeffs: ["11", "22"], ephemeralSk: "5", received: { [B]: "77" }, secretShare: "99" });
    const stored = await prepareCommit(storeAt(a!.dir), begun(), A);
    assert.deepEqual(stored.commitments.map(hex), [0x11n, 0x22n].map((c) => hex(groupElementToBytes(mulBase(c)))));
    assert.deepEqual(await onDisk(a!), { epochId: EPOCH, validatorIndex: 1, polyCoeffs: ["11", "22"], ephemeralSk: "5", received: {}, secretShare: null });
  });

  it("never replaces a secrets file it cannot read", async () => {
    const [a] = dealers();
    await prepareCommit(a!.store, begun(), A);
    const before = readFileSync(fileOf(a!));
    const wrongPassphrase = storeAt(a!.dir, "another passphrase");
    await assert.rejects(() => prepareCommit(wrongPassphrase, begun(), A), SecretsUnreadableError);
    assert.deepEqual(readFileSync(fileOf(a!)), before);
  });

  it("a save cut off after its temp file was written leaves the previous file readable", async () => {
    const [a] = dealers();
    const first = await prepareCommit(a!.store, begun(), A);
    writeFileSync(`${fileOf(a!)}.tmp`, "half a record");
    const again = await prepareCommit(storeAt(a!.dir), begun(), A);
    assert.deepEqual(again.commitments.map(hex), first.commitments.map(hex));
  });
});

describe("the shares a dealer sends are the ones the chain and the recipient accept", () => {
  it("an encrypted share passes the chain's proof check against the dealer's commitments", async () => {
    const { dkg } = await complete();
    const share = dkg.encryptedShares.find((e) => e.dealer === A && e.recipientIndex === 2)!;
    const commitments = dkg.commits.find((c) => c.dealer === A)!.commitments.map(groupElementFromBytes);
    const pkR = groupElementFromBytes(dkg.members[1]!.ephemeralPubkey!);
    assert.equal(
      dkgEncShareVerify({ commitments, j: 2, pkR, u: groupElementFromBytes(share.u), v: groupElementFromBytes(share.v), proof: decodeDkgEncShareProof(share.proof) }),
      true,
    );
  });

  it("a plaintext share is the scalar the chain checks against the dealer's commitments at the recipient's index", async () => {
    const { dkg, all } = await complete();
    const share = await plainShareFor(all[0]!.store, dkg, C);
    const expected = evalCommitments(dkg.commits.find((c) => c.dealer === A)!.commitments.map(groupElementFromBytes), 3);
    assert.ok(pointEq(mulBase(scalarFromBytes(share)), expected));
  });
});

describe("shares are stored only when they match the dealer's commitments", () => {
  it("an encrypted share that opens and matches is stored, and its dealer is held", async () => {
    const { dkg, all } = await complete();
    const facts = await syncShares(all[0]!.store, dkg, A);
    assert.deepEqual(facts, { disk: "ok", commitMatchesDisk: true, holds: new Set([B, C]) });
    assert.deepEqual(Object.keys((await onDisk(all[0]!))!.received).sort(), [B, C]);
  });

  it("an encrypted share that does not open is not stored, and its dealer is not held", async () => {
    const { dkg, all } = await complete();
    const broken = { ...dkg, encryptedShares: dkg.encryptedShares.map((e) => (e.dealer === B && e.recipientIndex === 1 ? { ...e, scalarCt: e.scalarCt.map((x) => x ^ 1) } : e)) };
    const facts = await syncShares(all[0]!.store, broken, A);
    assert.deepEqual(facts, { disk: "ok", commitMatchesDisk: true, holds: new Set([C]) });
  });

  it("a plaintext reveal addressed to me is stored when the encrypted share is not usable", async () => {
    const { dkg, all } = await complete();
    const answered = {
      ...dkg,
      encryptedShares: dkg.encryptedShares.filter((e) => !(e.dealer === B && e.recipientIndex === 1)),
      complaints: [{ complainer: A, dealer: B, kind: "missing" }],
      reveals: [{ dealer: B, to: A, share: await plainShareFor(all[1]!.store, dkg, A) }],
    };
    assert.deepEqual(await syncShares(all[0]!.store, answered, A), { disk: "ok", commitMatchesDisk: true, holds: new Set([B, C]) });
  });

  it("a share that does not match the dealer's commitments is never stored, encrypted or plain", async () => {
    const { dkg, all } = await complete();
    // C's share for A, relabelled as B's: it opens, and it is not what B committed to.
    const fromC = dkg.encryptedShares.find((e) => e.dealer === C && e.recipientIndex === 1)!;
    const forged = {
      ...dkg,
      encryptedShares: dkg.encryptedShares.map((e) => (e.dealer === B && e.recipientIndex === 1 ? { ...fromC, dealer: B } : e)),
      reveals: [{ dealer: B, to: A, share: scalarToBytes(12345n) }],
    };
    const facts = await syncShares(all[0]!.store, forged, A);
    assert.deepEqual(facts, { disk: "ok", commitMatchesDisk: true, holds: new Set([C]) });
    assert.equal((await onDisk(all[0]!))!.received[B], undefined);
  });

  it("a share addressed to another member is not taken for mine", async () => {
    const { dkg, all } = await complete();
    const onlyForC = { ...dkg, encryptedShares: dkg.encryptedShares.filter((e) => e.recipientIndex !== 1) };
    assert.deepEqual(await syncShares(all[0]!.store, onlyForC, A), { disk: "ok", commitMatchesDisk: true, holds: new Set() });
  });

  it("says whether the commit on chain is the one on disk: not yet, yes, or no", async () => {
    const all = dealers();
    const [a] = all;
    const beforeCommit = begun();
    assert.deepEqual(await syncShares(a!.store, beforeCommit, A), { disk: "ok", commitMatchesDisk: null, holds: new Set() });

    const committed = await commit(beforeCommit, a!);
    assert.equal(((await syncShares(a!.store, committed, A)) as { commitMatchesDisk: unknown }).commitMatchesDisk, true);

    // The same on-chain commit, read by a daemon whose disk holds another polynomial.
    const other = dealers()[0]!;
    await prepareCommit(other.store, beforeCommit, A);
    assert.equal(((await syncShares(other.store, committed, A)) as { commitMatchesDisk: unknown }).commitMatchesDisk, false);
    // And by a daemon with no file at all.
    assert.equal(((await syncShares(storeAt(newDir()), committed, A)) as { commitMatchesDisk: unknown }).commitMatchesDisk, false);
  });

  it("a secrets file that cannot be read is reported as unreadable, not as absent", async () => {
    const { dkg, all } = await complete();
    const facts = await syncShares(storeAt(all[0]!.dir, "another passphrase"), dkg, A);
    assert.equal(facts.disk, "unreadable");
  });
});

describe("my share is the sum over the dealers the chain counted", () => {
  it("three dealers, none slashed: the sum times G is my on-chain pub_share, and the share is saved", async () => {
    const { dkg, all } = await complete();
    const [a] = all;
    await syncShares(a!.store, dkg, A);
    const epoch = finalized(dkg);

    assert.deepEqual(await settleShare(a!.store, epoch, A, never), { is: "ready" });
    const share = BigInt(`0x${(await onDisk(a!))!.secretShare}`);
    assert.equal(hex(groupElementToBytes(mulBase(share))), hex(epoch.members[0]!.pubShare!));
    // Settled once: a later poll in a new process reads the saved share and asks for nothing.
    assert.deepEqual(await settleShare(storeAt(a!.dir), epoch, A, never), { is: "ready" });
  });

  it("a dealer the chain slashed at finalize is left out of the sum, though its share is on disk", async () => {
    const { dkg, all } = await complete();
    const [a] = all;
    await syncShares(a!.store, dkg, A);
    const epoch = finalized(dkg, [C]);

    assert.deepEqual(await settleShare(a!.store, epoch, A, never), { is: "ready" });
    const share = BigInt(`0x${(await onDisk(a!))!.secretShare}`);
    assert.equal(hex(groupElementToBytes(mulBase(share))), hex(epoch.members[0]!.pubShare!));
  });

  it("a dealer slashed in a hand after finalize still counts", async () => {
    const { dkg, all } = await complete();
    const [a] = all;
    await syncShares(a!.store, dkg, A);
    // The chain summed all three polynomials. C was slashed for a hand timeout afterwards.
    const epoch = finalized(dkg, [], [C]);

    assert.deepEqual(await settleShare(a!.store, epoch, A, never), { is: "ready" });
    const share = BigInt(`0x${(await onDisk(a!))!.secretShare}`);
    assert.equal(hex(groupElementToBytes(mulBase(share))), hex(epoch.members[0]!.pubShare!));
  });

  it("a counted dealer's share that is not on disk is taken from the finalized DKG", async () => {
    const { dkg, all } = await complete();
    const [a] = all;
    // This daemon saw the DKG before C's share for it landed, and was down at finalize.
    await syncShares(a!.store, { ...dkg, encryptedShares: dkg.encryptedShares.filter((e) => e.dealer !== C) }, A);
    let reads = 0;
    const status = await settleShare(a!.store, finalized(dkg), A, async () => (reads++, dkg));
    assert.deepEqual([status, reads], [{ is: "ready" }, 1]);
  });

  it("when the finalized DKG cannot be read, the share is missing and the dealer is named", async () => {
    const { dkg, all } = await complete();
    const [a] = all;
    await syncShares(a!.store, { ...dkg, encryptedShares: dkg.encryptedShares.filter((e) => e.dealer !== C) }, A);
    assert.deepEqual(await settleShare(a!.store, finalized(dkg), A, async () => null), { is: "missing", from: [C] });
    assert.equal((await onDisk(a!))!.secretShare, null);
  });

  it("a sum that does not match pub_share is a mismatch, and nothing is saved", async () => {
    const { dkg, all } = await complete();
    const [a] = all;
    await syncShares(a!.store, dkg, A);
    const epoch = finalized(dkg);
    const wrong = { ...epoch, members: epoch.members.map((m) => (m.validator === A ? { ...m, pubShare: groupElementToBytes(mulBase(7n)) } : m)) };
    assert.deepEqual(await settleShare(a!.store, wrong, A, async () => null), { is: "mismatch" });
    assert.equal((await onDisk(a!))!.secretShare, null);
  });

  it("a file written by the previous daemon, with the placeholder share '0' and no received shares, is not ready", async () => {
    const dir = newDir();
    writeFileSync(join(dir, `epoch-${EPOCH}.json.enc`), JSON.stringify({ epochId: EPOCH, validatorIndex: 1, polyCoeffs: ["1", "2"], secretShare: "0", ephemeralSk: "5" }));
    process.env.DEALER_STATE_ALLOW_UNENCRYPTED = "1";
    try {
      const unencrypted = new EpochStateStore(dir, "");
      assert.deepEqual(await unencrypted.load(EPOCH), { epochId: EPOCH, validatorIndex: 1, polyCoeffs: ["1", "2"], ephemeralSk: "5", received: {}, secretShare: null });
    } finally {
      delete process.env.DEALER_STATE_ALLOW_UNENCRYPTED;
    }
  });

  it("a validator outside the epoch, or slashed in it, has no share to settle", async () => {
    const { dkg, all } = await complete();
    const epoch = finalized(dkg, [C]);
    assert.deepEqual(await settleShare(all[2]!.store, epoch, C, never), { is: "slashed" });
    assert.deepEqual(await settleShare(all[0]!.store, epoch, "ocpvaloper1stranger", never), { is: "not-member" });
  });

  it("a secrets file that cannot be read is reported as unreadable, not as a missing share", async () => {
    const { dkg, all } = await complete();
    const status = await settleShare(storeAt(all[0]!.dir, "another passphrase"), finalized(dkg), A, async () => null);
    assert.equal(status.is, "unreadable");
  });
});

describe("the secrets directory does not grow, and says when it cannot be used", () => {
  const record = (epochId: number): EpochSecrets => ({ epochId, validatorIndex: 1, polyCoeffs: ["1", "2"], ephemeralSk: "5", received: {}, secretShare: null });

  it("prune keeps the current epoch and the DKG in flight, and deletes every other epoch below the next id", async () => {
    const dir = newDir();
    const store = storeAt(dir);
    for (const id of [40, 41, 42, 43, 44, 45]) await store.save(record(id));
    writeFileSync(join(dir, "epoch-41.json.enc.tmp"), "left by a crash");

    // Epoch 42 is current, a DKG for 44 is in flight, the next id is 45. 43 was an aborted DKG.
    const removed = store.prune([42, 44], 45);

    assert.deepEqual(removed.sort(), [40, 41, 43]);
    assert.deepEqual(readdirSync(dir).sort(), ["epoch-42.json.enc", "epoch-44.json.enc", "epoch-45.json.enc"]);
    assert.equal(await store.load(43), null);
  });

  it("probe passes on a directory that takes a write and gives it back, and leaves nothing behind", async () => {
    const dir = newDir();
    assert.deepEqual(await storeAt(dir).probe(), { ok: true });
    assert.deepEqual(readdirSync(dir), []);
  });

  it("probe reports a directory that cannot be written, without throwing", { skip: process.getuid?.() === 0 }, async () => {
    const dir = newDir();
    const store = storeAt(dir);
    chmodSync(dir, 0o500);
    try {
      const result = await store.probe();
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.reason, /EACCES|EPERM/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("load answers null only when there is no file", async () => {
    const dir = newDir();
    const store = storeAt(dir);
    assert.equal(await store.load(EPOCH), null);
    writeFileSync(join(dir, `epoch-${EPOCH}.json.enc`), "not a secrets file");
    await assert.rejects(() => store.load(EPOCH), SecretsUnreadableError);
    assert.equal(existsSync(join(dir, `epoch-${EPOCH}.json.enc`)), true);
  });
});
