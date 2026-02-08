import assert from "node:assert/strict";
import test from "node:test";
import {
  PokerEngineError,
  applyAction,
  applyTick,
  createTableState,
  legalActions,
  sit,
  startHand,
  totalChipsOnTable
} from "../src/index.js";

test("engine: rejects out-of-turn actions", () => {
  let s = createTableState({
    smallBlind: 5n,
    bigBlind: 10n,
    actionTimeoutSecs: 30,
    rakeBps: 0,
    refundBlindsOnAbort: true
  });
  s = sit(s, 0, "A", 100n);
  s = sit(s, 1, "B", 100n);
  s = startHand(s, 0);

  const actionOn = s.hand!.actionOn!;
  const wrongSeat = actionOn === 0 ? 1 : 0;
  assert.throws(() => applyAction(s, { kind: "Check", seat: wrongSeat }, 1), (e) => {
    assert.ok(e instanceof PokerEngineError);
    return e.code === "OUT_OF_TURN";
  });
});

test("engine: timeout defaults to check if legal else fold", () => {
  let s = createTableState({
    smallBlind: 5n,
    bigBlind: 10n,
    actionTimeoutSecs: 10,
    rakeBps: 0,
    refundBlindsOnAbort: true
  });
  s = sit(s, 0, "A", 100n);
  s = sit(s, 1, "B", 100n);
  s = startHand(s, 0);

  // Force action to a spot where check is legal: complete SB and let BB check.
  const sb = s.hand!.smallBlindSeat;
  const bb = s.hand!.bigBlindSeat;

  // Preflop: first actor is SB (heads-up).
  s = applyAction(s, { kind: "Call", seat: sb }, 1);

  // Now BB faces 0, and we tick past deadline to auto-check.
  const deadline = s.hand!.actionDeadlineTs!;
  s = applyTick(s, deadline);
  assert.equal(s.hand!.street, "flop"); // street advanced after check-around in heads-up

  // Start of flop betting: BB acts first (heads-up). Let BB bet and SB time out to fold.
  const bbAct = s.hand!.actionOn!;
  const bet = legalActions(s).find((a) => a.kind === "BetTo")!;
  s = applyAction(s, bet, deadline + 1);
  const foldDeadline = s.hand!.actionDeadlineTs!;
  s = applyTick(s, foldDeadline);
  assert.equal(s.hand!.phase, "complete");
  assert.equal(s.hand!.winnerSeat, bbAct);
});

test("engine: chip conservation invariant under random legal play", () => {
  let s = createTableState({
    smallBlind: 5n,
    bigBlind: 10n,
    actionTimeoutSecs: 30,
    rakeBps: 0,
    refundBlindsOnAbort: true
  });
  for (let i = 0; i < 6; i++) s = sit(s, i, `P${i}`, BigInt(100 + i * 10));

  const initial = totalChipsOnTable(s);
  s = startHand(s, 0);

  let now = 1;
  for (let steps = 0; steps < 500 && s.hand && s.hand.phase === "betting"; steps++) {
    assert.equal(totalChipsOnTable(s), initial);

    const actions = legalActions(s);
    assert.ok(actions.length > 0);
    // Deterministic "random": pick an action based on now.
    const a = actions[now % actions.length]!;
    s = applyAction(s, a, now);
    now += 1;
  }

  assert.equal(totalChipsOnTable(s), initial);
  assert.ok(s.hand == null || s.hand.phase !== "betting");
});

test("engine: short all-in opening bet still allows raises by earlier checkers", () => {
  let s = createTableState({
    smallBlind: 5n,
    bigBlind: 10n,
    actionTimeoutSecs: 30,
    rakeBps: 0,
    refundBlindsOnAbort: true
  });
  // 3-handed: button will be seat0 on first hand (lowest funded).
  s = sit(s, 0, "BTN", 12n);
  s = sit(s, 1, "SB", 100n);
  s = sit(s, 2, "BB", 100n);
  s = startHand(s, 0);

  const btn = s.hand!.button;
  const sb = s.hand!.smallBlindSeat;
  const bb = s.hand!.bigBlindSeat;
  assert.equal(btn, 0);
  assert.equal(sb, 1);
  assert.equal(bb, 2);

  // Preflop: BTN calls (leaves BTN with < BB behind), SB calls, BB checks -> flop.
  s = applyAction(s, { kind: "Call", seat: 0 }, 1);
  s = applyAction(s, { kind: "Call", seat: 1 }, 2);
  s = applyAction(s, { kind: "Check", seat: 2 }, 3);
  assert.equal(s.hand!.street, "flop");
  assert.equal(s.hand!.actionOn, 1);

  // Flop: SB checks, BB checks, BTN bets all-in 2 (< big blind).
  s = applyAction(s, { kind: "Check", seat: 1 }, 4);
  s = applyAction(s, { kind: "Check", seat: 2 }, 5);
  s = applyAction(s, { kind: "BetTo", seat: 0, amount: 2n }, 6);

  // Action returns to SB, who already checked; SB should be allowed to raise.
  assert.equal(s.hand!.actionOn, 1);
  const acts = legalActions(s);
  assert.ok(acts.some((a) => a.kind === "BetTo"), "expected a raise option after short opening bet");
});
