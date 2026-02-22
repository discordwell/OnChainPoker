export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type TxEnvelope<TValue extends Json = Json> = {
  type: string;
  value: TValue;
  nonce?: string;
  signer?: string;
  sig?: string; // base64 (ed25519)
};

// ---- Tx values (must match apps/chain/internal/codec/tx.go json tags) ----

export type BankMintTx = { to: string; amount: number };
export type BankSendTx = { from: string; to: string; amount: number };

// ---- Auth (v0) ----

export type AuthRegisterAccountTx = {
  account: string;
  pubKey: string; // base64 (32 bytes)
};

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
  buyIn: number;
  pkPlayer?: string;
  password?: string;
};

export type PokerStartHandTx = {
  caller: string;
  tableId: number;
};

export type PokerActTx = {
  player: string;
  tableId: number;
  action: "fold" | "check" | "call" | "bet" | "raise";
  /**
   * For bet/raise only: the desired total street commitment ("BetTo"), not a delta.
   * Example: facing betTo=10 with streetCommit=2, a raise to 50 is { action:"raise", amount:50 }.
   */
  amount?: number;
};

export type PokerTickTx = {
  tableId: number;
};

export type PokerLeaveTx = {
  player: string;
  tableId: number;
};

// ---- Staking (v0) ----

// v0: staking is a stubbed on-chain validator registry (no real consensus auth yet).
export type StakingRegisterValidatorTx = {
  validatorId: string;
  pubKey: string; // base64 (32 bytes)
  power?: number;
};

export type StakingBondTx = {
  validatorId: string;
  amount: number;
};

export type StakingUnbondTx = {
  validatorId: string;
  amount: number;
};

export type StakingUnjailTx = {
  validatorId: string;
};

export type DealerBeginEpochTx = {
  /**
   * If omitted/0, the chain allocates the next epoch id deterministically.
   * (In v0 localnet, epochIds are u64 numbers in JSON.)
   */
  epochId?: number;

  committeeSize: number;
  threshold: number;

  /** Optional 32-byte beacon input (base64). */
  randEpoch?: string;

  /** Optional per-phase durations in blocks. */
  commitBlocks?: number;
  complaintBlocks?: number;
  revealBlocks?: number;
  finalizeBlocks?: number;
};

export type DealerDKGCommitTx = {
  epochId: number;
  dealerId: string;
  commitments: string[]; // base64 points (32 bytes each)
};

export type DealerDKGComplaintMissingTx = {
  epochId: number;
  complainerId: string;
  dealerId: string;
};

export type DealerDKGComplaintInvalidTx = {
  epochId: number;
  complainerId: string;
  dealerId: string;
  shareMsg: string; // base64 (opaque in v0)
};

export type DealerDKGShareRevealTx = {
  epochId: number;
  dealerId: string;
  toId: string;
  share: string; // base64 scalar (32 bytes)
};

export type DealerFinalizeEpochTx = {
  epochId: number;
};

export type DealerDKGTimeoutTx = {
  epochId: number;
};

export type DealerInitHandTx = {
  tableId: number;
  handId: number;
  epochId: number;
  deckSize?: number; // default 52
};

export type DealerSubmitShuffleTx = {
  tableId: number;
  handId: number;
  round: number;
  shufflerId: string;
  proofShuffle: string; // base64 (opaque)
};

export type DealerFinalizeDeckTx = {
  tableId: number;
  handId: number;
};

export type DealerSubmitPubShareTx = {
  tableId: number;
  handId: number;
  pos: number;
  validatorId: string;
  pubShare: string; // base64 (32 bytes)
  proofShare: string; // base64 (96 bytes)
};

export type DealerSubmitEncShareTx = {
  tableId: number;
  handId: number;
  pos: number;
  validatorId: string;
  pkPlayer: string; // base64 (32 bytes)
  encShare: string; // base64 (64 bytes u||v)
  proofEncShare: string; // base64 (160 bytes)
};

export type DealerFinalizeRevealTx = {
  tableId: number;
  handId: number;
  pos: number;
};

export type DealerTimeoutTx = {
  tableId: number;
  handId: number;
};

// ---- Queries (/abci_query paths) ----

export type AccountView = { addr: string; balance: number };

export type TableParams = {
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  actionTimeoutSecs?: number;
  dealerTimeoutSecs?: number;
  playerBond?: number;
  rakeBps?: number;
};

export type SeatView = {
  player: string;
  pk?: string;
  stack: number;
  bond?: number;
  hole: [number, number];
};

export type DealerCiphertextView = { c1: string; c2: string }; // base64 points

export type DealerPubShareView = {
  pos: number;
  validatorId: string;
  index: number;
  share: string; // base64 point
  proof: string; // base64
};

export type DealerEncShareView = {
  pos: number;
  validatorId: string;
  index: number;
  pkPlayer: string; // base64 point
  encShare: string; // base64 (64 bytes)
  proof: string; // base64
};

export type DealerRevealView = { pos: number; cardId: number };

export type DealerHandView = {
  epochId: number;
  pkHand: string; // base64 point
  deckSize: number;
  deck: DealerCiphertextView[];
  shuffleStep: number;
  finalized: boolean;
  cursor: number;
  shuffleDeadline?: number; // unix seconds
  holeSharesDeadline?: number; // unix seconds
  revealPos?: number; // 0..255; 255 = unset
  revealDeadline?: number; // unix seconds
  holePos?: number[]; // length 18; 255=unset
  pubShares?: DealerPubShareView[];
  encShares?: DealerEncShareView[];
  reveals?: DealerRevealView[];
};

export type HandView = {
  handId: number;
  phase: "shuffle" | "betting" | "awaitFlop" | "awaitTurn" | "awaitRiver" | "awaitShowdown" | "showdown" | string;
  street: "preflop" | "flop" | "turn" | "river" | string;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  actionOn: number;
  actionDeadline?: number; // unix seconds
  betTo: number;
  minRaiseSize: number;
  intervalId: number;
  lastIntervalActed: number[]; // length 9
  streetCommit: number[]; // length 9
  totalCommit: number[]; // length 9
  inHand: boolean[]; // length 9
  folded: boolean[]; // length 9
  allIn: boolean[]; // length 9
  pots?: Array<{ amount: number; eligibleSeats: number[] }>;
  deck: number[];
  deckCursor: number;
  board: number[];
  dealer?: DealerHandView;
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
