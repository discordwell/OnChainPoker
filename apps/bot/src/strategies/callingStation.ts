import type { GameState, BotAction, Strategy } from "../strategy.js";

export class CallingStation implements Strategy {
  readonly name = "calling-station";

  decide(state: GameState): BotAction {
    if (state.toCall === 0n) {
      return { action: "check" };
    }
    return { action: "call" };
  }
}
