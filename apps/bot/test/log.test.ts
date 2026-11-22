import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logging from "../src/log.js";

const FIVE_MINUTES = 5 * 60_000;
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  vi.useFakeTimers({ now: 0 });
  const capture = (...args: unknown[]) => void lines.push(args.join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("rule 2: a condition that persists is logged once, then once per five minutes", () => {
  it("collapses a poll error repeated for 10 minutes into three lines with repeat counts", () => {
    for (let i = 1; i <= 301; i++) {
      logging.logError(`poll error (failure #${i}, next in ${2_000 * i}ms)`, new Error("Table 1 not found"));
      vi.advanceTimersByTime(2_000);
    }
    expect(lines, lines.join("\n")).toHaveLength(3);
    expect(lines[0]).toMatch(/failure #1,.*Table 1 not found/);
    expect(lines[1]).toMatch(/149 more/);
    expect(lines[2]).toMatch(/149 more/);
  });

  it("treats info lines that differ only in numbers as one condition", () => {
    logging.log("DEGRADED — 3 consecutive failures, backoff 8000ms");
    vi.advanceTimersByTime(8_000);
    logging.log("DEGRADED — 4 consecutive failures, backoff 16000ms");
    vi.advanceTimersByTime(FIVE_MINUTES);
    logging.log("DEGRADED — 5 consecutive failures, backoff 32000ms");
    expect(lines, lines.join("\n")).toHaveLength(2);
    expect(lines[1]).toMatch(/5 consecutive.*1 more/);
  });

  it("keeps lines that differ in words apart", () => {
    logging.logError("startHand failed", new Error("not enough players"));
    logging.logError("pokerRebuy failed, falling back to leave-resit", new Error("not enough players"));
    expect(lines, lines.join("\n")).toHaveLength(2);
  });

  it("never rate-limits progress lines", () => {
    for (let hand = 1; hand <= 5; hand++) {
      logging.logProgress(`Hand #${hand} preflop [??] | board=- | call (pot=30 betTo=20 toCall=10 stack=990)`);
      vi.advanceTimersByTime(2_000);
    }
    expect(lines, lines.join("\n")).toHaveLength(5);
  });
});
