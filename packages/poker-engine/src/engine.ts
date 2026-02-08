import { PokerEngineError } from "./errors.js";
import { computeSidePots } from "./pots.js";
import type { Action, Chips, HandState, Street, TableParams, TableState } from "./types.js";

function assertIntTimestamp(now: number): void {
  if (!Number.isInteger(now) || now < 0) {
    throw new PokerEngineError("ILLEGAL_ACTION", "now must be a non-negative integer timestamp (seconds).", {
      now
    });
  }
}

function cloneTableState(state: TableState): TableState {
  return {
    params: { ...state.params },
    seats: state.seats.map((s) => (s ? { ...s } : null)),
    button: state.button,
    nextHandId: state.nextHandId,
    hand: state.hand ? cloneHandState(state.hand) : null
  };
}

function cloneHandState(hand: HandState): HandState {
  return {
    ...hand,
    lastIntervalActed: hand.lastIntervalActed.slice(),
    streetCommit: hand.streetCommit.slice(),
    totalCommit: hand.totalCommit.slice(),
    inHand: hand.inHand.slice(),
    folded: hand.folded.slice(),
    allIn: hand.allIn.slice(),
    pots: hand.pots.map((p) => ({ amount: p.amount, eligibleSeats: p.eligibleSeats.slice() })),
    events: hand.events.slice()
  };
}

function seatCount9(seats: (unknown | null)[]): void {
  if (seats.length !== 9) {
    throw new PokerEngineError("ILLEGAL_ACTION", "TableState.seats must have length 9.", {
      length: seats.length
    });
  }
}

function nextOccupiedSeat(seats: readonly (unknown | null)[], fromSeat: number): number {
  for (let offset = 1; offset <= 9; offset++) {
    const s = (fromSeat + offset) % 9;
    if (seats[s] != null) return s;
  }
  return fromSeat;
}

function nextActiveInHand(hand: HandState, fromSeat: number): number | null {
  for (let offset = 1; offset <= 9; offset++) {
    const s = (fromSeat + offset) % 9;
    if (!hand.inHand[s]) continue;
    if (hand.folded[s]) continue;
    if (hand.allIn[s]) continue;
    if (needsToAct(hand, s)) return s;
  }
  return null;
}

function needsToAct(hand: HandState, seat: number): boolean {
  if (!hand.inHand[seat]) return false;
  if (hand.folded[seat]) return false;
  if (hand.allIn[seat]) return false;
  return hand.lastIntervalActed[seat] !== hand.intervalId || hand.streetCommit[seat] !== hand.betTo;
}

function countNotFolded(hand: HandState): number {
  let n = 0;
  for (let i = 0; i < 9; i++) if (hand.inHand[i] && !hand.folded[i]) n++;
  return n;
}

function countWithChips(hand: HandState, state: TableState): number {
  let n = 0;
  for (let i = 0; i < 9; i++) {
    if (!hand.inHand[i] || hand.folded[i]) continue;
    const seat = state.seats[i];
    if (seat && seat.stack > 0n) n++;
  }
  return n;
}

function toCall(hand: HandState, seat: number): Chips {
  const need = hand.betTo - hand.streetCommit[seat]!;
  return need > 0n ? need : 0n;
}

function maxCommitThisStreet(hand: HandState): Chips {
  let m = 0n;
  for (let i = 0; i < 9; i++) if (hand.streetCommit[i]! > m) m = hand.streetCommit[i]!;
  return m;
}

function secondMaxCommitThisStreet(hand: HandState, max: Chips): Chips {
  let s = 0n;
  for (let i = 0; i < 9; i++) {
    const v = hand.streetCommit[i]!;
    if (v === max) continue;
    if (v > s) s = v;
  }
  return s;
}

