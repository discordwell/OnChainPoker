export type Chips = bigint;

export type Street = "preflop" | "flop" | "turn" | "river";

export type HandPhase = "betting" | "showdown" | "complete" | "aborted";

export type SeatStatus = "empty" | "seated";

export interface SeatState {
  status: "seated";
  playerId: string;
  stack: Chips;
}

export interface TableParams {
  smallBlind: Chips;
  bigBlind: Chips;
  actionTimeoutSecs: number;
  rakeBps: number; // MUST be 0 in v1 unless explicitly enabled.

  // Abort/refund configuration (SPEC 8.2). v1 default: refund blinds too.
  refundBlindsOnAbort: boolean;
}

export interface Pot {
  amount: Chips;
  eligibleSeats: number[]; // Seats that can win this pot (not folded, and contributed to this tier).
}

export type Action =
  | { kind: "Fold"; seat: number }
  | { kind: "Check"; seat: number }
  | { kind: "Call"; seat: number }
  | { kind: "BetTo"; seat: number; amount: Chips };

export type EngineEvent =
  | { kind: "HandStarted"; handId: number; button: number; smallBlindSeat: number; bigBlindSeat: number }
  | { kind: "ActionApplied"; seat: number; action: Action }
  | { kind: "TimeoutApplied"; seat: number; defaultAction: "Check" | "Fold" }
  | { kind: "StreetAdvanced"; street: Street }
  | { kind: "ShowdownReached" }
  | { kind: "HandCompleted"; reason: "all-folded" }
  | { kind: "HandAborted"; reason: string };

export interface HandState {
  handId: number;
  phase: HandPhase;
  street: Street;

  // Positional state (0..8).
  button: number;
  smallBlindSeat: number;
  bigBlindSeat: number;

  // Betting state.
  actionOn: number | null;
  actionDeadlineTs: number | null; // Integer unix timestamp seconds.

  betTo: Chips; // Current highest street contribution.
  minRaiseSize: Chips; // Minimum increment for a full raise.

  intervalId: number; // Increments on full raises (and full bets postflop).
  lastIntervalActed: number[]; // -1 means has not acted this street.

  streetCommit: Chips[]; // Amount committed this street.
  totalCommit: Chips[]; // Amount committed this hand (escrowed in pot).

  inHand: boolean[];
  folded: boolean[];
  allIn: boolean[];

  // Populated when phase is showdown/complete (purely derived from totalCommit+folded).
  pots: Pot[];

  // When complete by folds, this is the winner (pots are awarded immediately).
  winnerSeat: number | null;

  // Append-only deterministic log (caller can translate to chain events).
  events: EngineEvent[];
}

export interface TableState {
  params: TableParams;
  seats: (SeatState | null)[]; // length 9
  button: number | null; // dealer button for the *next* hand (advances on startHand)
  nextHandId: number;
  hand: HandState | null;
}

