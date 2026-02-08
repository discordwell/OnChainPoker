export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type TxEnvelope<TValue extends Json = Json> = {
  type: string;
  value: TValue;
};

// ---- Tx values (must match apps/chain/internal/codec/tx.go json tags) ----

export type BankMintTx = { to: string; amount: number };
export type BankSendTx = { from: string; to: string; amount: number };

export type PokerCreateTableTx = {
  creator: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  actionTimeoutSecs?: number;
  dealerTimeoutSecs?: number;
  playerBond?: number;
  rakeBps?: number;
  maxPlayers?: number;
  label?: string;
};

export type PokerSitTx = {
  player: string;
  tableId: number;
  seat: number;
  buyIn: number;
  pkPlayer?: string;
};

export type PokerStartHandTx = {
  caller: string;
  tableId: number;
};

export type PokerActTx = {
  player: string;
  tableId: number;
  action: "fold" | "check" | "call" | "bet" | "raise";
  amount?: number;
};

// ---- Queries (/abci_query paths) ----

export type AccountView = { addr: string; balance: number };

export type TableParams = {
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
};

export type SeatView = {
  player: string;
  pk?: string;
  stack: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  betThisRound: number;
  actedThisRound: boolean;
  hole: [number, number];
};

export type HandView = {
  handId: number;
  phase: "Preflop" | "Flop" | "Turn" | "River" | "Showdown" | string;
  pot: number;
  deck: number[];
  deckCursor: number;
  board: number[];
  currentBet: number;
  actingSeat: number;
};

export type TableView = {
  id: number;
  creator: string;
  label?: string;
  params: TableParams;
  seats: Array<SeatView | null>; // length 9
  nextHandId: number;
  buttonSeat: number;
  hand?: HandView;
};

// ---- CometBFT results (partial) ----

export type AbciEventAttribute = {
  key: string;
  value: string;
  index?: boolean;
};

export type AbciEvent = {
  type: string;
  attributes: AbciEventAttribute[];
};

export type TxResult = {
  code: number | string;
  log?: string;
  events?: AbciEvent[];
};

export type BroadcastTxCommitResult = {
  check_tx?: TxResult;
  // CometBFT v1.0.x returns `tx_result` for broadcast_tx_commit.
  tx_result?: TxResult;
  // Older Tendermint/Comet builds used `deliver_tx`.
  deliver_tx?: TxResult;
  hash?: string;
  height?: string;
};

export type AbciQueryResult = {
  response?: {
    code?: number | string;
    log?: string;
    height?: string;
    value?: string; // base64
  };
};

// ---- WS subscription (partial) ----

export type WsSubscriptionMsg = {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  result?: any;
  params?: any;
  error?: any;
};