function returnUncalledStreetExcess(state: TableState): void {
  const hand = state.hand!;
  const max = maxCommitThisStreet(hand);
  if (max === 0n) return;
  const second = secondMaxCommitThisStreet(hand, max);
  if (second === max) return;

  // Identify the unique max seat (if more than one seat has max, no uncalled).
  let maxSeat: number | null = null;
  for (let i = 0; i < 9; i++) {
    if (hand.streetCommit[i]! !== max) continue;
    if (maxSeat != null) return;
    maxSeat = i;
  }
  if (maxSeat == null) return;

  const excess = max - second;
  if (excess <= 0n) return;

  const seatState = state.seats[maxSeat];
  if (seatState == null) return;

  // Return excess to player's stack and reduce commits.
  seatState.stack += excess;
  hand.streetCommit[maxSeat] -= excess;
  hand.totalCommit[maxSeat] -= excess;
  if (seatState.stack > 0n) hand.allIn[maxSeat] = false;
}

function advanceStreet(state: TableState, now: number): void {
  const hand = state.hand!;
  const nextStreet: Street =
    hand.street === "preflop"
      ? "flop"
      : hand.street === "flop"
        ? "turn"
        : hand.street === "turn"
          ? "river"
          : "river";

  hand.street = nextStreet;
  hand.betTo = 0n;
  hand.minRaiseSize = state.params.bigBlind;
  hand.intervalId = 0;

  for (let i = 0; i < 9; i++) {
    hand.streetCommit[i] = 0n;
    hand.lastIntervalActed[i] = -1;
  }

  // Postflop action starts left of the button (first active seat clockwise).
  const start = nextOccupiedSeat(state.seats, hand.button);
  hand.actionOn = nextActiveInHand(hand, start - 1);
  hand.actionDeadlineTs = hand.actionOn == null ? null : now + state.params.actionTimeoutSecs;
  hand.events.push({ kind: "StreetAdvanced", street: nextStreet });
}

function reachShowdown(state: TableState): void {
  const hand = state.hand!;
  hand.phase = "showdown";
  hand.actionOn = null;
  hand.actionDeadlineTs = null;

  const eligible = hand.inHand.map((inHand, i) => inHand && !hand.folded[i]);
  hand.pots = computeSidePots(hand.totalCommit, eligible);
  hand.events.push({ kind: "ShowdownReached" });
}

function completeByFolds(state: TableState): void {
  const hand = state.hand!;
  let winner: number | null = null;
  for (let i = 0; i < 9; i++) {
    if (hand.inHand[i] && !hand.folded[i]) {
      winner = i;
      break;
    }
  }
  if (winner == null) return;

  // Ensure no uncalled excess remains before settlement.
  returnUncalledStreetExcess(state);

  // Award all committed chips to winner.
  let potTotal = 0n;
  for (let i = 0; i < 9; i++) potTotal += hand.totalCommit[i]!;

  const winnerSeat = state.seats[winner];
  if (winnerSeat == null) return;
  winnerSeat.stack += potTotal;

  // Clear escrow.
  for (let i = 0; i < 9; i++) {
    hand.streetCommit[i] = 0n;
    hand.totalCommit[i] = 0n;
  }

  hand.phase = "complete";
  hand.winnerSeat = winner;
  hand.actionOn = null;
  hand.actionDeadlineTs = null;
  hand.pots = [];
  hand.events.push({ kind: "HandCompleted", reason: "all-folded" });
}

function validateRaiseAllowed(hand: HandState, seat: number): void {
  if (hand.lastIntervalActed[seat] === hand.intervalId) {
    throw new PokerEngineError(
      "ILLEGAL_ACTION",
      "Raise not allowed: player has already acted since the last full raise.",
      { seat, intervalId: hand.intervalId }
    );
  }
}

