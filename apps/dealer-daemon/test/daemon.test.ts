// What the poll shell adds around decide(): its memory between polls, the secrets directory, and
// --explain. Driven through DealerDaemon against the fake node.

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { OCP_TYPE_URLS } from "@onchainpoker/ocp-sdk/cosmos";
import {
  BeaconState,
  DealerDKG,
  DealerEpoch,
} from "../../../packages/ocp-sdk/dist/cosmos/gen/onchainpoker/dealer/v1/dealer.js";
import { FakeNode, daemonAgainst, pollOnce, type FakeValidator } from "./fakeNode.js";

const MSG = OCP_TYPE_URLS.dealer;
const A = "ocpvaloper1a";
const B = "ocpvaloper1b";
const C = "ocpvaloper1c";
const ALL = [A, B, C];
const bytes = (fill: number) => new Uint8Array(32).fill(fill);

const bonded = (): FakeValidator[] =>
  ALL.map((operator, i) => ({ operator, status: "BOND_STATUS_BONDED", jailed: false, tokens: "1000000000", consensusKey: bytes(i + 1) }));

const member = (validator: string, i: number) => ({ validator, index: i + 1, pubShare: bytes(10 + i), consPubkey: bytes(i + 1), power: "1000", ephemeralPubkey: bytes(20 + i) });

/** Epoch 7 with every member slashed, next id 8, and a beacon window 900..950..1000 for epoch 8. */
function deadEpoch(height: number, beacon: { commits?: string[]; reveals?: string[] } = {}): FakeNode {
  const node = new FakeNode();
  node.height = height;
  node.nextEpochId = 8;
  node.epoch = DealerEpoch.fromPartial({ epochId: "7", threshold: 2, startHeight: "100", slashed: ALL, members: ALL.map(member) });
  node.beacon = BeaconState.fromPartial({
    epochId: "8",
    commitOpenHeight: "900",
    commitCloseHeight: "950",
    revealCloseHeight: "1000",
    threshold: 2,
    commits: (beacon.commits ?? []).map((validator) => ({ validator, commit: bytes(1) })),
    reveals: (beacon.reveals ?? []).map((validator) => ({ validator, salt: bytes(2) })),
  });
  node.validators = bonded();
  return node;
}

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  const capture = (...args: unknown[]) => void lines.push(args.join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "error", capture);
});
afterEach(() => mock.restoreAll());

describe("patience is counted by the process that waits", () => {
  it("reveals without an absent validator only after watching the chain unable to deal for the configured blocks, and says who it costs first", async () => {
    // A and B committed, C did not. The reveal window is open from 951 to 1000.
    const node = deadEpoch(960, { commits: [A, B] });
    const { daemon } = daemonAgainst(node, A, { patienceBlocks: 5 });

    await pollOnce(daemon);
    node.height = 964;
    await pollOnce(daemon);
    assert.deepEqual(node.sentOf(MSG.beaconReveal), []);

    node.height = 965;
    await pollOnce(daemon);
    assert.equal(node.sentOf(MSG.beaconReveal).length, 1);
    const announced = lines.findIndex((l) => /patience ended after 5 blocks; revealing without ocpvaloper1c/.test(l));
    const landed = lines.findIndex((l) => /beacon reveal for epoch 8 landed/.test(l));
    assert.ok(announced >= 0 && announced < landed, lines.join("\n"));
  });

  it("a restarted daemon starts its count again", async () => {
    const node = deadEpoch(960, { commits: [A, B] });
    await pollOnce(daemonAgainst(node, A, { patienceBlocks: 5 }).daemon);
    node.height = 970;
    await pollOnce(daemonAgainst(node, A, { patienceBlocks: 5 }).daemon);
    assert.deepEqual(node.sentOf(MSG.beaconReveal), []);
  });
});

