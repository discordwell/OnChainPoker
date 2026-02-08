import type {
  CardId,
  EpochId,
  HandId,
  Hex,
  OpaqueBytes,
  SeatIndex,
  TableId,
  TableParams,
  U64,
  ValidatorId
} from "./types.js";

export type ActionType = "Fold" | "Check" | "Call" | "Bet" | "Raise";

export type PokerAction =
  | { actionType: "Fold" }
  | { actionType: "Check" }
  | { actionType: "Call" }
  | { actionType: "Bet"; amount: U64 }
  | { actionType: "Raise"; amount: U64 };

export type PokerTableTx =
  | { type: "PokerTable.CreateTable"; value: { params: TableParams } }
  | { type: "PokerTable.Sit"; value: { tableId: TableId; seat: SeatIndex; buyIn: U64; playerBond: U64; pkPlayer: Hex } }
  | { type: "PokerTable.Leave"; value: { tableId: TableId } }
  | { type: "PokerTable.StartHand"; value: { tableId: TableId } }
  | { type: "PokerTable.Act"; value: { tableId: TableId; action: PokerAction } }
  | { type: "PokerTable.Tick"; value: { tableId: TableId } }
  | { type: "PokerTable.RequestFlop"; value: { tableId: TableId } }
  | { type: "PokerTable.RequestTurn"; value: { tableId: TableId } }
  | { type: "PokerTable.RequestRiver"; value: { tableId: TableId } }
  | { type: "PokerTable.Showdown"; value: { tableId: TableId } };

export type DealerTx =
  | { type: "Dealer.BeginEpoch"; value: { epochId: EpochId; committee: ValidatorId[]; thresholdT: number; randEpoch: OpaqueBytes } }
  | { type: "Dealer.SubmitDKGContribution"; value: { epochId: EpochId; validatorId: ValidatorId; contribution: OpaqueBytes; proof: OpaqueBytes } }
  | { type: "Dealer.FinalizeEpoch"; value: { epochId: EpochId; pkEpoch: OpaqueBytes; transcriptRoot: OpaqueBytes } }
  | { type: "Dealer.InitHand"; value: { tableId: TableId; handId: HandId; epochId: EpochId } }
  | {
      type: "Dealer.SubmitShuffle";
      value: {
        tableId: TableId;
        handId: HandId;
        round: number;
        shufflerId: ValidatorId;
        deckRootNew: OpaqueBytes;
        proofShuffle: OpaqueBytes;
      };
    }
  | { type: "Dealer.FinalizeDeck"; value: { tableId: TableId; handId: HandId; deckCommit: Hex; deckCursor?: number } }
  | { type: "Dealer.AssignHoleCardPos"; value: { tableId: TableId; handId: HandId; seat: SeatIndex; h: 0 | 1; pos: number } }
  | {
      type: "Dealer.SubmitEncShare";
      value: {
        tableId: TableId;
        handId: HandId;
        pos: number;
        validatorId: ValidatorId;
        pkPlayer: Hex;
        encShare: Hex;
        proofEncShare: OpaqueBytes;
      };
    }
  | {
      type: "Dealer.SubmitPubShare";
      value: {
        tableId: TableId;
        handId: HandId;
        pos: number;
        validatorId: ValidatorId;
        pubShare: Hex;
        proofPubShare: OpaqueBytes;
      };
    }
  | { type: "Dealer.FinalizeReveal"; value: { tableId: TableId; handId: HandId; pos: number; plaintextCard: CardId } };

export type OcpTx = PokerTableTx | DealerTx;

