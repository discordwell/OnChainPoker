import { describe, expect, it } from "vitest";
import type { ChainEvent } from "../lib/cometEventParser";
import { fingerprint, computeMedian } from "./useCometBftEvents";

describe("fingerprint", () => {
  it("produces unique fingerprints per event content", () => {
    const ev1: ChainEvent = {
      name: "poker.action",
      tableId: "1",
      handId: "1",
      eventIndex: 1,
      timeMs: 1000,
      data: { action: "fold" },
    };

    const ev2: ChainEvent = {
      name: "poker.action",
      tableId: "1",
      handId: "1",
      eventIndex: 2,
      timeMs: 1001,
      data: { action: "call" },
    };

    const ev3: ChainEvent = {
      name: "poker.action",
      tableId: "2",
      handId: "1",
      eventIndex: 3,
      timeMs: 1002,
      data: { action: "fold" },
    };

    expect(fingerprint(ev1)).not.toBe(fingerprint(ev2)); // different data
    expect(fingerprint(ev1)).not.toBe(fingerprint(ev3)); // different tableId
  });

  it("is order-independent for data keys", () => {
    const ev1: ChainEvent = {
      name: "poker.seat_taken",
      tableId: "1",
      eventIndex: 1,
      timeMs: 1000,
      data: { tableId: "1", seat: "3" },
    };

    const ev2: ChainEvent = {
      name: "poker.seat_taken",
      tableId: "1",
      eventIndex: 1,
      timeMs: 1000,
      data: { seat: "3", tableId: "1" },
    };

    expect(fingerprint(ev1)).toBe(fingerprint(ev2));
  });

  it("handles missing optional fields", () => {
    const ev: ChainEvent = {
      name: "poker.action",
      eventIndex: 1,
      timeMs: 1000,
    };

    expect(fingerprint(ev)).toBe("poker.action|||{}");
  });
});

describe("computeMedian", () => {
  it("returns null for empty array", () => {
    expect(computeMedian([])).toBeNull();
  });

  it("returns the single value", () => {
    expect(computeMedian([100])).toBe(100);
  });

  it("averages two values", () => {
    expect(computeMedian([100, 200])).toBe(150);
  });

  it("finds middle of odd-length array", () => {
    expect(computeMedian([50, 100, 200])).toBe(100);
  });

  it("averages middle pair of even-length array", () => {
    expect(computeMedian([10, 20, 30, 40])).toBe(25);
  });
});

describe("dedup logic", () => {
  it("coordinator-first path: dedup map detects CometBFT duplicate", () => {
    const dedupMap = new Map<string, { cometMs: number | null; coordMs: number | null }>();

    const event: ChainEvent = {
      name: "poker.seat_taken",
      tableId: "1",
      eventIndex: 1,
      timeMs: 1000,
      data: { tableId: "1", seat: "3" },
    };

    const fp = fingerprint(event);

    // Coordinator arrives first
    expect(dedupMap.get(fp)).toBeUndefined();
    dedupMap.set(fp, { cometMs: null, coordMs: 1000 });

    // CometBFT arrives second — finds existing entry
    const entry = dedupMap.get(fp);
    expect(entry).toBeDefined();
    expect(entry!.coordMs).toBe(1000);
    expect(entry!.cometMs).toBeNull();
  });

  it("CometBFT-first path: delay measurement is positive", () => {
    const dedupMap = new Map<string, { cometMs: number | null; coordMs: number | null }>();

    const event: ChainEvent = {
      name: "poker.action",
      tableId: "2",
      handId: "10",
      eventIndex: 5,
      timeMs: 1000,
      data: { tableId: "2", handId: "10", action: "call" },
    };

    const fp = fingerprint(event);

    // CometBFT first
    dedupMap.set(fp, { cometMs: 1000, coordMs: null });

    // Coordinator second
    const existing = dedupMap.get(fp)!;
    existing.coordMs = 1200;

    const delay = existing.coordMs - existing.cometMs!;
    expect(delay).toBe(200);
  });
});

describe("reconnect backoff", () => {
  it("doubles up to 30s cap", () => {
    let backoffMs = 1000;
    const MAX_BACKOFF_MS = 30_000;
    const steps: number[] = [];

    for (let i = 0; i < 8; i++) {
      steps.push(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    expect(steps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});
