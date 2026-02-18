import assert from "node:assert/strict";
import test from "node:test";

import { expectedRevealPos, normalizePhase } from "../play_hand_cosmos.mjs";

test("play_hand_cosmos helpers: normalizePhase maps chain values", () => {
  assert.equal(normalizePhase("hand_phase_await_flop"), "awaitFlop");
  assert.equal(normalizePhase("await_showdown"), "awaitShowdown");
  assert.equal(normalizePhase("betting"), "betting");
  assert.equal(normalizePhase("custom_phase"), "custom_phase");
});

test("play_hand_cosmos helpers: expectedRevealPos prioritizes explicit reveal_pos", () => {
  const table = {
    hand: {
      phase: "hand_phase_await_turn",
      board: [12],
      dealer: {
        reveal_pos: 9,
        cursor: 1,
      },
    },
  };
  assert.equal(expectedRevealPos(table), 9);
});

test("play_hand_cosmos helpers: expectedRevealPos uses cursor + board length for streets", () => {
  const table = {
    hand: {
      phase: "hand_phase_await_river",
      board: [10, 11, 12],
      dealer: {
        cursor: 4,
        reveal_pos: 255,
      },
    },
  };
  assert.equal(expectedRevealPos(table), 7);
});

test("play_hand_cosmos helpers: expectedRevealPos finds next unrevealed showdown hole card", () => {
  const holePos = new Array(18).fill(255);
  holePos[0] = 3;
  holePos[1] = 7;
  holePos[2] = 2;
  holePos[3] = 5;

  const inHand = [true, true, false, false, false, false, false, false, false];
  const folded = [false, false, false, false, false, false, false, false, false];

  const table = {
    hand: {
      phase: "hand_phase_await_showdown",
      in_hand: inHand,
      folded,
      dealer: {
        hole_pos: holePos,
        reveals: [{ pos: 2 }],
        reveal_pos: 255,
      },
    },
  };
  assert.equal(expectedRevealPos(table), 3);
});
