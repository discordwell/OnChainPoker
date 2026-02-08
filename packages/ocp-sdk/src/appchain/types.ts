export type Hex = `0x${string}`;

// All u64-like values are represented as decimal strings at the protocol boundary.
export type U64 = string;

export type TableId = U64;
export type HandId = U64;
export type EpochId = U64;

export type Address = string; // opaque: bech32 / hex / ss58 (framework-defined)
export type ValidatorId = string; // opaque

// In v1 tables are 9-max. Seats are 0..8.
export type SeatIndex = number;

// Opaque bytes used for crypto artifacts/proofs until WS3/WS5 stabilize encodings.
export type OpaqueBytes = Hex;

export type CardId = number; // 0..51

export interface TableParams {
  maxPlayers: number; // MUST be 9 in v1 (SPEC 5.1)
  smallBlind: U64;
  bigBlind: U64;
  minBuyIn: U64;
  maxBuyIn: U64;
  playerBond: U64;
  actionTimeoutSecs: number;
  dealerTimeoutSecs: number;
  rakeBps: number; // MUST be 0 in v1 unless governance enables (SPEC 5.1)
}

export interface TableState {
  tableId: TableId;
  params: TableParams;
  status: string;
  currentHandId?: HandId;
  // Optional shape for UIs; chain may expose more detailed state.
  seats?: Array<Address | null>;
}

export interface HandState {
  tableId: TableId;
  handId: HandId;
  phase: string;
  buttonSeat?: SeatIndex;
  activeSeats?: SeatIndex[];
  board?: Array<CardId | null>; // length 5, nulls for unrevealed slots
  deckCommit?: Hex;
  deckCursor?: number;
}

export interface EncShareArtifact {
  validatorId: ValidatorId;
  pkPlayer: Hex;
  encShare: Hex;
  proofEncShare: OpaqueBytes;
}

export interface PubShareArtifact {
  validatorId: ValidatorId;
  pubShare: Hex;
  proofPubShare: OpaqueBytes;
}