function applyBetTo(state: TableState, seat: number, desiredCommit: Chips): void {
  const hand = state.hand!;
  const seatState = state.seats[seat]!;

  if (desiredCommit <= hand.streetCommit[seat]!) {
    throw new PokerEngineError("INVALID_AMOUNT", "BetTo amount must exceed current street commitment.", {
      seat,
      desiredCommit,
      current: hand.streetCommit[seat]
    });
  }

  const maxCommit = hand.streetCommit[seat]! + seatState.stack;
  if (desiredCommit > maxCommit) {
    throw new PokerEngineError("INVALID_AMOUNT", "BetTo amount exceeds available chips.", {
      seat,
      desiredCommit,
      maxCommit
    });
  }

  const currentBetTo = hand.betTo;
  if (desiredCommit <= currentBetTo) {
    throw new PokerEngineError("ILLEGAL_ACTION", "BetTo must exceed current betTo (use Call/Check when not raising).", {
      seat,
      desiredCommit,
      betTo: currentBetTo
    });
  }

  const isAllIn = desiredCommit === maxCommit;
  validateRaiseAllowed(hand, seat);

  const raiseSize = desiredCommit - currentBetTo;
  const minBet = state.params.bigBlind;

  if (currentBetTo === 0n) {
    // Opening bet on this street.
    if (desiredCommit < minBet && !isAllIn) {
      throw new PokerEngineError("ILLEGAL_ACTION", "Bet size below big blind; only allowed if all-in.", {
        seat,
        desiredCommit,
        minBet
      });
    }

    // Any opening bet creates a new betting interval, even if it's a short all-in.
    hand.intervalId += 1;
    hand.lastIntervalActed[seat] = hand.intervalId;
    hand.minRaiseSize = desiredCommit >= minBet ? desiredCommit : minBet;
    hand.betTo = desiredCommit;
  } else {
    // Raise over an existing bet.
    if (raiseSize < hand.minRaiseSize) {
      if (!isAllIn) {
        throw new PokerEngineError("ILLEGAL_ACTION", "Raise size below minimum; only allowed if all-in.", {
          seat,
          raiseSize,
          minRaiseSize: hand.minRaiseSize
        });
      }
      // Under-raise (all-in) does not create a new interval and does not update minRaiseSize.
      hand.lastIntervalActed[seat] = hand.intervalId;
      hand.betTo = desiredCommit;
    } else {
      // Full raise: open a new interval and update minimum raise size.
      hand.intervalId += 1;
      hand.minRaiseSize = raiseSize;
      hand.betTo = desiredCommit;
      hand.lastIntervalActed[seat] = hand.intervalId;
    }
  }

  const delta = desiredCommit - hand.streetCommit[seat]!;
  seatState.stack -= delta;
  hand.streetCommit[seat] += delta;
  hand.totalCommit[seat] += delta;
  if (seatState.stack === 0n) hand.allIn[seat] = true;
}

function applyCall(state: TableState, seat: number): void {
  const hand = state.hand!;
  const seatState = state.seats[seat]!;
  const need = toCall(hand, seat);
  if (need === 0n) {
    throw new PokerEngineError("ILLEGAL_ACTION", "Call is not legal when facing 0.", { seat });
  }

  const pay = seatState.stack >= need ? need : seatState.stack;
  seatState.stack -= pay;
  hand.streetCommit[seat] += pay;
  hand.totalCommit[seat] += pay;
  if (seatState.stack === 0n) hand.allIn[seat] = true;

  hand.lastIntervalActed[seat] = hand.intervalId;
}

function applyCheck(hand: HandState, seat: number): void {
  const need = toCall(hand, seat);
  if (need !== 0n) {
    throw new PokerEngineError("ILLEGAL_ACTION", "Check is not legal when facing a bet.", { seat, need });
  }
  hand.lastIntervalActed[seat] = hand.intervalId;
}

function applyFold(hand: HandState, seat: number): void {
  hand.folded[seat] = true;
  hand.lastIntervalActed[seat] = hand.intervalId;
}

function streetComplete(hand: HandState): boolean {
  for (let i = 0; i < 9; i++) {
    if (!hand.inHand[i] || hand.folded[i] || hand.allIn[i]) continue;
    if (hand.streetCommit[i] !== hand.betTo) return false;
    if (hand.lastIntervalActed[i] !== hand.intervalId) return false;
  }
  return true;
}

