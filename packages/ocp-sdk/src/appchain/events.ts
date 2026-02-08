import type { CardId, HandId, Hex, SeatIndex, TableId, U64, ValidatorId } from "./types.js";

export interface OcpEventEnvelope<TType extends string, TData extends Record<string, unknown>> {
  type: TType;
  cursor: string;
  height?: U64;
  txHash?: Hex;
  tableId?: TableId;
  handId?: HandId;
  data: TData;
}

export type TableCreatedEvent = OcpEventEnvelope<"TableCreated", { params: Record<string, unknown> }>;
export type PlayerSatEvent = OcpEventEnvelope<"PlayerSat", { seat: SeatIndex; player: string; buyIn: U64; pkPlayer: Hex }>;
export type PlayerLeftEvent = OcpEventEnvelope<"PlayerLeft", { seat: SeatIndex; player: string }>;
export type PlayerEjectedEvent = OcpEventEnvelope<"PlayerEjected", { seat: SeatIndex; player: string; reason?: string }>;

export type HandStartedEvent = OcpEventEnvelope<"HandStarted", { handId: HandId; buttonSeat: SeatIndex }>;
export type DeckFinalizedEvent = OcpEventEnvelope<"DeckFinalized", { handId: HandId; deckCommit: Hex }>;
export type HoleCardAssignedEvent = OcpEventEnvelope<"HoleCardAssigned", { handId: HandId; seat: SeatIndex; h: 0 | 1; pos: number }>;
export type StreetRevealedEvent = OcpEventEnvelope<
  "StreetRevealed",
  { handId: HandId; street: "Flop" | "Turn" | "River"; cards: CardId[] }
>;
export type HandCompletedEvent = OcpEventEnvelope<"HandCompleted", { handId: HandId }>;
export type HandAbortedEvent = OcpEventEnvelope<"HandAborted", { handId: HandId; reason?: string }>;

export type ActionAppliedEvent = OcpEventEnvelope<
  "ActionApplied",
  { handId: HandId; seat: SeatIndex; actionType: string; amount?: U64 }
>;
export type TimeoutAppliedEvent = OcpEventEnvelope<"TimeoutApplied", { handId: HandId; seat: SeatIndex; actionType: string }>;

export type ShuffleAcceptedEvent = OcpEventEnvelope<"ShuffleAccepted", { handId: HandId; round: number; shufflerId: ValidatorId }>;
export type EncShareAcceptedEvent = OcpEventEnvelope<"EncShareAccepted", { handId: HandId; pos: number; validatorId: ValidatorId }>;
export type PubShareAcceptedEvent = OcpEventEnvelope<"PubShareAccepted", { handId: HandId; pos: number; validatorId: ValidatorId }>;

export type PlayerSlashedEvent = OcpEventEnvelope<"PlayerSlashed", { player: string; amount: U64; reason?: string }>;
export type ValidatorSlashedEvent = OcpEventEnvelope<"ValidatorSlashed", { validatorId: ValidatorId; amount: U64; reason?: string }>;

export type OcpEvent =
  | TableCreatedEvent
  | PlayerSatEvent
  | PlayerLeftEvent
  | PlayerEjectedEvent
  | HandStartedEvent
  | DeckFinalizedEvent
  | HoleCardAssignedEvent
  | StreetRevealedEvent
  | HandCompletedEvent
  | HandAbortedEvent
  | ActionAppliedEvent
  | TimeoutAppliedEvent
  | ShuffleAcceptedEvent
  | EncShareAcceptedEvent
  | PubShareAcceptedEvent
  | PlayerSlashedEvent
  | ValidatorSlashedEvent
  | OcpEventEnvelope<string, Record<string, unknown>>; // forward-compatible

export interface EventFilter {
  tableId?: TableId;
  handId?: HandId;
  types?: string[];
}

export interface EventPage {
  events: OcpEvent[];
  nextCursor?: string;
}

