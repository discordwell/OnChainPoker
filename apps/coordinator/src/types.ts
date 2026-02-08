export type TableParams = {
  maxPlayers: number;
  smallBlind: string;
  bigBlind: string;
  minBuyIn: string;
  maxBuyIn: string;
};

export type TableStatus = "open" | "in_hand" | "closed";

export type TableInfo = {
  tableId: string;
  params: TableParams;
  status: TableStatus;
  updatedAtMs: number;
};

export type ChainEvent = {
  name: string;
  tableId?: string;
  handId?: string;
  eventIndex: number;
  timeMs: number;
  data?: unknown;
};

export type SeatIntent = {
  intentId: string;
  tableId: string;
  seat: number; // v1: 0..8
  player: string;
  pkPlayer?: string;
  buyIn?: string;
  bond?: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ArtifactKind = "shuffle" | "encShare" | "pubShare" | "reveal" | "other";

export type ArtifactRecord = {
  artifactId: string;
  kind: ArtifactKind;
  mime: string;
  bytes: Buffer;
  meta: Record<string, unknown>;
  createdAtMs: number;
  lastAccessAtMs: number;
};