function maybeAdvance(state: TableState, now: number): void {
  const hand = state.hand!;

  const remaining = countNotFolded(hand);
  if (remaining <= 1) {
    completeByFolds(state);
    return;
  }

  if (!streetComplete(hand)) {
    const next = nextActiveInHand(hand, hand.actionOn ?? 0);
    hand.actionOn = next;
    hand.actionDeadlineTs = next == null ? null : now + state.params.actionTimeoutSecs;
    return;
  }

  // End of betting street: return any uncalled excess, then advance.
  returnUncalledStreetExcess(state);

  if (hand.street === "river") {
    reachShowdown(state);
    return;
  }

  // If fewer than 2 contenders still have chips, there will be no further betting (runout to showdown).
  if (countWithChips(hand, state) < 2) {
    reachShowdown(state);
    return;
  }

  advanceStreet(state, now);
}

export function createTableState(params: TableParams): TableState {
  if (params.smallBlind <= 0n || params.bigBlind <= 0n || params.smallBlind >= params.bigBlind) {
    throw new PokerEngineError("ILLEGAL_ACTION", "Invalid blind parameters.", {
      smallBlind: params.smallBlind,
      bigBlind: params.bigBlind
    });
  }
  if (!Number.isInteger(params.actionTimeoutSecs) || params.actionTimeoutSecs <= 0) {
    throw new PokerEngineError("ILLEGAL_ACTION", "actionTimeoutSecs must be a positive integer.", {
      actionTimeoutSecs: params.actionTimeoutSecs
    });
  }
  if (!Number.isInteger(params.rakeBps) || params.rakeBps < 0) {
    throw new PokerEngineError("ILLEGAL_ACTION", "rakeBps must be an integer >= 0.", { rakeBps: params.rakeBps });
  }

  return {
    params: { ...params },
    seats: Array.from({ length: 9 }, () => null),
    button: null,
    nextHandId: 1,
    hand: null
  };
}

export function sit(state: TableState, seat: number, playerId: string, stack: Chips): TableState {
  seatCount9(state.seats);
  if (seat < 0 || seat > 8) throw new PokerEngineError("ILLEGAL_ACTION", "seat must be 0..8", { seat });
  if (state.seats[seat] != null) throw new PokerEngineError("ILLEGAL_ACTION", "seat already occupied", { seat });
  if (stack < 0n) throw new PokerEngineError("ILLEGAL_ACTION", "stack must be >= 0", { stack });
  const s = cloneTableState(state);
  s.seats[seat] = { status: "seated", playerId, stack };
  return s;
}

