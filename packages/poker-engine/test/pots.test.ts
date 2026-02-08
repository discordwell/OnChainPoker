import assert from "node:assert/strict";
import test from "node:test";
import { computeSidePots } from "../src/pots.js";

test("computeSidePots: single pot equal stacks", () => {
  const totalCommit = [100n, 100n, 100n];
  const eligible = [true, true, true];
  const pots = computeSidePots(totalCommit, eligible);
  assert.deepEqual(pots, [{ amount: 300n, eligibleSeats: [0, 1, 2] }]);
});

test("computeSidePots: multi all-in (no uncalled excess)", () => {
  // Seat0 all-in 100, Seat1 all-in 200, Seat2 calls 200.
  const totalCommit = [100n, 200n, 200n];
  const eligible = [true, true, true];
  const pots = computeSidePots(totalCommit, eligible);
  assert.deepEqual(pots, [
    { amount: 300n, eligibleSeats: [0, 1, 2] },
    { amount: 200n, eligibleSeats: [1, 2] }
  ]);
});

test("computeSidePots: folded contributor excluded from eligibility", () => {
  const totalCommit = [100n, 200n, 200n];
  const eligible = [false, true, true];
  const pots = computeSidePots(totalCommit, eligible);
  assert.deepEqual(pots, [
    { amount: 500n, eligibleSeats: [1, 2] }
  ]);
});

test("computeSidePots: side pot only eligible for one (others folded)", () => {
  // Typical pattern when a side pot was contested, then one player folded later.
  const totalCommit = [50n, 150n, 150n];
  const eligible = [true, true, false];
  const pots = computeSidePots(totalCommit, eligible);
  assert.deepEqual(pots, [
    { amount: 150n, eligibleSeats: [0, 1] },
    { amount: 200n, eligibleSeats: [1] }
  ]);
});

