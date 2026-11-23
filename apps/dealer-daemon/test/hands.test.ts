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

  it("with no hand, a player's StartHand in the mempool: the member whose turn the next hand is sends InitHand behind it, unsimulated; the others wait", async () => {
    // Hand 7: 7 mod 3 = 1, so the order is B, C, A.
    const sent = new Map<string, [string[], boolean][]>();
    for (const v of [A, B, C]) {
      const node = nodeWith({ next_hand_id: "7" });
      const daemon = await daemonOf(node, v);
      await pollOnce(daemon);
      node.pending = [{ typeUrl: POKER.startHand, value: { caller: "ocp1player0", tableId: "1" } }];
      await (daemon as unknown as { aheadOfTheBlock(): Promise<void> }).aheadOfTheBlock();
      sent.set(v, sentBy(node).map((tx) => [typesOf(tx.msgs), tx.gasLimit !== undefined]));
    }
    assert.deepEqual(Object.fromEntries(sent), { [A]: [], [B]: [[["MsgInitHand"], true]], [C]: [] });
  });

  it("polls again at the same height send that InitHand once", async () => {
    const node = nodeWith({ next_hand_id: "7" });
    node.answer = (msg) => (msg.typeUrl === MSG.initHand ? "wait" : { refuse: "not due" });
    const daemon = await daemonOf(node, B);
    for (let repoll = 0; repoll < 3; repoll++) {
      await pollOnce(daemon);
      node.pending = [{ typeUrl: POKER.startHand, value: { caller: "ocp1player0", tableId: "1" } }];
      await (daemon as unknown as { aheadOfTheBlock(): Promise<void> }).aheadOfTheBlock();
    }
    assert.equal(node.sentOf(MSG.initHand).length, 1);
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

describe("proving a shuffle round ahead", () => {
  // The order of shufflers is A, B, C. A's round 1 is in the mempool; B shuffles round 2.
  const shuffling = (deck: unknown[], step: number) =>
    [{ hand: { hand_id: "5", phase: "HAND_PHASE_SHUFFLE", dealer: { epoch_id: "9", deck_finalized: false } } }, dealerHand({ deck, shuffle_step: step, finalized: false })] as const;

  async function roundOneOfA() {
    const { shuffleProveV1, buildShuffleContext } = await import("@onchainpoker/ocp-shuffle");
    const { decodeDeck, finalDeckOf } = await import("../src/handlers/shuffle.js");
    const context = buildShuffleContext({ tableId: 1, handId: 5, round: 1, shuffler: A });
    const { proofBytes } = shuffleProveV1(mulBase(77n), decodeDeck(deckOf(4)), { rounds: 2, context });
    const after = finalDeckOf(proofBytes).map((e) => ({ c1: base64(e.c1), c2: base64(e.c2) }));
    return { msg: { typeUrl: MSG.submitShuffle, value: { tableId: "1", handId: "5", round: 1, shuffler: A, proofShuffle: proofBytes } }, after };
  }
  const proveAhead = (daemon: unknown) => (daemon as { aheadOfTheBlock(): Promise<void> }).aheadOfTheBlock();
  const roundTwo = (node: FakeNode) => node.sentOf(MSG.submitShuffle).map((m) => Buffer.from(m.value.proofShuffle).toString("hex"));

  it("the next shuffler proves its round on the deck the pending round leaves, and sends that proof once the chain shows that deck", async () => {
    const node = nodeWith(...shuffling(deckOf(4), 0));
    const daemon = await daemonOf(node, B);
    await pollOnce(daemon);
    const { msg, after } = await roundOneOfA();
    node.pending = [msg];
    await proveAhead(daemon);
    const made = Buffer.from((daemon as any).ahead.proofBytes).toString("hex");

    node.dealerHands.set("1/5", shuffling(after, 1)[1]);
    node.height += 1;
    await pollOnce(daemon);

    assert.deepEqual(roundTwo(node), [made]);
  });

  it("a proof made on a deck the chain does not show is not sent; the round is proved again on the chain's deck", async () => {
    const node = nodeWith(...shuffling(deckOf(4), 0));
    const daemon = await daemonOf(node, B);
    await pollOnce(daemon);
    node.pending = [(await roundOneOfA()).msg];
    await proveAhead(daemon);
    const made = Buffer.from((daemon as any).ahead.proofBytes).toString("hex");

    // A's round that landed is another proof than the one that was pending.
    node.dealerHands.set("1/5", shuffling((await roundOneOfA()).after, 1)[1]);
    node.height += 1;
    await pollOnce(daemon);

    const sent = roundTwo(node);
    assert.equal(sent.length, 1);
    assert.notEqual(sent[0], made);
  });
});

describe("revealing a street's next card ahead", () => {
  // The flop: positions 4, 5, 6, the chain waits for 4. The order for 5 is C, A, B; for 6, A, B, C.
  const flop = () => nodeWith(awaitingFlop(0), dealerHand());
  const pub = (validator: string, pos: number) => ({ typeUrl: MSG.submitPubShare, value: { tableId: "1", handId: "5", pos, validator } });
  const fin = (pos: number) => ({ typeUrl: MSG.finalizeReveal, value: { tableId: "1", handId: "5", pos } });
  const ahead = (daemon: unknown) => (daemon as { aheadOfTheBlock(): Promise<void> }).aheadOfTheBlock();

  it("when the mempool holds two shares of the waited card and a FinalizeReveal behind them, the next card's member sends its share and FinalizeReveal, unsimulated", async () => {
    const node = flop();
    const daemon = await daemonOf(node, C);
    await pollOnce(daemon);
    const before = sentBy(node).length;
    node.pending = [pub(B, 4), pub(C, 4), fin(4)];
    await ahead(daemon);

    const txs = sentBy(node).slice(before);
    assert.deepEqual(txs.map((tx) => [typesOf(tx.msgs)[0], tx.msgs[0]!.value.pos, tx.gasLimit !== undefined]), [
      ["MsgSubmitPubShare", 5, true],
      ["MsgFinalizeReveal", 5, true],
    ]);
  });

  it("sends nothing ahead when the FinalizeReveal in the mempool has only one share before it", async () => {
    const node = flop();
    const daemon = await daemonOf(node, C);
    await pollOnce(daemon);
    const before = sentBy(node).length;
    node.pending = [pub(B, 4), fin(4), pub(C, 4)];
    await ahead(daemon);
    assert.equal(sentBy(node).length, before);
  });
});

describe("the dealer sends a card's share only once a committed block makes that card due", () => {
  const ahead = (daemon: unknown) => (daemon as { aheadOfTheBlock(): Promise<void> }).aheadOfTheBlock();
  const shares = (node: FakeNode) => node.sent.filter((m) => m.typeUrl === MSG.submitPubShare || m.typeUrl === MSG.submitEncShare).map((m) => m.value.pos);

  // Two players, seat 1 to act. Its legal action would end the betting; the mempool holds its
  // illegal twin instead (a call facing nothing, a check facing a bet), which the chain refuses in
  // its block. The cards after each street: the flop 4, 5, 6, the turn 7, the river 8, then the
  // showdown's hole cards 0 to 3.
  const betting = (street: string, board: number[], betTo: string, commit: string[], illegal: string) => ({
    table: {
      hand: {
        hand_id: "5",
        phase: "HAND_PHASE_BETTING",
        street,
        board,
        action_on: 1,
        bet_to: betTo,
        interval_id: "1",
        in_hand: [true, true],
        folded: [false, false],
        all_in: [false, false],
        street_commit: commit,
        last_interval_acted: [1, -1],
        dealer: { epoch_id: "9", deck_finalized: true, cursor: 4, reveal_pos: 255, hole_pos: [0, 2, 1, 3, ...Array(14).fill(255)] },
      },
    },
    pending: { typeUrl: POKER.act, value: { player: "ocp1player1", tableId: "1", action: illegal, amount: "0" } },
  });
  const streets = {
    preflop: betting("STREET_PREFLOP", [], "10000", ["10000", "10000"], "call"),
    flop: betting("STREET_FLOP", [11, 12, 13], "5000", ["5000", "0"], "check"),
    turn: betting("STREET_TURN", [11, 12, 13, 14], "0", ["0", "0"], "call"),
    river: betting("STREET_RIVER", [11, 12, 13, 14, 15], "0", ["0", "0"], "call"),
  };

  it("a player's action in the mempool that would end the betting: no member sends a share of the flop, turn, river or any hole card", async () => {
    const sent: Record<string, Record<string, number[]>> = {};
    for (const v of [A, B, C]) {
      sent[v] = {};
      for (const [name, { table, pending }] of Object.entries(streets)) {
        const node = nodeWith(table, dealerHand());
        const daemon = await daemonOf(node, v);
        await pollOnce(daemon);
        node.pending = [pending];
        await ahead(daemon);
        await pollOnce(daemon);
        sent[v]![name] = shares(node);
      }
    }
    const none = { preflop: [], flop: [], turn: [], river: [] };
    assert.deepEqual(sent, { [A]: none, [B]: none, [C]: none });
  });

  it("the last round's shuffle and FinalizeDeck in the mempool: no member sends a hole-card share until a block shows the deck final", async () => {
    const { shuffleProveV1, buildShuffleContext } = await import("@onchainpoker/ocp-shuffle");
    const { decodeDeck } = await import("../src/handlers/shuffle.js");
    const context = buildShuffleContext({ tableId: 1, handId: 5, round: 3, shuffler: C });
    const { proofBytes } = shuffleProveV1(mulBase(77n), decodeDeck(deckOf(12)), { rounds: 2, context });
    const hand = { hand_id: "5", phase: "HAND_PHASE_SHUFFLE", small_blind_seat: 0, in_hand: [true, true, true], dealer: { epoch_id: "9", deck_finalized: false } };
    const sent: Record<string, number[]> = {};
    for (const v of [A, B, C]) {
      const node = nodeWith({ hand, seats: seats(3) }, dealerHand({ shuffle_step: 2, finalized: false }));
      const daemon = await daemonOf(node, v);
      await pollOnce(daemon);
      node.pending = [
        { typeUrl: MSG.submitShuffle, value: { tableId: "1", handId: "5", round: 3, shuffler: C, proofShuffle: proofBytes } },
        { typeUrl: MSG.finalizeDeck, value: { caller: "ocp1c", tableId: "1", handId: "5" } },
      ];
      await ahead(daemon);
      sent[v] = shares(node);
    }
    assert.deepEqual(sent, { [A]: [], [B]: [], [C]: [] });
  });
});

describe("proving the first shuffle round ahead", () => {
  it("the first shuffler proves round 1 on the deck a pending InitHand makes in the next block, and sends that proof once the chain shows it", async () => {
    const { initialDeck } = await import("../src/handlers/shuffle.js");
    const node = nodeWith({ next_hand_id: "6" });
    const daemon = await daemonOf(node, A);
    await pollOnce(daemon);
    node.pending = [{ typeUrl: MSG.initHand, value: { caller: "ocp1x", tableId: "1", handId: "6", epochId: "9", deckSize: 0 } }];
    await (daemon as unknown as { aheadOfTheBlock(): Promise<void> }).aheadOfTheBlock();
    const made = Buffer.from((daemon as any).ahead.proofBytes).toString("hex");

    const { pkHand, deck } = initialDeck({ pkEpoch: point(7), epochId: 9, tableId: "1", handId: "6", initHeight: node.height + 1 });
    node.height += 1;
    node.pending = [];
    node.tables.set("1", { ...(node.tables.get("1") as object), hand: { hand_id: "6", phase: "HAND_PHASE_SHUFFLE", dealer: { epoch_id: "9", deck_finalized: false } } });
    node.dealerHands.set("1/6", dealerHand({ pk_hand: base64(pkHand), deck: deck.map((e) => ({ c1: base64(e.c1), c2: base64(e.c2) })), shuffle_step: 0, finalized: false }));
    await pollOnce(daemon);

    const sent = node.sentOf(MSG.submitShuffle).map((m) => [m.value.round, Buffer.from(m.value.proofShuffle).toString("hex") === made]);
    assert.deepEqual(sent, [[1, true]]);
  });
});
