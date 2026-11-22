import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OCP_TYPE_URLS } from "@onchainpoker/ocp-sdk/cosmos";
import { BeaconState } from "../../../packages/ocp-sdk/dist/cosmos/gen/onchainpoker/dealer/v1/dealer.js";
import { FakeNode, daemonAgainst, pollOnce, type FakeValidator } from "./fakeNode.js";

const VALIDATORS = ["ocpvaloper1a", "ocpvaloper1b", "ocpvaloper1c"];

// A chain with no epoch and no DKG whose roll call is complete: the next thing a daemon sends is
// BeginEpoch. Each case below breaks one read of that same state.
function readyToBegin(): FakeNode {
  const node = new FakeNode();
  node.height = 1000;
  node.nextEpochId = 1;
  node.beacon = BeaconState.fromPartial({
    epochId: "1",
    commitOpenHeight: "900",
    commitCloseHeight: "950",
    revealCloseHeight: "1000",
    threshold: 2,
    commits: VALIDATORS.map((validator, i) => ({ validator, commit: new Uint8Array(32).fill(i + 1) })),
    reveals: VALIDATORS.map((validator, i) => ({ validator, salt: new Uint8Array(32).fill(i + 1) })),
  });
  node.validators = VALIDATORS.map(
    (operator, i): FakeValidator => ({ operator, status: "BOND_STATUS_BONDED", jailed: false, tokens: "1000000000", consensusKey: new Uint8Array(32).fill(i + 1) })
  );
  return node;
}

async function sentAfterOnePoll(node: FakeNode): Promise<string[]> {
  const { daemon } = daemonAgainst(node, VALIDATORS[0]!);
  await pollOnce(daemon);
  return node.sent.map((m) => m.typeUrl);
}

describe("rule 1: a failed chain read is not an absent epoch", () => {
  it("begins an epoch when the chain answers that there is no epoch, no DKG, and a complete roll call", async () => {
    const sent = await sentAfterOnePoll(readyToBegin());
    assert.ok(sent.includes(OCP_TYPE_URLS.dealer.beginEpoch), `expected MsgBeginEpoch among ${JSON.stringify(sent)}`);
  });

  it("sends nothing to the chain when the node refuses every store read", async () => {
    const node = readyToBegin();
    node.failRead = (read) => (read.startsWith("store:") ? "fetch failed" : null);
    assert.deepEqual(await sentAfterOnePoll(node), []);
  });

  for (const [what, key] of [["epoch", "0x02"], ["DKG", "0x03"], ["beacon", "0x05"], ["next epoch id", "0x01"]] as const) {
    it(`sends nothing to the chain when only the ${what} read fails`, async () => {
      const node = readyToBegin();
      node.failRead = (read) => (read === `store:${key}` ? "socket hang up" : null);
      assert.deepEqual(await sentAfterOnePoll(node), []);
    });
  }

  it("sends nothing to the chain when the validators read fails", async () => {
    const node = readyToBegin();
    node.failRead = (read) => (read === "lcd:/cosmos/staking/v1beta1/validators" ? "fetch failed" : null);
    assert.deepEqual(await sentAfterOnePoll(node), []);
  });
});
