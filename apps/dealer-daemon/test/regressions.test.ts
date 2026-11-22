// One test per fault that stopped the table on 2026-05-19 and kept it stopped. Each drives
// DealerDaemon's poll against a fake node (fakeNode.ts), so it runs on the code it indicts too.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { groupElementToBytes, mulBase } from "@onchainpoker/ocp-crypto";
import { OCP_TYPE_URLS } from "@onchainpoker/ocp-sdk/cosmos";
import {
  BeaconState,
  DealerDKG,
  DealerEpoch,
} from "../../../packages/ocp-sdk/dist/cosmos/gen/onchainpoker/dealer/v1/dealer.js";
import { FakeNode, daemonAgainst, pollOnce, type FakeValidator, type Sent } from "./fakeNode.js";

const MSG = OCP_TYPE_URLS.dealer;

// Three validators in the chain's order (ascending by operator address).
const A = "ocpvaloper1g42m";
const B = "ocpvaloper1hffw";
const C = "ocpvaloper1la3r";

const point = (k: number): Uint8Array => groupElementToBytes(mulBase(BigInt(k)));
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const typesOf = (sent: Sent[]): string[] => sent.map((m) => m.typeUrl.split(".").pop()!);

function bonded(operator: string, power: number, seed: number): FakeValidator {
  return {
    operator,
    status: "BOND_STATUS_BONDED",
    jailed: false,
    tokens: String(power * 1_000_000),
    consensusKey: new Uint8Array(32).fill(seed),
  };
}

const threeBonded = (): FakeValidator[] => [bonded(A, 8100, 1), bonded(B, 2952, 2), bonded(C, 4050, 3)];

function member(validator: string, index: number) {
  return {
    validator,
    index,
    pubShare: point(100 + index),
    consPubkey: new Uint8Array(32).fill(index),
    power: "1000",
    ephemeralPubkey: point(200 + index),
  };
}

function epochOf(epochId: number, slashed: string[]): DealerEpoch {
  return DealerEpoch.fromPartial({
    epochId: String(epochId),
    threshold: 2,
    pkEpoch: point(7),
    transcriptRoot: new Uint8Array(32),
    startHeight: "100",
    slashed,
    members: [member(A, 1), member(B, 2), member(C, 3)],
  });
}

const SHARE_OF_B = 0xabcdefn;

const deckOf = (cards: number) =>
  Array.from({ length: cards }, (_, i) => ({ c1: base64(point(1000 + i)), c2: base64(point(2000 + i)) }));

