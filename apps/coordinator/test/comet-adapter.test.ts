import assert from "node:assert/strict";
import test from "node:test";

import { v0EventsToChainEvents, v0TableToTableInfo } from "../src/chain/comet.js";

test("CometChainAdapter: v0TableToTableInfo maps v0 /table shape", () => {
  const nowMs = 123;
  const v0 = {
    id: 7,
    params: { maxPlayers: 9, smallBlind: 1, bigBlind: 2, minBuyIn: 100, maxBuyIn: 1000 },
    hand: null
  };
  const info = v0TableToTableInfo(v0, nowMs);
  assert.equal(info.tableId, "7");
  assert.equal(info.status, "open");
  assert.equal(info.updatedAtMs, nowMs);
  assert.equal(info.params.maxPlayers, 9);
  assert.equal(info.params.smallBlind, "1");
  assert.equal(info.params.bigBlind, "2");
  assert.equal(info.params.minBuyIn, "100");
  assert.equal(info.params.maxBuyIn, "1000");

  const withHand = v0TableToTableInfo({ ...v0, hand: { handId: 1 } }, nowMs);
  assert.equal(withHand.status, "in_hand");
});

test("CometChainAdapter: v0EventsToChainEvents maps ABCI events", () => {
  const events = [
    {
      type: "HandStarted",
      attributes: [
        { key: "tableId", value: "7" },
        { key: "handId", value: "42" },
        { key: "actionOn", value: "3" }
      ]
    }
  ];
  const out = v0EventsToChainEvents(events as any, { eventIndexStart: 10, timeMs: 999 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.eventIndex, 10);
  assert.equal(out[0]!.timeMs, 999);
  assert.equal(out[0]!.name, "HandStarted");
  assert.equal(out[0]!.tableId, "7");
  assert.equal(out[0]!.handId, "42");
  assert.deepEqual(out[0]!.data, { tableId: "7", handId: "42", actionOn: "3" });
});

test("CometChainAdapter: v0EventsToChainEvents decodes base64 event attrs when needed", () => {
  const events = [
    {
      type: "HandStarted",
      attributes: [
        // "tableId" -> "dGFibGVJZA==", "7" -> "Nw=="
        { key: "dGFibGVJZA==", value: "Nw==" },
        // "handId" -> "aGFuZElk", "42" -> "NDI="
        { key: "aGFuZElk", value: "NDI=" }
      ]
    }
  ];
  const out = v0EventsToChainEvents(events as any, { eventIndexStart: 1, timeMs: 123 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tableId, "7");
  assert.equal(out[0]!.handId, "42");
  assert.deepEqual(out[0]!.data, { tableId: "7", handId: "42" });
});
