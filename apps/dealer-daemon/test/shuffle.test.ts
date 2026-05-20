import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleShuffle } from "../src/handlers/shuffle.js";

class StubClient {
  submissions: Array<unknown> = [];
  dealerHand: any;

  constructor(dealerHand: any) {
    this.dealerHand = dealerHand;
  }

  async getDealerHand(_tableId: string, _handId: string): Promise<any> {
    return this.dealerHand;
  }

  async dealerSubmitShuffle(args: unknown): Promise<void> {
    this.submissions.push(args);
  }
}

function makeMembers(addrs: string[]) {
  return addrs.map((validator, index) => ({ validator, index }));
}

describe("handleShuffle wraparound guard", () => {
  // Regression for the "step 4/3" bug: chain caps ShuffleStep at N after all
  // members shuffle, but daemon used `actualStep % epochMembers.length` and
  // wrapped 3 % 3 = 0. Whoever was epochMembers[0] then re-submitted a proof
  // the chain rejected with "deck already finalized". Fix removes the modulo
  // and returns early when actualStep >= N.
  it("returns without submitting when actualStep equals committee size", async () => {
    const me = "ocpvaloper1aaa";
    const client = new StubClient({ shuffleStep: 3 });
    const epochMembers = makeMembers([me, "ocpvaloper1bbb", "ocpvaloper1ccc"]);

    await handleShuffle({
      client: client as any,
      config: { validatorAddress: me, shuffleRounds: 4 } as any,
      tableId: "1",
      handId: "100",
      epochMembers,
    });

    assert.equal(client.submissions.length, 0, "must not submit a shuffle after all members have already shuffled");
  });

  it("returns without submitting when actualStep exceeds committee size", async () => {
    const me = "ocpvaloper1aaa";
    const client = new StubClient({ shuffleStep: 5 });
    const epochMembers = makeMembers([me, "ocpvaloper1bbb", "ocpvaloper1ccc"]);

    await handleShuffle({
      client: client as any,
      config: { validatorAddress: me, shuffleRounds: 4 } as any,
      tableId: "1",
      handId: "100",
      epochMembers,
    });

    assert.equal(client.submissions.length, 0);
  });

  it("returns without submitting when it is another member's turn", async () => {
    const me = "ocpvaloper1aaa";
    const client = new StubClient({ shuffleStep: 0 });
    // step 0 belongs to epochMembers[0] = xxx, not us.
    const epochMembers = makeMembers(["ocpvaloper1xxx", me, "ocpvaloper1zzz"]);

    await handleShuffle({
      client: client as any,
      config: { validatorAddress: me, shuffleRounds: 4 } as any,
      tableId: "1",
      handId: "100",
      epochMembers,
    });

    assert.equal(client.submissions.length, 0);
  });
});
