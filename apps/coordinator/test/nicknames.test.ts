import assert from "node:assert/strict";
import test from "node:test";

import { NicknameRegistry } from "../src/nicknames.js";

test("set/get round-trips", () => {
  const r = new NicknameRegistry();
  assert.equal(r.set("ocp1aaa", "Alice"), "ok");
  assert.equal(r.get("ocp1aaa"), "Alice");
  assert.equal(r.get("ocp1bbb"), undefined);
});

test("case-insensitive uniqueness across distinct addresses", () => {
  const r = new NicknameRegistry();
  assert.equal(r.set("ocp1aaa", "Alice"), "ok");
  assert.equal(r.set("ocp1bbb", "alice"), "taken");
  // The same address may update to a case variant of its own name.
  assert.equal(r.set("ocp1aaa", "ALICE"), "ok");
  assert.equal(r.get("ocp1aaa"), "ALICE");
});

test("bounds memory by evicting the oldest entry when full", () => {
  const r = new NicknameRegistry(3);
  r.set("ocp1a", "A");
  r.set("ocp1b", "B");
  r.set("ocp1c", "C");
  assert.equal(r.size, 3);

  r.set("ocp1d", "D"); // over cap → evicts oldest insert (ocp1a)
  assert.equal(r.size, 3);
  assert.equal(r.get("ocp1a"), undefined);
  assert.equal(r.get("ocp1b"), "B");
  assert.equal(r.get("ocp1d"), "D");
});

test("updating an existing key at capacity does not evict", () => {
  const r = new NicknameRegistry(2);
  r.set("ocp1a", "A");
  r.set("ocp1b", "B");
  assert.equal(r.set("ocp1a", "A2"), "ok"); // update, not a new insert
  assert.equal(r.size, 2);
  assert.equal(r.get("ocp1a"), "A2");
  assert.equal(r.get("ocp1b"), "B");
});

test("entries() yields all pairs", () => {
  const r = new NicknameRegistry();
  r.set("ocp1a", "A");
  r.set("ocp1b", "B");
  assert.deepEqual(Object.fromEntries(r.entries()), { ocp1a: "A", ocp1b: "B" });
});
