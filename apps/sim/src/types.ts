export type PlayerId = `P${number}`;
export type ValidatorId = `V${number}`;

export type PlayerStatus = "Seated" | "InHand" | "Folded" | "SitOut" | "Ejected";
export type ValidatorStatus = "Active" | "Jailed";

export type HandPhase =
  | "HandInit"
  | "Shuffle"
  | "DealHole"
  | "PreflopBetting"
  | "FlopReveal"
  | "TurnReveal"
  | "RiverReveal"
  | "Showdown"
  | "HandComplete"
  | "HandAborted";

export type TableParams = {
  smallBlind: number;
  bigBlind: number;
  playerBondMin: number;
  playerTimeoutSlash: number;
  dealerSlash: number;
};

export type SimConfig = {
  seed: number;
  tableId: string;
  params: TableParams;
  playerCount: number;
  startingStack: number;
  startingBond: number;
  validatorSetSize: number;
  committeeSize: number;
  thresholdT: number;
  startingValidatorStake: number;
  // Optional deterministic committee schedule. Entry i is used for handId = i+1.
  committeePlan?: ValidatorId[][];
  refundBlindsOnPreActionAbort: boolean;
  coordinatorOnline: boolean;
  hands: number;
  rotateCommitteeEveryHand: boolean;
};

export type Player = {
  id: PlayerId;
  seat: number;
  stack: number;
  committed: number;
  bond: number;
  status: PlayerStatus;
  timeoutCount: number;
};

export type Validator = {
  id: ValidatorId;
  stake: number;
  status: ValidatorStatus;
  slashCount: number;
};

export type Committee = {
  epochId: number;
  members: ValidatorId[];
  thresholdT: number;
};

export type DealerState = {
  committee: Committee;
  deck: number[] | null;
  deckCommit: string | null;
  deckCursor: number;
};

export type HandState = {
  handId: number;
  phase: HandPhase;
  dealer: DealerState;
  board: number[];
  holeCards: Map<PlayerId, number[]>;
  potTotal: number;
  didBetBeyondBlinds: boolean;
  abortedReason?: string;
};

export type TableState = {
  tableId: string;
  params: TableParams;
  players: Player[];
  hand: HandState | null;
  buttonSeat: number;
};

export type WorldState = {
  config: SimConfig;
  treasury: number;
  validators: Map<ValidatorId, Validator>;
  table: TableState;
  epochId: number;
  nextHandId: number;
};

export type Event =
  | { type: "TableCreated"; tableId: string }
  | { type: "HandStarted"; tableId: string; handId: number; epochId: number; committee: ValidatorId[] }
  | { type: "DeckFinalized"; tableId: string; handId: number; deckCommit: string }
  | { type: "StreetRevealed"; tableId: string; handId: number; street: "flop" | "turn" | "river"; cards: number[] }
  | { type: "ActionApplied"; tableId: string; handId: number; playerId: PlayerId; action: string }
  | { type: "TimeoutApplied"; tableId: string; handId: number; playerId: PlayerId; result: "check" | "fold" }
  | { type: "PlayerSlashed"; playerId: PlayerId; reason: string; amount: number }
  | { type: "PlayerEjected"; playerId: PlayerId; reason: string }
  | { type: "ValidatorSlashed"; validatorId: ValidatorId; reason: string; amount: number }
  | { type: "HandAborted"; tableId: string; handId: number; reason: string }
  | { type: "HandCompleted"; tableId: string; handId: number; winner: PlayerId; pot: number };

export type ValidatorDecision = "submit-valid" | "submit-invalid" | "withhold";

export type ValidatorBehavior = {
  onShuffle: (ctx: { epochId: number; handId: number; round: number }) => ValidatorDecision;
  onEncShare: (ctx: { epochId: number; handId: number; pos: number; playerId: PlayerId }) => ValidatorDecision;
  onPubShare: (ctx: { epochId: number; handId: number; pos: number }) => ValidatorDecision;
};

export type PlayerAction =
  | { type: "fold" }
  | { type: "call" }
  | { type: "check" }
  | { type: "raiseTo"; amount: number }
  | { type: "withhold" };

export type PlayerBehavior = {
  onPreflopAction: (ctx: { handId: number; playerId: PlayerId; toCall: number; minRaiseTo: number }) => PlayerAction;
};

export type Behaviors = {
  validator: Map<ValidatorId, ValidatorBehavior>;
  player: Map<PlayerId, PlayerBehavior>;
};

export type SimulationResult = {
  world: WorldState;
  events: Event[];
};
