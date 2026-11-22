import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleShuffle } from "../src/handlers/shuffle.js";
import { InFlight } from "../src/turns.js";

class StubClient {
  submissions: Array<unknown> = [];
  dealerHand: any;

  constructor(dealerHand: any) {
    this.dealerHand = dealerHand;
  }

  async getDealerHand(_tableId: string, _handId: string): Promise<any> {
    return this.dealerHand;
  }

  readonly messages = { submitShuffle: (args: unknown) => args, finalizeDeck: (args: unknown) => args };

  /** The hand sender the daemon passes: every shuffle it sends is a submission. */
  readonly sender = {
    height: 1,
    inflight: new InFlight(),
    send: async (s: { msgs: readonly unknown[] }) => {
      this.submissions.push(...s.msgs);
      return true;
    },
  };
}

function makeMembers(addrs: string[]) {
  return addrs.map((validator, index) => ({ validator, index }));
}

describe("handleShuffle wraparound guard", () => {
  // Regression for the "step 4/3" bug: chain caps ShuffleStep at N after all
  // members shuffle, but daemon used `actualStep % members.length` and
  // wrapped 3 % 3 = 0. Whoever was first in the list then re-submitted a proof
  // the chain rejected with "deck already finalized". Fix removes the modulo
  // and returns early when actualStep >= N.
  it("returns without submitting when actualStep equals committee size", async () => {
    const me = "ocpvaloper1aaa";
    const client = new StubClient({ shuffleStep: 3 });
    const shufflers = makeMembers([me, "ocpvaloper1bbb", "ocpvaloper1ccc"]);

    await handleShuffle({
      client: client as any,
      config: { validatorAddress: me, shuffleRounds: 4 } as any,
      tableId: "1",
      handId: "100",
      shufflers,
      sender: client.sender,
    });

    assert.equal(client.submissions.length, 0, "must not submit a shuffle after all members have already shuffled");
  });

  it("returns without submitting when actualStep exceeds committee size", async () => {
    const me = "ocpvaloper1aaa";
    const client = new StubClient({ shuffleStep: 5 });
    const shufflers = makeMembers([me, "ocpvaloper1bbb", "ocpvaloper1ccc"]);

    await handleShuffle({
      client: client as any,
      config: { validatorAddress: me, shuffleRounds: 4 } as any,
      tableId: "1",
      handId: "100",
      shufflers,
      sender: client.sender,
    });

    assert.equal(client.submissions.length, 0);
  });

  it("returns without submitting when it is another member's turn", async () => {
    const me = "ocpvaloper1aaa";
    const client = new StubClient({ shuffleStep: 0 });
    // step 0 belongs to shufflers[0] = xxx, not us.
    const shufflers = makeMembers(["ocpvaloper1xxx", me, "ocpvaloper1zzz"]);

    await handleShuffle({
      client: client as any,
      config: { validatorAddress: me, shuffleRounds: 4 } as any,
      tableId: "1",
      handId: "100",
      shufflers,
      sender: client.sender,
    });

    assert.equal(client.submissions.length, 0);
  });
});

describe("finalDeckOf", () => {
  it("reads the deck a shuffle proof ends with, for an even and an odd deck and both proof versions", async () => {
    const { groupElementToBytes, mulBase } = await import("@onchainpoker/ocp-crypto");
    const { shuffleProveV1, buildShuffleContext } = await import("@onchainpoker/ocp-shuffle");
    const { finalDeckOf, deckKey } = await import("../src/handlers/shuffle.js");
    const pk = mulBase(77n);
    for (const n of [4, 5]) {
      const deck = Array.from({ length: n }, (_, i) => ({ c1: mulBase(BigInt(1000 + i)), c2: mulBase(BigInt(2000 + i)) }));
      for (const context of [undefined, buildShuffleContext({ tableId: 1, handId: 5, round: 2, shuffler: "ocpvaloper1aaa" })]) {
        const { deckOut, proofBytes } = shuffleProveV1(pk, deck, { rounds: 3, context });
        const expected = deckOut.map((ct) => ({ c1: groupElementToBytes(ct.c1), c2: groupElementToBytes(ct.c2) }));
        assert.equal(deckKey(finalDeckOf(proofBytes)), deckKey(expected), `n=${n} ${context ? "v2" : "v1"}`);
      }
    }
  });
});

describe("initialDeck", () => {
  it("makes the deck the chain's InitHand made (read from a local three-validator chain at the InitHand's height)", async () => {
    const { initialDeck, deckKey } = await import("../src/handlers/shuffle.js");
    const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
    // Epoch 1, table 1, hand 2, InitHand at height 1,100,366; its init_hash_salt was 32 zero bytes.
    const { deck } = initialDeck({ pkEpoch: b64("2lMsZzYrEpvuuHyCh378gxYv7Y5DIrPNq4b+Brzq2AA="), epochId: 1, tableId: "1", handId: "2", initHeight: 1_100_366 });
    assert.equal(deck.length, 52);
    assert.equal(deckKey([deck[0]!, deck[51]!]), deckKey([
      { c1: "lLdbpOfSJ4o1aVNmTFS8C/1QMUKDBuKOOmtI5VUZpkE=", c2: "VsWLjOuYziQFf3Wu8zt93MdDh2z9G1RNink/u5PzY2k=" },
      { c1: "oF7q8EZzk2p/NkHGk71UD85EtjuNscXUI9SuAI/6JTY=", c2: "/pgRp7x+50gZ65uK334Xu4YrV1AvYbRuE5/9vXOxHyM=" },
    ]));
  });
});