describe("the faults that stopped dealing on 2026-05-19", () => {
  it("commits to the beacon for the chain's pending epoch id, not for the current epoch plus one", async () => {
    // The live chain as measured on 2026-11-22: epoch 42 with every member slashed, an aborted
    // DKG for 43 behind it, so the pending id is 44, and a beacon window for 44 near its commit close.
    const node = new FakeNode();
    node.height = 1_536_510;
    node.nextEpochId = 44;
    node.epoch = epochOf(42, [A, B, C]);
    node.beacon = BeaconState.fromPartial({
      epochId: "44",
      commitOpenHeight: "1536468",
      commitCloseHeight: "1536518",
      revealCloseHeight: "1536568",
      threshold: 2,
    });
    node.validators = threeBonded();
    const { daemon } = daemonAgainst(node, C);

    await pollOnce(daemon);

    const commits = node.sentOf(MSG.beaconCommit);
    assert.equal(commits.length, 1, `expected one MsgBeaconCommit among ${JSON.stringify(typesOf(node.sent))}`);
    assert.equal(commits[0]!.value.epochId, "44", `epoch_id ${commits[0]!.value.epochId}, expected 44`);
  });

  it("replaces an epoch that has fewer qualified members than its threshold", async () => {
    const node = new FakeNode();
    node.height = 1004;
    node.nextEpochId = 8;
    node.epoch = epochOf(7, [A, B, C]);
    node.beacon = BeaconState.fromPartial({
      epochId: "8",
      commitOpenHeight: "900",
      commitCloseHeight: "950",
      revealCloseHeight: "1000",
      threshold: 2,
      commits: [A, B, C].map((validator, i) => ({ validator, commit: new Uint8Array(32).fill(i + 1) })),
      reveals: [A, B, C].map((validator, i) => ({ validator, salt: new Uint8Array(32).fill(i + 1) })),
    });
    node.validators = threeBonded();
    const { daemon } = daemonAgainst(node, A);

    await pollOnce(daemon);

    const begins = node.sentOf(MSG.beginEpoch);
    assert.equal(begins.length, 1, `expected MsgBeginEpoch among ${JSON.stringify(typesOf(node.sent))}`);
    const { epochId, committeeSize, threshold, commitBlocks, complaintBlocks, revealBlocks, finalizeBlocks } = begins[0]!.value;
    assert.deepEqual(
      { epochId, committeeSize, threshold, commitBlocks, complaintBlocks, revealBlocks, finalizeBlocks },
      { epochId: "8", committeeSize: 3, threshold: 2, commitBlocks: "120", complaintBlocks: "60", revealBlocks: "60", finalizeBlocks: "60" }
    );
  });

  it("stores a DKG commit before sending it, and sends the same commit again when its confirmation is lost", async () => {
    const node = new FakeNode();
    node.height = 1010;
    node.nextEpochId = 9;
    node.epoch = epochOf(7, [A, B, C]);
    node.dkg = DealerDKG.fromPartial({
      epochId: "8",
      threshold: 2,
      members: [A, B, C].map((validator, i) => ({ ...member(validator, i + 1), pubShare: new Uint8Array(), ephemeralPubkey: new Uint8Array() })),
      startHeight: "1000",
      commitDeadline: "1120",
      complaintDeadline: "1180",
      revealDeadline: "1240",
      finalizeDeadline: "1300",
      randEpoch: new Uint8Array(32).fill(9),
    });
    node.validators = threeBonded();
    // The first commit reaches the signer and its confirmation never comes back; the chain holds no commit.
    node.answer = (msg, nth) => (msg.typeUrl === MSG.dkgCommit && nth === 0 ? "lose" : "land");
    const { daemon, stateDir } = daemonAgainst(node, B);

    await pollOnce(daemon);
    const secretsOnDiskAfterFirstSend = existsSync(join(stateDir, "epoch-8.json.enc"));
    await pollOnce(daemon);

    const commits = node.sentOf(MSG.dkgCommit);
    assert.equal(commits.length, 2, `expected two MsgDkgCommit among ${JSON.stringify(typesOf(node.sent))}`);
    const bytesOf = (m: Sent) => [...m.value.commitments.map(hex), hex(m.value.ephemeralPubkey)];
    assert.deepEqual(
      { secretsOnDiskAfterFirstSend, sameCommitmentsResent: bytesOf(commits[0]!).join() === bytesOf(commits[1]!).join() },
      { secretsOnDiskAfterFirstSend: true, sameCommitmentsResent: true }
    );
  });

  it("shuffles at step 0 as the second member when the first member is slashed", async () => {
    const node = new FakeNode();
    node.nextEpochId = 10;
    node.epoch = epochOf(9, [A]);
    node.validators = threeBonded();
    node.tables.set("1", {
      id: "1",
      seats: [],
      hand: { hand_id: "5", phase: "HAND_PHASE_SHUFFLE", dealer: { epoch_id: "9", deck_finalized: false } },
    });
    node.dealerHands.set("1/5", { epoch_id: "9", pk_hand: base64(point(77)), deck: deckOf(4), shuffle_step: 0, finalized: false });
    node.answer = (msg) => {
      if (msg.typeUrl === MSG.finalizeDeck) return { refuse: "deck must be shuffled by all qualified members before finalization: have 0 need 2" };
      if (msg.typeUrl === MSG.timeout) return { refuse: "dealer timeout not reached" };
      return "land";
    };
    const { daemon } = daemonAgainst(node, B);

    await pollOnce(daemon);

    const shuffles = node.sentOf(MSG.submitShuffle);
    assert.equal(shuffles.length, 1, `expected MsgSubmitShuffle among ${JSON.stringify(typesOf(node.sent))}`);
    assert.deepEqual({ shuffler: shuffles[0]!.value.shuffler, round: shuffles[0]!.value.round }, { shuffler: B, round: 1 });
  });

  it("sends every hole-card share when the first one fails", async () => {
    const node = new FakeNode();
    node.nextEpochId = 10;
    node.epoch = epochOf(9, []);
    node.epoch.members[1]!.pubShare = groupElementToBytes(mulBase(SHARE_OF_B));
    node.validators = threeBonded();
    const holePos = Array.from({ length: 18 }, (_, i) => (i < 6 ? i : 255));
    node.tables.set("1", {
      id: "1",
      seats: [0, 1, 2].map((seat) => ({ player: `ocp1player${seat}`, pk_player: base64(point(300 + seat)) })),
      hand: { hand_id: "6", phase: "HAND_PHASE_SHUFFLE", dealer: { epoch_id: "9", deck_finalized: true, hole_pos: holePos } },
    });
    node.dealerHands.set("1/6", {
      epoch_id: "9",
      pk_hand: base64(point(77)),
      deck: deckOf(8),
      shuffle_step: 3,
      finalized: true,
      init_height: "990",
      init_hash_salt: base64(new Uint8Array(32).fill(5)),
    });
    // The first share fails the way a transaction with no confirmation does; the chain takes the rest.
    node.answer = (msg, nth) => {
      if (msg.typeUrl === MSG.submitEncShare) return nth === 0 ? "lose" : "land";
      if (msg.typeUrl === MSG.timeout) return { refuse: "dealer timeout not reached" };
      return "land";
    };
    const { daemon, store } = daemonAgainst(node, B);
    await store.save({ epochId: 9, validatorIndex: 2, polyCoeffs: ["1", "2"], ephemeralSk: "3", received: {}, secretShare: SHARE_OF_B.toString(16) });

    await pollOnce(daemon);

    const positions = node.sentOf(MSG.submitEncShare).map((m) => m.value.pos);
    assert.equal(positions.length, 6, `expected 6 hole-share sends, got ${positions.length}`);
    assert.deepEqual([...positions].sort(), [0, 1, 2, 3, 4, 5]);
  });
});
