import assert from "node:assert/strict";
import test from "node:test";

import { cosmosEventsToChainEvents } from "../src/chain/cosmos.js";

test("CosmosChainAdapter: cosmosEventsToChainEvents maps ABCI events", () => {
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
  const out = cosmosEventsToChainEvents(events as any, { eventIndexStart: 10, timeMs: 999 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.eventIndex, 10);
  assert.equal(out[0]!.timeMs, 999);
  assert.equal(out[0]!.name, "HandStarted");
  assert.equal(out[0]!.tableId, "7");
  assert.equal(out[0]!.handId, "42");
  assert.deepEqual(out[0]!.data, { tableId: "7", handId: "42", actionOn: "3" });
});

test("CosmosChainAdapter: cosmosEventsToChainEvents decodes base64 event attrs when needed", () => {
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
  const out = cosmosEventsToChainEvents(events as any, { eventIndexStart: 1, timeMs: 123 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tableId, "7");
  assert.equal(out[0]!.handId, "42");
  assert.deepEqual(out[0]!.data, { tableId: "7", handId: "42" });
});

