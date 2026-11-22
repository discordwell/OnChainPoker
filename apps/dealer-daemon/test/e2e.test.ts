// Three real DealerDaemons rotate a dead epoch against fakeChain.ts: the model's rules, plus the
// chain's checks on the bytes. Everything between the poll and the bytes of each message is the
// code that runs in production. What stands in for the chain is the fake, so this shows that the
// daemons agree with each other and with the rules as written here, not with a running chain.

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { CURVE_ORDER, groupElementToBytes, mulBase } from "@onchainpoker/ocp-crypto";
import { OCP_TYPE_URLS } from "@onchainpoker/ocp-sdk/cosmos";
import { FakeChain } from "./fakeChain.js";
import { daemonAgainst, pollOnce, type Harness } from "./fakeNode.js";

const MSG = OCP_TYPE_URLS.dealer;
const A = "ocpvaloper1a";
const B = "ocpvaloper1b";
const C = "ocpvaloper1c";
const VALIDATORS = [A, B, C];
// The live chain on 2026-11-22: epoch 42 dead, next epoch id 44.
const START = { height: 1_536_600, deadEpochId: 42, nextEpochId: 44 };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type Fleet = { chain: FakeChain; daemons: Map<string, Harness | null> };

function fleet(): Fleet {
  const chain = new FakeChain(VALIDATORS, START);
  return { chain, daemons: new Map(VALIDATORS.map((v) => [v, daemonAgainst(chain.node, v)])) };
}

/** A new process for `validator` on the state directory of the old one. */
function restart(f: Fleet, validator: string, stateDir: string): void {
  f.daemons.set(validator, daemonAgainst(f.chain.node, validator, { stateDir }));
}

/**
 * Polls each running daemon, in order, at every height where something can happen, until `done`.
 * `between` runs after each round of polls: a test stops or restarts daemons there.
 */
async function runUntil(f: Fleet, done: () => boolean, between: () => void = () => {}): Promise<void> {
  const limit = f.chain.model.height + 2000;
  while (!done()) {
    assert.ok(f.chain.model.height < limit, `not done after 2000 blocks: ${JSON.stringify(f.chain.model.finalized)}`);
    const accepted = f.chain.accepted.length;
    for (const harness of f.daemons.values()) if (harness) await pollOnce(harness.daemon);
    between();
    if (f.chain.accepted.length === accepted) f.chain.advanceTo(f.chain.nextEventHeight());
  }
}

const dealing = (f: Fleet) => () => f.chain.model.epoch?.epochId === 44 && f.chain.model.dkg === null;

/** Runs to the block that finalizes epoch 44, then lets every running daemon see it once. */
async function rotate(f: Fleet, between?: () => void): Promise<void> {
  await runUntil(f, dealing(f), between);
  for (const harness of f.daemons.values()) if (harness) await pollOnce(harness.daemon);
}
const acceptedOf = (f: Fleet, typeUrl: string) => f.chain.accepted.filter((m) => m.typeUrl === typeUrl);

/** The share each daemon saved for epoch 44, read from its state directory by a new store. */
async function savedShare(f: Fleet, validator: string): Promise<bigint> {
  const harness = f.daemons.get(validator)!;
  const fresh = daemonAgainst(f.chain.node, validator, { stateDir: harness.stateDir });
  const secrets = await fresh.store.load(44);
  assert.ok(secrets?.secretShare, `${validator} saved no share for epoch 44`);
  return BigInt(`0x${secrets.secretShare}`);
}

