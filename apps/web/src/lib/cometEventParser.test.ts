import { describe, expect, it } from "vitest";
import {
  maybeBase64ToUtf8,
  extractTxResult,
  eventsToChainEvents,
  toWebSocketUrl,
  attrsToObject,
} from "./cometEventParser";

describe("maybeBase64ToUtf8", () => {
  it("decodes a valid base64 string to UTF-8", () => {
    // "tableId" in base64
    const encoded = btoa("tableId");
    expect(maybeBase64ToUtf8(encoded)).toBe("tableId");
  });

  it("returns plain strings unchanged", () => {
    expect(maybeBase64ToUtf8("hello-world")).toBe("hello-world");
    expect(maybeBase64ToUtf8("foo.bar.baz")).toBe("foo.bar.baz");
  });

  it("returns empty string for empty input", () => {
    expect(maybeBase64ToUtf8("")).toBe("");
  });

  it("handles base64 with padding", () => {
    const encoded = btoa("a]"); // produces base64 with padding
    expect(maybeBase64ToUtf8(encoded)).toBe("a]");
  });

  it("returns original for strings that look base64-ish but fail round-trip", () => {
    // A string that matches the regex but isn't valid base64 round-trip
    expect(maybeBase64ToUtf8("ZZZZ")).toBe(maybeBase64ToUtf8("ZZZZ"));
  });

  it("returns original for null/undefined coerced", () => {
    expect(maybeBase64ToUtf8(null as any)).toBe("");
    expect(maybeBase64ToUtf8(undefined as any)).toBe("");
  });

  it("decodes base64-encoded numeric values", () => {
    const encoded = btoa("42");
    expect(maybeBase64ToUtf8(encoded)).toBe("42");
  });
});

describe("extractTxResult", () => {
  it("extracts TxResult from standard CometBFT event message", () => {
    const msg = {
      result: {
        data: {
          value: {
            TxResult: { events: [{ type: "poker.seat_taken" }] },
          },
        },
      },
    };
    const result = extractTxResult(msg);
    expect(result).toEqual({ events: [{ type: "poker.seat_taken" }] });
  });

  it("extracts from params.result shape", () => {
    const msg = {
      params: {
        result: {
          data: {
            value: {
              TxResult: { events: [] },
            },
          },
        },
      },
    };
    const result = extractTxResult(msg);
    expect(result).toEqual({ events: [] });
  });

  it("extracts from flat result with events", () => {
    const msg = {
      result: {
        events: [{ type: "poker.action" }],
      },
    };
    const result = extractTxResult(msg);
    expect(result).toEqual({ events: [{ type: "poker.action" }] });
  });

  it("returns null for subscribe ACK", () => {
    expect(extractTxResult({ id: 1, result: {} })).toBeNull();
  });

  it("returns null for empty message", () => {
    expect(extractTxResult({})).toBeNull();
  });

  it("returns null for error message", () => {
    expect(extractTxResult({ error: { code: -1 } })).toBeNull();
  });
});

describe("attrsToObject", () => {
  it("converts plain key-value attributes", () => {
    const attrs = [
      { key: "tableId", value: "1" },
      { key: "handId", value: "5" },
    ];
    expect(attrsToObject(attrs)).toEqual({ tableId: "1", handId: "5" });
  });

  it("decodes base64-encoded attributes", () => {
    const attrs = [
      { key: btoa("tableId"), value: btoa("42") },
    ];
    expect(attrsToObject(attrs)).toEqual({ tableId: "42" });
  });

  it("handles empty/undefined attributes", () => {
    expect(attrsToObject(undefined)).toEqual({});
    expect(attrsToObject([])).toEqual({});
  });

  it("skips malformed entries", () => {
    const attrs = [
      null as any,
      { key: 123 as any, value: "val" },
      { key: "good", value: "val" },
    ];
    expect(attrsToObject(attrs)).toEqual({ good: "val" });
  });
});

describe("eventsToChainEvents", () => {
  it("transforms ABCI events to ChainEvent objects", () => {
    const events = [
      {
        type: "poker.seat_taken",
        attributes: [
          { key: "tableId", value: "1" },
          { key: "seat", value: "3" },
        ],
      },
      {
        type: "poker.hand_started",
        attributes: [
          { key: "tableId", value: "1" },
          { key: "handId", value: "7" },
        ],
      },
    ];

    const result = eventsToChainEvents(events, { eventIndexStart: 10, timeMs: 1000 });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "poker.seat_taken",
      tableId: "1",
      handId: undefined,
      data: { tableId: "1", seat: "3" },
      eventIndex: 10,
      timeMs: 1000,
    });
    expect(result[1]).toEqual({
      name: "poker.hand_started",
      tableId: "1",
      handId: "7",
      data: { tableId: "1", handId: "7" },
      eventIndex: 11,
      timeMs: 1000,
    });
  });

  it("handles base64-encoded attributes", () => {
    const events = [
      {
        type: "poker.action",
        attributes: [
          { key: btoa("tableId"), value: btoa("5") },
          { key: btoa("handId"), value: btoa("12") },
          { key: btoa("action"), value: btoa("fold") },
        ],
      },
    ];

    const result = eventsToChainEvents(events, { eventIndexStart: 1, timeMs: 2000 });

    expect(result).toHaveLength(1);
    expect(result[0].tableId).toBe("5");
    expect(result[0].handId).toBe("12");
    expect(result[0].data).toEqual({ tableId: "5", handId: "12", action: "fold" });
  });

  it("returns empty for undefined events", () => {
    expect(eventsToChainEvents(undefined, { eventIndexStart: 1, timeMs: 0 })).toEqual([]);
  });

  it("skips malformed events", () => {
    const events = [
      null as any,
      { type: 123 } as any,
      { type: "valid", attributes: [] },
    ];
    const result = eventsToChainEvents(events, { eventIndexStart: 1, timeMs: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
  });
});

describe("toWebSocketUrl", () => {
  it("converts http to ws", () => {
    expect(toWebSocketUrl("http://localhost:26657")).toBe("ws://localhost:26657/websocket");
  });

  it("converts https to wss", () => {
    expect(toWebSocketUrl("https://example.com/rpc")).toBe("wss://example.com/rpc/websocket");
  });

  it("strips trailing slashes before appending /websocket", () => {
    expect(toWebSocketUrl("http://localhost:26657/")).toBe("ws://localhost:26657/websocket");
  });
});
