import type { HandResult } from "../components/PokerTable";

export type TableInfo = {
  tableId: string;
  label?: string;
  params: {
    maxPlayers: number;
    smallBlind: string;
    bigBlind: string;
    minBuyIn: string;
    maxBuyIn: string;
    passwordHash?: string;
  };
  status: "open" | "in_hand" | "closed";
  updatedAtMs: number;
};

export type SeatIntent = {
  intentId: string;
  tableId: string;
  seat: number;
  player: string;
  pkPlayer?: string;
  buyIn?: string;
  bond?: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type HealthResponse = {
  ok: boolean;
  name: string;
  chainAdapter: string;
  nowMs: number;
};

export type QueryState<T> = {
  loading: boolean;
  data: T | null;
  error: string | null;
};

export type SeatSubmitState = {
  kind: "idle" | "pending" | "success" | "error";
  message: string | null;
};

export type PlayerTxState = {
  kind: "idle" | "pending" | "success" | "error";
  message: string | null;
};

export type PlayerWalletStatus = "disconnected" | "connecting" | "connected" | "error";

export type PlayerWalletState = {
  status: PlayerWalletStatus;
  address: string;
  chainId: string;
  error: string | null;
};

export type PlayerSeatForm = {
  buyIn: string;
  password: string;
};

export type PlayerActionForm = {
  action: "fold" | "check" | "call" | "bet" | "raise";
  amount: string;
};

export type CreateTableForm = {
  label: string;
  smallBlind: string;
  bigBlind: string;
  minBuyIn: string;
  maxBuyIn: string;
  maxPlayers: string;
  password: string;
  actionTimeoutSecs: string;
  dealerTimeoutSecs: string;
  playerBond: string;
  rakeBps: string;
};

export type LobbyFilter = {
  search: string;
  status: "all" | "open" | "in_hand";
  password: "all" | "open" | "protected";
  sort: "id-asc" | "id-desc" | "blinds-asc" | "blinds-desc";
};

export type WsStatus = "connecting" | "open" | "closed" | "error";

export type KeplrLike = {
  enable: (chainId: string) => Promise<void>;
  experimentalSuggestChain?: (chainInfo: unknown) => Promise<void>;
  getOfflineSignerAuto?: (chainId: string) => Promise<unknown> | unknown;
  getOfflineSigner?: (chainId: string) => Promise<unknown> | unknown;
  getKey: (chainId: string) => Promise<{ bech32Address: string }>;
};

export type WindowWithKeplr = Window & { keplr?: KeplrLike };

export type SeatFormState = {
  player: string;
  seat: string;
  buyIn: string;
  bond: string;
  pkPlayer: string;
};

export type ChatMsg = {
  sender: string;
  text: string;
  timeMs: number;
};

export type KeyState = "none" | "locked" | "unlocked";

export type { HandResult };
