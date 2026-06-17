import assert from "node:assert/strict";
import test from "node:test";

import { evictSoonestToExpire } from "../src/faucet.js";

test("evicts entries closest to expiry first, down to the cap", () => {
  const m = new Map<string, number>([
    ["a", 100], // soonest to expire
    ["b", 200],
    ["c", 300],
    ["d", 400], // latest
  ]);
  evictSoonestToExpire(m, 2);
  assert.equal(m.size, 2);
  // The two with the longest-running cooldowns survive.
  assert.equal(m.has("c"), true);
  assert.equal(m.has("d"), true);
  assert.equal(m.has("a"), false);
  assert.equal(m.has("b"), false);
});

test("no-op when at or below the cap", () => {
  const m = new Map<string, number>([
    ["a", 100],
    ["b", 200],
  ]);
  evictSoonestToExpire(m, 5);
  assert.equal(m.size, 2);
});

test("regression: does not drop a freshly-renewed long cooldown (the old insertion-order bug)", () => {
  // Insertion-order eviction would drop "a" (inserted first) even though it was
  // just renewed with the longest cooldown — re-arming its rate limit early.
  // Expiry-order keeps it and drops the near-expired entries instead.
  const m = new Map<string, number>();
  m.set("a", 1000); // inserted first, but expires last
  m.set("b", 10);
  m.set("c", 20);
  evictSoonestToExpire(m, 1);
  assert.equal(m.size, 1);
  assert.equal(m.has("a"), true);
});
