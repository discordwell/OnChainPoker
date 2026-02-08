import test from "node:test";
import assert from "node:assert/strict";
import { getScenarioById, getScenarios } from "../src/scenarios.js";

test("scenarios are registered", () => {
  const ids = new Set(getScenarios().map((s) => s.id));
  assert(ids.has("mid-hand-slash-continues"));
  assert(ids.has("threshold-failure-abort-refund"));
  assert(ids.has("repeated-grief-timeouts-drain-bond"));
  assert(ids.has("committee-rotation-two-hands"));
});

test("mid-hand slash continues to completion", () => {
  const s = getScenarioById("mid-hand-slash-continues");
  assert(s);
  const res = s.run();

  const slashes = res.events.filter((e) => e.type === "ValidatorSlashed");
  assert(slashes.length >= 1);

  assert.equal(res.world.table.hand?.phase, "HandComplete");
});

test("threshold failure abort triggers refund semantics", () => {
  const s = getScenarioById("threshold-failure-abort-refund");
  assert(s);
  const res = s.run();

  assert.equal(res.world.table.hand?.phase, "HandAborted");

  // Since this abort occurs after at least one preflop action beyond blinds, all committed is refunded.
  for (const p of res.world.table.players.slice(0, 3)) {
    assert.equal(p.committed, 0);
    assert.equal(p.stack, res.world.config.startingStack);
  }
});

test("repeated timeouts drain bond and eject", () => {
  const s = getScenarioById("repeated-grief-timeouts-drain-bond");
  assert(s);
  const res = s.run();

  const p1 = res.world.table.players.find((p) => p.id === "P1");
  assert(p1);
  assert(p1.timeoutCount >= 1);
  assert(p1.bond <= 10);
  assert(["Ejected", "SitOut", "Folded", "Seated", "InHand"].includes(p1.status));
  // We expect ejection by the end given startingBond=12 and slash=2 per timeout.
  assert.equal(p1.status, "Ejected");
});

test("committee rotates between hands and excludes jailed validators", () => {
  const s = getScenarioById("committee-rotation-two-hands");
  assert(s);
  const res = s.run();

  const handStarted = res.events.filter((e) => e.type === "HandStarted");
  assert.equal(handStarted.length, 2);
  const c1 = new Set((handStarted[0] as any).committee as string[]);
  const c2 = new Set((handStarted[1] as any).committee as string[]);
  assert.notDeepEqual([...c1].sort(), [...c2].sort());

  const v0 = res.world.validators.get("V0" as any);
  assert(v0);
  assert.equal(v0.status, "Jailed");
});

