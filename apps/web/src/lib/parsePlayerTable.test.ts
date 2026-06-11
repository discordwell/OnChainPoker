import { describe, expect, it } from "vitest";
import { parsePlayerTable } from "./parsePlayerTable";

describe("parsePlayerTable pot computation", () => {
  function tableWithCommits(totalCommit: unknown[]): unknown {
    return {
      id: 1,
      params: {},
      seats: [],
      hand: {
        handId: "7",
        phase: "betting",
        totalCommit,
      },
    };
  }

  it("sums string commits (LCD uint64-as-string format)", () => {
    const t = parsePlayerTable(tableWithCommits(["1000", "2500", "0"]));
    expect(t?.hand?.pot).toBe("3500");
  });

  it("sums numeric commits", () => {
    const t = parsePlayerTable(tableWithCommits([100, 200]));
    expect(t?.hand?.pot).toBe("300");
  });

  it("treats empty strings as zero", () => {
    const t = parsePlayerTable(tableWithCommits(["", "50"]));
    expect(t?.hand?.pot).toBe("50");
  });

  it("skips non-string non-number garbage instead of throwing", () => {
    const t = parsePlayerTable(tableWithCommits([{}, null, undefined, "25", true]));
    expect(t?.hand?.pot).toBe("25");
  });

  it("skips non-integer numbers (NaN, Infinity, floats) instead of throwing", () => {
    const t = parsePlayerTable(tableWithCommits([NaN, Infinity, 1.5, 30]));
    expect(t?.hand?.pot).toBe("30");
  });

  it("snake_case total_commit fallback still parses", () => {
    const t = parsePlayerTable({
      id: 2,
      params: {},
      seats: [],
      hand: { handId: "8", phase: "betting", total_commit: ["10", "15"] },
    });
    expect(t?.hand?.pot).toBe("25");
  });
});
