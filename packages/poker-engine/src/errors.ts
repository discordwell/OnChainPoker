export type PokerEngineErrorCode =
  | "NO_HAND"
  | "HAND_NOT_ACTIVE"
  | "OUT_OF_TURN"
  | "SEAT_EMPTY"
  | "SEAT_NOT_IN_HAND"
  | "SEAT_FOLDED"
  | "SEAT_ALL_IN"
  | "ILLEGAL_ACTION"
  | "INVALID_AMOUNT";

export class PokerEngineError extends Error {
  readonly code: PokerEngineErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PokerEngineErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PokerEngineError";
    this.code = code;
    this.details = details;
  }
}

