import type { CardId } from "@onchainpoker/holdem-eval";

export interface GameState {
  street: "preflop" | "flop" | "turn" | "river";
  holeCards: [CardId, CardId] | null;
  board: CardId[];
  myStack: bigint;
  pot: bigint;
  betTo: bigint;
  myStreetCommit: bigint;
  toCall: bigint;
  minRaise: bigint;
  bigBlind: bigint;
  position: "early" | "middle" | "late" | "blinds";
  playersInHand: number;
  isLastToAct: boolean;
}

export interface BotAction {
  action: "fold" | "check" | "call" | "bet" | "raise";
  amount?: bigint;
}

export interface Strategy {
  name: string;
  decide(state: GameState): BotAction;
}