export function startHand(state: TableState, now: number): TableState {
  assertIntTimestamp(now);
  seatCount9(state.seats);

  const activeSeats: number[] = [];
  for (let i = 0; i < 9; i++) {
    const seat = state.seats[i];
    if (seat && seat.stack > 0n) activeSeats.push(i);
  }
  if (activeSeats.length < 2) {
    throw new PokerEngineError("ILLEGAL_ACTION", "Need at least 2 funded seats to start a hand.", {
      activeSeats: activeSeats.length
    });
  }

  const s = cloneTableState(state);
  const handId = s.nextHandId++;

  // Advance button to next occupied (funded) seat.
  let button: number;
  if (s.button == null) {
    // First hand: choose the lowest-index funded seat for determinism.
    button = activeSeats[0]!;
  } else {
    const prevButton = s.button;
    button = prevButton;
    for (let i = 0; i < 9; i++) {
      const cand = (prevButton + 1 + i) % 9;
      const seat = s.seats[cand];
      if (seat && seat.stack > 0n) {
        button = cand;
        break;
      }
    }
  }
  s.button = button;

  const isHeadsUp = activeSeats.length === 2;
  const smallBlindSeat = isHeadsUp ? button : nextOccupiedSeat(s.seats, button);
  const bigBlindSeat = nextOccupiedSeat(s.seats, smallBlindSeat);

  const inHand = Array.from({ length: 9 }, (_, i) => s.seats[i] != null && (s.seats[i]!.stack > 0n));
  const folded = Array.from({ length: 9 }, () => false);
  const allIn = Array.from({ length: 9 }, (_, i) => false);
  const streetCommit = Array.from({ length: 9 }, () => 0n);
  const totalCommit = Array.from({ length: 9 }, () => 0n);
  const lastIntervalActed = Array.from({ length: 9 }, () => -1);

  // Post blinds (all-in if short).
  const sbSeat = s.seats[smallBlindSeat]!;
  const bbSeat = s.seats[bigBlindSeat]!;

  const sbPay = sbSeat.stack >= s.params.smallBlind ? s.params.smallBlind : sbSeat.stack;
  const bbPay = bbSeat.stack >= s.params.bigBlind ? s.params.bigBlind : bbSeat.stack;

  sbSeat.stack -= sbPay;
  bbSeat.stack -= bbPay;
  streetCommit[smallBlindSeat] += sbPay;
  totalCommit[smallBlindSeat] += sbPay;
  streetCommit[bigBlindSeat] += bbPay;
  totalCommit[bigBlindSeat] += bbPay;

  if (sbSeat.stack === 0n) allIn[smallBlindSeat] = true;
  if (bbSeat.stack === 0n) allIn[bigBlindSeat] = true;

  const betTo = bbPay;
  const minRaiseSize = s.params.bigBlind;

  const hand: HandState = {
    handId,
    phase: "betting",
    street: "preflop",
    button,
    smallBlindSeat,
    bigBlindSeat,
    actionOn: null,
    actionDeadlineTs: null,
    betTo,
    minRaiseSize,
    intervalId: 0,
    lastIntervalActed,
    streetCommit,
    totalCommit,
    inHand,
    folded,
    allIn,
    pots: [],
    winnerSeat: null,
    events: []
  };

  s.hand = hand;
  hand.events.push({ kind: "HandStarted", handId, button, smallBlindSeat, bigBlindSeat });

  // Preflop action starts left of the big blind.
  hand.actionOn = nextActiveInHand(hand, bigBlindSeat);
  hand.actionDeadlineTs = hand.actionOn == null ? null : now + s.params.actionTimeoutSecs;

  // If no action is possible (everyone all-in), go straight to showdown.
  if (hand.actionOn == null) reachShowdown(s);

  return s;
}

export function applyAction(state: TableState, action: Action, now: number): TableState {
  assertIntTimestamp(now);
  seatCount9(state.seats);

  if (state.hand == null) throw new PokerEngineError("NO_HAND", "No active hand.");
  if (state.hand.phase !== "betting") throw new PokerEngineError("HAND_NOT_ACTIVE", "Hand is not in betting phase.");

  const s = cloneTableState(state);
  const hand = s.hand!;

  const seat = action.seat;
  if (seat < 0 || seat > 8) throw new PokerEngineError("ILLEGAL_ACTION", "seat must be 0..8", { seat });
  if (s.seats[seat] == null) throw new PokerEngineError("SEAT_EMPTY", "Seat is empty.", { seat });
  if (!hand.inHand[seat]) throw new PokerEngineError("SEAT_NOT_IN_HAND", "Seat is not in the hand.", { seat });
  if (hand.folded[seat]) throw new PokerEngineError("SEAT_FOLDED", "Seat has folded.", { seat });
  if (hand.allIn[seat]) throw new PokerEngineError("SEAT_ALL_IN", "Seat is all-in.", { seat });
  if (hand.actionOn !== seat) {
    throw new PokerEngineError("OUT_OF_TURN", "Action is out of turn.", {
      seat,
      actionOn: hand.actionOn
    });
  }

  switch (action.kind) {
    case "Fold":
      applyFold(hand, seat);
      break;
    case "Check":
      applyCheck(hand, seat);
      break;
    case "Call":
      applyCall(s, seat);
      break;
    case "BetTo":
      applyBetTo(s, seat, action.amount);
      break;
    default:
      throw new PokerEngineError("ILLEGAL_ACTION", "Unknown action kind.", { action });
  }

  hand.events.push({ kind: "ActionApplied", seat, action });
  maybeAdvance(s, now);
  return s;
}

