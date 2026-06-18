import assert from "node:assert/strict";
import test from "node:test";

import { dispatchChainEvents } from "../src/chain/dispatch.js";
import type { ChainEvent } from "../src/types.js";

function ev(name: string, eventIndex: number): ChainEvent {
  return { name, eventIndex, timeMs: 0 };
}

test("dispatchChainEvents delivers every event to every healthy subscriber", () => {
  const a: ChainEvent[] = [];
  const b: ChainEvent[] = [];
  const events = [ev("one", 1), ev("two", 2)];

  dispatchChainEvents([(e) => a.push(e), (e) => b.push(e)], events);

  assert.deepEqual(a.map((e) => e.name), ["one", "two"]);
  assert.deepEqual(b.map((e) => e.name), ["one", "two"]);
});

test("a throwing subscriber does not starve its siblings or escape the call", () => {
  const healthy: ChainEvent[] = [];
  const errors: Array<{ err: unknown; ev: ChainEvent }> = [];
  const events = [ev("one", 1), ev("two", 2)];

  const throwing = () => {
    throw new Error("boom");
  };

  // Throwing subscriber is first in iteration order; the healthy one must still
  // receive both events, and dispatchChainEvents itself must not throw.
  assert.doesNotThrow(() =>
    dispatchChainEvents(
      [throwing, (e) => healthy.push(e)],
      events,
      (err, e) => errors.push({ err, ev: e })
    )
  );

  assert.deepEqual(healthy.map((e) => e.name), ["one", "two"]);
  // onError fires once per failed (subscriber, event) pair: 1 bad subscriber × 2 events.
  assert.equal(errors.length, 2);
  assert.ok(errors[0]!.err instanceof Error);
  assert.equal(errors[0]!.ev.name, "one");
  assert.equal(errors[1]!.ev.name, "two");
});

test("dispatchChainEvents swallows subscriber throws even without an onError handler", () => {
  const events = [ev("one", 1)];
  assert.doesNotThrow(() =>
    dispatchChainEvents(
      [
        () => {
          throw new Error("boom");
        }
      ],
      events
    )
  );
});

test("dispatchChainEvents is a no-op for an empty event batch", () => {
  let called = 0;
  dispatchChainEvents([() => (called += 1)], []);
  assert.equal(called, 0);
});
