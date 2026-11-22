// How a daemon deals a hand at one block: which members send, and what goes in each transaction.
// Each test drives DealerDaemon's poll against a fake node (fakeNode.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupElementToBytes, mulBase } from "@onchainpoker/ocp-crypto";
import { OCP_TYPE_URLS } from "@onchainpoker/ocp-sdk/cosmos";
import { DealerEpoch } from "../../../packages/ocp-sdk/dist/cosmos/gen/onchainpoker/dealer/v1/dealer.js";
import { FakeNode, daemonAgainst, pollOnce, type FakeValidator, type Sent } from "./fakeNode.js";

const MSG = OCP_TYPE_URLS.dealer;
const POKER = OCP_TYPE_URLS.poker;

// The chain's order (ascending by operator address).
const A = "ocpvaloper1g42m";
const B = "ocpvaloper1hffw";
const C = "ocpvaloper1la3r";
const SECRET = 0xabcdefn;

const point = (k: number): Uint8Array => groupElementToBytes(mulBase(BigInt(k)));
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const typesOf = (msgs: readonly Sent[]): string[] => msgs.map((m) => m.typeUrl.split(".").pop()!);
/** The latest block's time on every fake node here, in Unix seconds. */
const NOW = 1_800_000_000;

function bonded(operator: string, seed: number): FakeValidator {
  return { operator, status: "BOND_STATUS_BONDED", jailed: false, tokens: "1000000000", consensusKey: new Uint8Array(32).fill(seed) };
}

function epoch(): DealerEpoch {
  return DealerEpoch.fromPartial({
    epochId: "9",
    threshold: 2,
    pkEpoch: point(7),
    transcriptRoot: new Uint8Array(32),
    startHeight: "100",
    slashed: [],
    members: [A, B, C].map((validator, i) => ({
      validator,
      index: i + 1,
      pubShare: groupElementToBytes(mulBase(SECRET)),
      consPubkey: new Uint8Array(32).fill(i),
      power: "1000",
      ephemeralPubkey: point(200 + i),
    })),
  });
}

const deckOf = (cards: number) => Array.from({ length: cards }, (_, i) => ({ c1: base64(point(1000 + i)), c2: base64(point(2000 + i)) }));
const seats = (n: number) => Array.from({ length: n }, (_, seat) => ({ player: `ocp1player${seat}`, stack: "500000", pk_player: base64(point(300 + seat)) }));

function dealerHand(over: Record<string, unknown> = {}) {
  return {
    epoch_id: "9",
    pk_hand: base64(point(77)),
    deck: deckOf(12),
    shuffle_step: 3,
    finalized: true,
    init_height: "990",
    init_hash_salt: base64(new Uint8Array(32).fill(5)),
    pub_shares: [],
    enc_shares: [],
    ...over,
  };
}

/** A node in epoch 9 (members A, B, C, threshold 2) whose table 1 holds `hand`. */
function nodeWith(table: Record<string, unknown>, hand?: Record<string, unknown>): FakeNode {
  const node = new FakeNode();
  node.nextEpochId = 10;
  node.epoch = epoch();
  node.validators = [bonded(A, 1), bonded(B, 2), bonded(C, 3)];
  node.tables.set("1", { id: "1", params: { dealer_timeout_secs: "120" }, next_hand_id: "6", seats: seats(2), ...table });
  if (hand) node.dealerHands.set("1/5", hand);
  node.answer = (msg) => (msg.typeUrl === MSG.timeout || msg.typeUrl === POKER.tick ? { refuse: "not due" } : "land");
  node.nodeStatus.blockTimeMs = NOW * 1000;
  return node;
}

async function daemonOf(node: FakeNode, validator: string) {
  const harness = daemonAgainst(node, validator);
  await harness.store.save({ epochId: 9, validatorIndex: 2, polyCoeffs: ["1", "2"], ephemeralSk: "3", received: {}, secretShare: SECRET.toString(16) });
  return harness.daemon;
}

/** The transactions of one poll that are not the probes every poll sends. */
function sentBy(node: FakeNode) {
  return node.txs.filter((tx) => !tx.msgs.some((m) => m.typeUrl === MSG.timeout || m.typeUrl === POKER.tick));
}

/** A table waiting for the card at position 4, its reveal opened `age` seconds ago. Order for pos 4: B, C, then A. */
const awaitingFlop = (age: number) => ({
  hand: {
    hand_id: "5",
    phase: "HAND_PHASE_AWAIT_FLOP",
    board: [],
    dealer: { epoch_id: "9", deck_finalized: true, cursor: 4, reveal_pos: 4, reveal_deadline: String(NOW - age + 120), hole_pos: [] },
  },
});