export function applyTick(state: TableState, now: number): TableState {
  assertIntTimestamp(now);
  seatCount9(state.seats);

  const hand = state.hand;
  if (hand == null || hand.phase !== "betting" || hand.actionOn == null || hand.actionDeadlineTs == null) return state;
  if (now < hand.actionDeadlineTs) return state;

  const seat = hand.actionOn;
  const need = toCall(hand, seat);
  const defaultAction: Action = need === 0n ? { kind: "Check", seat } : { kind: "Fold", seat };

  const s = applyAction(state, defaultAction, now);
  s.hand!.events.push({
    kind: "TimeoutApplied",
    seat,
    defaultAction: need === 0n ? "Check" : "Fold"
  });
  return s;
}

export function abortHand(state: TableState, reason: string, now: number): TableState {
  assertIntTimestamp(now);
  seatCount9(state.seats);
  if (state.hand == null) throw new PokerEngineError("NO_HAND", "No active hand.");

  const s = cloneTableState(state);
  const hand = s.hand!;

  if (hand.phase === "complete" || hand.phase === "aborted") return s;

  // Refund committed chips.
  for (let i = 0; i < 9; i++) {
    const seat = s.seats[i];
    if (!seat) continue;

    const committed = hand.totalCommit[i]!;
    const isBlindSeat = i === hand.smallBlindSeat || i === hand.bigBlindSeat;

    if (isBlindSeat && !s.params.refundBlindsOnAbort) {
      // Keep blinds committed (goes nowhere in this library, but caller can route elsewhere).
      continue;
    }

    seat.stack += committed;
    hand.totalCommit[i] = 0n;
    hand.streetCommit[i] = 0n;
  }

  hand.phase = "aborted";
  hand.actionOn = null;
  hand.actionDeadlineTs = null;
  hand.pots = [];
  hand.winnerSeat = null;
  hand.events.push({ kind: "HandAborted", reason });
  return s;
}

export function legalActions(state: TableState): Action[] {
  const hand = state.hand;
  if (hand == null || hand.phase !== "betting" || hand.actionOn == null) return [];

  const seat = hand.actionOn;
  if (seat == null) return [];
  if (!hand.inHand[seat] || hand.folded[seat] || hand.allIn[seat]) return [];

  const seatState = state.seats[seat];
  if (seatState == null) return [];

  const actions: Action[] = [{ kind: "Fold", seat }];
  const need = toCall(hand, seat);
  const canRaise = hand.lastIntervalActed[seat] !== hand.intervalId;

  if (need === 0n) {
    actions.push({ kind: "Check", seat });

    if (seatState.stack > 0n && canRaise) {
      const minBet = state.params.bigBlind;
      const maxCommit = hand.streetCommit[seat]! + seatState.stack;
      const betTo = maxCommit >= minBet ? minBet : maxCommit; // all-in if below min bet
      if (betTo > 0n) actions.push({ kind: "BetTo", seat, amount: betTo });
      if (maxCommit > betTo) actions.push({ kind: "BetTo", seat, amount: maxCommit });
    }

    return actions;
  }

  actions.push({ kind: "Call", seat });

  if (!canRaise || seatState.stack === 0n) return actions;

  const maxCommit = hand.streetCommit[seat]! + seatState.stack;
  if (maxCommit <= hand.betTo) return actions;

  const minRaiseTo = hand.betTo + hand.minRaiseSize;
  if (maxCommit >= minRaiseTo) actions.push({ kind: "BetTo", seat, amount: minRaiseTo });
  actions.push({ kind: "BetTo", seat, amount: maxCommit }); // all-in (possibly under-raise)
  return actions;
}

export function totalChipsOnTable(state: TableState): Chips {
  let sum = 0n;
  for (const s of state.seats) if (s) sum += s.stack;
  if (state.hand) {
    for (let i = 0; i < 9; i++) sum += state.hand.totalCommit[i]!;
  }
  return sum;
}
