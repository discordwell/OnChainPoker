import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batches, InFlight, sharesNow, turnOrder } from "../src/turns.js";

const A = "ocpvaloper1a";
const B = "ocpvaloper1b";
const C = "ocpvaloper1c";
const qualified = [A, B, C].map((validator) => ({ validator }));

describe("turnOrder", () => {
  it("starts at the offset and keeps the chain's order after it, wrapping round", () => {
    assert.deepEqual(turnOrder(qualified, 0), [A, B, C]);
    assert.deepEqual(turnOrder(qualified, 2), [C, A, B]);
    assert.deepEqual(turnOrder(qualified, 7), [B, C, A]);
  });

  it("gives each of three consecutive cards a different first member", () => {
    const firsts = [12, 13, 14].map((pos) => turnOrder(qualified, pos)[0]);
    assert.equal(new Set(firsts).size, 3);
  });

  it("is empty when no member is qualified", () => {
    assert.deepEqual(turnOrder([], 3), []);
  });
});

describe("sharesNow", () => {
  const step = { order: [B, C, A], threshold: 2, openedAtUnix: 1_000 };

  it("the first `threshold` members in the order send in the block the step opened", () => {
    assert.equal(sharesNow({ ...step, me: B, nowUnix: 1_000 }), true);
    assert.equal(sharesNow({ ...step, me: C, nowUnix: 1_000 }), true);
  });

  it("the others wait for a later block, then send", () => {
    assert.equal(sharesNow({ ...step, me: A, nowUnix: 1_000 }), false);
    assert.equal(sharesNow({ ...step, me: A, nowUnix: 1_001 }), true);
  });

  it("a validator that is not in the order never sends", () => {
    assert.equal(sharesNow({ ...step, me: "ocpvaloper1z", nowUnix: 9_999 }), false);
  });
});

describe("batches", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => i);

  it("sends every item in one transaction while none of the step's transactions failed", () => {
    assert.deepEqual(batches(twelve, 0), [twelve]);
  });

  it("splits into halves after one failure and into single items after two", () => {
    assert.deepEqual(batches(twelve, 1), [twelve.slice(0, 6), twelve.slice(6)]);
    assert.deepEqual(batches(twelve, 2), twelve.map((i) => [i]));
  });

  it("keeps every item exactly once at every level", () => {
    for (const failures of [0, 1, 2, 5]) {
      for (const n of [1, 3, 4, 18]) {
        const items = Array.from({ length: n }, (_, i) => i);
        assert.deepEqual(batches(items, failures).flat(), items, `n=${n} failures=${failures}`);
      }
    }
  });

  it("has no transaction for no items", () => {
    assert.deepEqual(batches([], 0), []);
  });
});

describe("InFlight", () => {
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  it("holds a step for its blocks after the block it was sent from, then lets it go", () => {
    const f = new InFlight();
    f.track("t1:h5:pub12", 100, 1, new Promise(() => {}), () => {});
    assert.deepEqual([100, 101, 102].map((h) => f.holds("t1:h5:pub12", h)), [true, true, false]);
  });

  it("an Infinity hold lasts until the transaction settles", async () => {
    const f = new InFlight();
    let land!: () => void;
    f.track("t1:h5:shuffle", 100, Infinity, new Promise<void>((resolve) => (land = resolve)), () => {});
    assert.equal(f.holds("t1:h5:shuffle", 1_000), true);
    land();
    await settled();
    assert.equal(f.holds("t1:h5:shuffle", 1_000), false);
  });

  it("a transaction that fails lets the step go at once, counts the failure and reports it", async () => {
    const f = new InFlight();
    const reported: unknown[] = [];
    f.track("t1:h5:holeShares", 100, 1, Promise.reject(new Error("out of gas")), (err) => reported.push(err));
    await settled();
    assert.equal(f.holds("t1:h5:holeShares", 100), false);
    assert.equal(f.failures("t1:h5:holeShares"), 1);
    assert.equal(reported.length, 1);
  });

  it("forgets the other hands of a table, and nothing of other tables", () => {
    const f = new InFlight();
    for (const key of ["t1:h5:pub12", "t1:h6:start", "t2:h5:pub12"]) {
      f.track(key, 100, Infinity, new Promise(() => {}), () => {});
      f.fail(key);
    }
    f.forgetAllBut("t1:", "t1:h6:");
    assert.deepEqual(
      ["t1:h5:pub12", "t1:h6:start", "t2:h5:pub12"].map((k) => [f.holds(k, 100), f.failures(k)]),
      [[false, 0], [true, 1], [true, 1]],
    );
  });
});