describe("revealing a card", () => {
  it("a member whose turn it is sends its public share, and FinalizeReveal behind it without a simulation, in one poll", async () => {
    const node = nodeWith(awaitingFlop(0), dealerHand());
    await pollOnce(await daemonOf(node, B));

    const txs = sentBy(node);
    assert.deepEqual(txs.map((tx) => typesOf(tx.msgs)), [["MsgSubmitPubShare"], ["MsgFinalizeReveal"]]);
    assert.deepEqual(txs.map((tx) => tx.msgs[0]!.value.pos), [4, 4]);
    assert.ok(txs[1]!.gasLimit !== undefined && txs[0]!.gasLimit === undefined, "the share is simulated, the FinalizeReveal behind it is not");
  });

  it("the third member waits while the reveal is in the block that opened it, and sends from the next one", async () => {
    const opened = nodeWith(awaitingFlop(0), dealerHand());
    await pollOnce(await daemonOf(opened, A));
    const later = nodeWith(awaitingFlop(5), dealerHand());
    await pollOnce(await daemonOf(later, A));

    assert.deepEqual(
      { inOpeningBlock: sentBy(opened).length, aBlockLater: sentBy(later).map((tx) => typesOf(tx.msgs)[0]) },
      { inOpeningBlock: 0, aBlockLater: ["MsgSubmitPubShare", "MsgFinalizeReveal"] },
    );
  });

  it("with its share and another in, a member whose FinalizeReveal failed sends it again, simulated", async () => {
    const shares = [B, C].map((validator) => ({ pos: 4, validator, index: 1, share: base64(point(9)), proof: "" }));
    const node = nodeWith(awaitingFlop(5), dealerHand({ pub_shares: shares }));
    await pollOnce(await daemonOf(node, B));

    const txs = sentBy(node);
    assert.deepEqual(txs.map((tx) => [typesOf(tx.msgs), tx.gasLimit]), [[["MsgFinalizeReveal"], undefined]]);
  });
});

describe("the hole cards", () => {
  const holePos = Array.from({ length: 18 }, (_, i) => (i < 6 ? i : 255));
  const hand = { hand: { hand_id: "5", phase: "HAND_PHASE_SHUFFLE", dealer: { epoch_id: "9", deck_finalized: true, hole_pos: holePos } }, seats: seats(3) };
  const fresh = () => dealerHand({ hole_shares_deadline: String(NOW + 120) });

  it("a member sends every share it owes in one transaction", async () => {
    // The order starts at the last shuffler, C, then A: C and A send in the block the deck became final.
    const node = nodeWith(hand, fresh());
    await pollOnce(await daemonOf(node, A));

    const txs = sentBy(node);
    assert.equal(txs.length, 1);
    assert.deepEqual(txs[0]!.msgs.map((m) => m.value.pos), [0, 1, 2, 3, 4, 5]);
  });

  it("after the chain refused that transaction it sends halves, and after that one share each", async () => {
    const node = nodeWith(hand, fresh());
    node.answer = (msg) => (msg.typeUrl === MSG.submitEncShare ? { refuse: "out of gas" } : { refuse: "not due" });
    const daemon = await daemonOf(node, A);
    const sizes: number[][] = [];
    for (let poll = 0; poll < 3; poll++) {
      const before = node.txs.length;
      node.height += 1;
      await pollOnce(daemon);
      sizes.push(node.txs.slice(before).filter((tx) => tx.msgs[0]!.typeUrl === MSG.submitEncShare).map((tx) => tx.msgs.length));
    }
    assert.deepEqual(sizes, [[6], [3, 3], [1, 1, 1, 1, 1, 1]]);
  });

  it("the member after the last shuffler's turn-mate waits a block", async () => {
    const node = nodeWith(hand, fresh());
    await pollOnce(await daemonOf(node, B));
    assert.equal(sentBy(node).length, 0);
  });
});

describe("shuffling and starting", () => {
  it("the last shuffler sends FinalizeDeck right behind its round, without a simulation", async () => {
    const node = nodeWith(
      { hand: { hand_id: "5", phase: "HAND_PHASE_SHUFFLE", dealer: { epoch_id: "9", deck_finalized: false } } },
      dealerHand({ deck: deckOf(4), shuffle_step: 2, finalized: false }),
    );
    await pollOnce(await daemonOf(node, C));

    const txs = sentBy(node);
    assert.deepEqual(txs.map((tx) => typesOf(tx.msgs)), [["MsgSubmitShuffle"], ["MsgFinalizeDeck"]]);
    assert.deepEqual([txs[0]!.msgs[0]!.value.round, txs[1]!.gasLimit !== undefined], [3, true]);
  });

  it("a started hand that is not initialized: the member whose turn it is sends InitHand at once, the others one block later", async () => {
    const table = { hand: { hand_id: "7", phase: "HAND_PHASE_SHUFFLE", dealer: { epoch_id: "0", deck_finalized: false } } };
    // The fake's state never shows the InitHand that landed, so only the members waiting are asked about the next block.
    const firstPoll = new Map<string, number>();
    const nextBlock = new Map<string, number>();
    for (const v of [A, B, C]) {
      const node = nodeWith(table);
      const daemon = await daemonOf(node, v);
      await pollOnce(daemon);
      firstPoll.set(v, sentBy(node).length);
      if (v === B) continue;
      node.height += 1;
      await pollOnce(daemon);
      nextBlock.set(v, sentBy(node).length - firstPoll.get(v)!);
    }
    assert.deepEqual(
      { first: Object.fromEntries(firstPoll), next: Object.fromEntries(nextBlock) },
      { first: { [A]: 0, [B]: 1, [C]: 0 }, next: { [A]: 1, [C]: 1 } },
    );
  });
});