describe("one rotation transaction per poll", () => {
  it("sends the two encrypted shares it owes in two polls, one each", async () => {
    const node = new FakeNode();
    node.height = 1010;
    node.nextEpochId = 9;
    node.validators = bonded();
    const dkg = DealerDKG.fromPartial({
      epochId: "8",
      threshold: 2,
      members: ALL.map((v, i) => ({ ...member(v, i), pubShare: new Uint8Array(), ephemeralPubkey: new Uint8Array() })),
      startHeight: "1000",
      commitDeadline: "1120",
      complaintDeadline: "1180",
      revealDeadline: "1240",
    });
    node.dkg = dkg;
    const { daemon } = daemonAgainst(node, A);

    // The commit lands: the chain stores it and A's ephemeral key. B and C have committed too.
    await pollOnce(daemon);
    const commit = node.sentOf(MSG.dkgCommit)[0]!.value;
    const point = commit.ephemeralPubkey;
    node.dkg = { ...dkg, members: dkg.members.map((m) => ({ ...m, ephemeralPubkey: point })), commits: ALL.map((dealer) => ({ dealer, commitments: commit.commitments })) };

    await pollOnce(daemon);
    assert.deepEqual(node.sentOf(MSG.dkgEncryptedShare).map((m) => m.value.recipientIndex), [2]);
    node.dkg = { ...node.dkg, encryptedShares: [{ dealer: A, recipientIndex: 2, u: bytes(1), v: bytes(2), proof: new Uint8Array(160), scalarCt: new Uint8Array(48) }] };

    await pollOnce(daemon);
    assert.deepEqual(node.sentOf(MSG.dkgEncryptedShare).map((m) => m.value.recipientIndex), [2, 3]);
  });
});

describe("the secrets directory", () => {
  it("after a poll holds only the current epoch's file: older epochs and an aborted DKG's are removed", async () => {
    const node = deadEpoch(905);
    node.nextEpochId = 10; // DKGs for 8 and 9 were begun and aborted
    node.beacon = null;
    const { daemon, store, stateDir } = daemonAgainst(node, A);
    for (const epochId of [5, 6, 7, 8, 9]) {
      await store.save({ epochId, validatorIndex: 1, polyCoeffs: ["1", "2"], ephemeralSk: "3", received: {}, secretShare: null });
    }

    await pollOnce(daemon);

    assert.deepEqual(readdirSync(stateDir), ["epoch-7.json.enc"]);
  });
});

describe("--explain", () => {
  it("prints what it sees and what it would send, sends nothing, and leaves the secrets directory as it was", async () => {
    const node = deadEpoch(945);
    const { daemon, stateDir } = daemonAgainst(node, A);

    await daemon.explain();

    assert.deepEqual(node.sent, []);
    assert.deepEqual(readdirSync(stateDir), []);
    const text = lines.join("\n");
    for (const expected of [
      /height 945, next epoch 8/,
      /epoch 7 cannot deal \(0 of 3 members qualified, need 2\)/,
      /beacon window for epoch 8: commit 900 to 950, reveal to 1000, threshold 2/,
      /3 bonded with power: .*; mine is bonded/,
      /writable, passphrase opens it/,
      /would send: beacon commit for epoch 8/,
      /nothing was sent/,
    ]) {
      assert.match(text, expected);
    }
  });

  it("does not write the secrets a real poll would write for a DKG", async () => {
    const node = new FakeNode();
    node.height = 1010;
    node.nextEpochId = 9;
    node.validators = bonded();
    node.dkg = DealerDKG.fromPartial({
      epochId: "8",
      threshold: 2,
      members: ALL.map((v, i) => ({ ...member(v, i), pubShare: new Uint8Array(), ephemeralPubkey: new Uint8Array() })),
      startHeight: "1000",
      commitDeadline: "1120",
      complaintDeadline: "1180",
      revealDeadline: "1240",
    });
    const { daemon, stateDir } = daemonAgainst(node, B);

    await daemon.explain();

    assert.deepEqual([node.sent, readdirSync(stateDir)], [[], []]);
    assert.match(lines.join("\n"), /would send: dkg commit for epoch 8/);
  });
});
