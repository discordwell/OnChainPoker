import type { PlayerBehavior, ValidatorBehavior } from "./types.js";

export const honestValidatorBehavior: ValidatorBehavior = {
  onShuffle: () => "submit-valid",
  onEncShare: () => "submit-valid",
  onPubShare: () => "submit-valid"
};

export const alwaysTimeoutPlayerBehavior: PlayerBehavior = {
  onPreflopAction: () => ({ type: "withhold" })
};

export const alwaysCallPlayerBehavior: PlayerBehavior = {
  onPreflopAction: ({ toCall }) => {
    if (toCall === 0) return { type: "check" };
    return { type: "call" };
  }
};