function inverse(a: bigint): bigint {
  let result = 1n;
  let base = ((a % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;
  for (let e = CURVE_ORDER - 2n; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * base) % CURVE_ORDER;
    base = (base * base) % CURVE_ORDER;
  }
  return result;
}

/** The secret two shares of a threshold-2 key determine: Lagrange interpolation at zero. */
function keyFrom(i: bigint, si: bigint, j: bigint, sj: bigint): bigint {
  const mod = (n: bigint) => ((n % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;
  return mod(si * j * inverse(j - i) + sj * i * inverse(i - j));
}

async function assertEveryShareMatches(f: Fleet, validators: string[] = VALIDATORS): Promise<void> {
  const epoch = f.chain.node.epoch!;
  const shares = new Map<string, bigint>();
  for (const v of validators) {
    const share = await savedShare(f, v);
    shares.set(v, share);
    const onChain = epoch.members.find((m) => m.validator === v)!.pubShare;
    assert.equal(hex(groupElementToBytes(mulBase(share))), hex(onChain), `${v}'s share is not its on-chain pub_share`);
  }
  // Any two shares give the key whose public half the chain published.
  const [x, y] = validators as [string, string];
  const index = (v: string) => BigInt(epoch.members.find((m) => m.validator === v)!.index);
  const key = keyFrom(index(x), shares.get(x)!, index(y), shares.get(y)!);
  assert.equal(hex(groupElementToBytes(mulBase(key))), hex(epoch.pkEpoch), "two shares do not give the epoch's key");
}

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  const capture = (...args: unknown[]) => void lines.push(args.join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "error", capture);
});
afterEach(() => mock.restoreAll());

describe("three daemons rotate a dead epoch, end to end", () => {
  it("roll call, BeginEpoch, DKG and finalize with no command and no slash, and every share matches the key on chain", async () => {
    const f = fleet();
    await rotate(f);

    const { model } = f.chain;
    assert.deepEqual([model.epoch!.members, model.epoch!.slashed, model.slashes], [VALIDATORS, [], []]);
    const begins = acceptedOf(f, MSG.beginEpoch).map((m) => m.value);
    assert.deepEqual(
      begins.map((b) => [b.epochId, b.committeeSize, b.threshold, b.commitBlocks, b.complaintBlocks, b.revealBlocks, b.finalizeBlocks]),
      [["44", 3, 2, "120", "60", "60", "60"]],
    );
    // A healthy DKG: three commits, six encrypted shares, no complaint, no plaintext share.
    const counts = [MSG.dkgCommit, MSG.dkgEncryptedShare, MSG.dkgComplaintMissing, MSG.dkgShareReveal, MSG.finalizeEpoch].map((t) => acceptedOf(f, t).length);
    assert.deepEqual(counts, [3, 6, 0, 0, 1]);
    // Nothing that only slashes was ever sent, accepted or not.
    const never = [MSG.dkgTimeout, MSG.dkgComplaintAEADBad, MSG.dkgComplaintInvalid, MSG.openBeaconWindow];
    assert.deepEqual(f.chain.node.sent.filter((m) => never.includes(m.typeUrl)), []);
    // The node simulates each message at the height it is sent at. None was sent a block early.
    assert.deepEqual(f.chain.node.sent.filter((m) => !f.chain.accepted.includes(m)).map((m) => m.typeUrl), []);

    await assertEveryShareMatches(f);
    assert.equal(lines.filter((l) => /share for epoch 44 matches my on-chain pub_share \(3 qualified dealers\)/.test(l)).length, 3);
    assert.doesNotMatch(lines.join("\n"), /\bepoch 43\b/);
    console.info(`rotation took ${model.height - START.height} blocks`);
  });

  it("a daemon restarted after its beacon commit reveals the same salt, and one restarted after its DKG commit keeps its commit", async () => {
    const f = fleet();
    const restarted = new Set<string>();
    await rotate(f, () => {
      const { beacon, dkg } = f.chain.model;
      if (!restarted.has("beacon") && beacon?.committed.includes(A) && !beacon.revealed.includes(A)) {
        restarted.add("beacon");
        restart(f, A, f.daemons.get(A)!.stateDir);
      }
      if (!restarted.has("dkg") && dkg?.committed.includes(B)) {
        restarted.add("dkg");
        restart(f, B, f.daemons.get(B)!.stateDir);
      }
    });

    assert.deepEqual([...restarted].sort(), ["beacon", "dkg"]);
    assert.deepEqual([f.chain.model.slashes, f.chain.model.epoch!.slashed], [[], []]);
    assert.equal(acceptedOf(f, MSG.beaconReveal).filter((m) => m.value.validator === A).length, 1);
    assert.equal(acceptedOf(f, MSG.dkgCommit).filter((m) => m.value.dealer === B).length, 1);
    await assertEveryShareMatches(f);
  });

  it("one encrypted share never arrives: one complaint, one plaintext share, no slash", async () => {
    const f = fleet();
    // C's encrypted share for A is refused every time C sends it.
    f.chain.refuse = (m) => (m.typeUrl === MSG.dkgEncryptedShare && m.value.dealer === C && m.value.recipientIndex === 1 ? "refused by the test" : null);
    await rotate(f);

    const complaints = acceptedOf(f, MSG.dkgComplaintMissing).map((m) => [m.value.complainer, m.value.dealer]);
    const reveals = acceptedOf(f, MSG.dkgShareReveal).map((m) => [m.value.dealer, m.value.to]);
    assert.deepEqual([complaints, reveals], [[[A, C]], [[C, A]]]);
    assert.equal(acceptedOf(f, MSG.dkgEncryptedShare).length, 5);
    assert.deepEqual([f.chain.model.slashes, f.chain.model.epoch!.slashed], [[], []]);
    await assertEveryShareMatches(f);
  });

  it("a daemon that was down from before its shares landed until after finalize takes them from the DKG at its reveal deadline", async () => {
    const f = fleet();
    let stopped: Harness | null = null;
    // The shares for C land only after C has stopped. C stops once both shares it owes are on chain.
    f.chain.refuse = (m) => (m.typeUrl === MSG.dkgEncryptedShare && m.value.recipientIndex === 3 && !stopped ? "not yet, says the test" : null);
    await rotate(f, () => {
      if (!stopped && acceptedOf(f, MSG.dkgEncryptedShare).filter((m) => m.value.dealer === C).length === 2) {
        stopped = f.daemons.get(C)!;
        f.daemons.set(C, null);
      }
    });
    assert.ok(stopped, "C never sent both of its shares");
    assert.deepEqual([acceptedOf(f, MSG.dkgComplaintMissing), f.chain.model.epoch!.slashed], [[], []]);

    restart(f, C, (stopped as Harness).stateDir);
    await pollOnce(f.daemons.get(C)!.daemon);

    assert.match(lines.join("\n"), /DKG: epoch 44 finalized while I held shares from 0 of 2 dealers; read the DKG at height \d+/);
    assert.deepEqual(f.chain.model.slashes, []);
    await assertEveryShareMatches(f);
  });

  it("with one daemon stopped the others commit to the roll call, never reveal, and nothing begins", async () => {
    const f = fleet();
    f.daemons.set(C, null);
    const until = START.height + 4 * 101 + 10;
    await runUntil(f, () => f.chain.model.height >= until);

    assert.deepEqual([f.chain.model.begun, f.chain.model.slashes, acceptedOf(f, MSG.beaconReveal)], [[], [], []]);
    assert.ok(acceptedOf(f, MSG.beaconCommit).length >= 6, "A and B answered fewer than three roll calls");
    assert.match(lines.join("\n"), /roll call for epoch 44 incomplete: no commit from ocpvaloper1c/);
  });
});
