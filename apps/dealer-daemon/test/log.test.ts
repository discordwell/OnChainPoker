import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as logging from "../src/log.js";

const FIVE_MINUTES = 5 * 60_000;
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  mock.timers.enable({ apis: ["Date"], now: 0 });
  const capture = (...args: unknown[]) => void lines.push(args.join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "error", capture);
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe("rule 2: a condition that persists is logged once, then once per five minutes", () => {
  it("collapses a failure repeated every 2 s for 10 minutes into three lines with repeat counts", () => {
    for (let i = 0; i <= 300; i++) {
      logging.logError(
        `table 1 processing error for hand ${15000 + i}`,
        new Error("insufficient qualified members: have 0")
      );
      mock.timers.tick(2_000);
    }
    assert.equal(lines.length, 3, lines.join("\n"));
    assert.match(lines[0]!, /hand 15000 .*insufficient qualified members/);
    assert.match(lines[1]!, /149 more/);
    assert.match(lines[2]!, /149 more/);
  });

  it("treats info lines that differ only in numbers as one condition", () => {
    logging.log("Beacon: commit error for epoch 43: epoch_id mismatch got 43 want 44");
    mock.timers.tick(2_000);
    logging.log("Beacon: commit error for epoch 44: epoch_id mismatch got 44 want 45");
    mock.timers.tick(FIVE_MINUTES);
    logging.log("Beacon: commit error for epoch 45: epoch_id mismatch got 45 want 46");
    assert.equal(lines.length, 2, lines.join("\n"));
    assert.match(lines[1]!, /epoch 45.*1 more/);
  });

  it("keeps lines that differ in words apart", () => {
    logging.log("Automation: finalizeDeck failed: insufficient qualified members");
    logging.log("Automation: beginEpoch failed: insufficient qualified members");
    assert.equal(lines.length, 2, lines.join("\n"));
  });

  it("remembers a bounded number of conditions: after 500 others, an old one prints again", () => {
    // Letters only, so that each line is its own shape.
    const word = (n: number) => [...n.toString(20)].map((d) => String.fromCharCode(103 + parseInt(d, 20))).join("");
    logging.log("condition first persists");
    for (let i = 0; i < 500; i++) logging.log(`condition ${word(i)} persists`);
    assert.equal(lines.length, 501);

    logging.log(`condition ${word(499)} persists`);
    assert.equal(lines.length, 501, "a condition it still remembers stays limited");
    logging.log("condition first persists");
    assert.equal(lines.length, 502, "the oldest condition was forgotten, so it prints again");
  });

  it("never rate-limits progress lines", () => {
    for (let hand = 1; hand <= 5; hand++) {
      logging.logProgress(`Automation: deck finalized for table 1 hand ${hand}`);
      mock.timers.tick(2_000);
    }
    assert.equal(lines.length, 5, lines.join("\n"));
  });
});
