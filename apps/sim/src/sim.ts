import { sha256Hex } from "./hash.js";
import { Prng } from "./prng.js";
import { assertInvariants } from "./invariants.js";
import type {
  Behaviors,
  Committee,
  Event,
  Player,
  PlayerAction,
  PlayerId,
  SimulationResult,
  SimConfig,
  TableState,
  Validator,
  ValidatorBehavior,
  ValidatorDecision,
  ValidatorId,
  WorldState
} from "./types.js";

function playerId(i: number): PlayerId {
  return `P${i}` as const;
}

function validatorId(i: number): ValidatorId {
  return `V${i}` as const;
}

function sumCommitted(players: Player[]): number {
  let pot = 0;
  for (const p of players) pot += p.committed;
  return pot;
}

function activePlayersInHand(table: TableState): Player[] {
  // Include Ejected to ensure their committed chips are settled/refunded deterministically.
  return table.players.filter((p) => p.status === "InHand" || p.status === "Folded" || p.status === "Ejected");
}

function remainingPlayers(table: TableState): Player[] {
  return table.players.filter((p) => p.status === "InHand");
}

function activeValidators(world: WorldState, committee: Committee): Validator[] {
  const out: Validator[] = [];
  for (const id of committee.members) {
    const v = world.validators.get(id);
    if (!v) continue;
    if (v.status === "Active") out.push(v);
  }
  return out;
}

function slashValidator(world: WorldState, events: Event[], id: ValidatorId, reason: string): void {
  const v = world.validators.get(id);
  if (!v || v.status !== "Active") return;
  const amt = Math.min(world.config.params.dealerSlash, v.stake);
  v.stake -= amt;
  v.slashCount += 1;
  // v0 policy: jail on first slashable dealer offense
  v.status = "Jailed";
  world.treasury += amt;
  events.push({ type: "ValidatorSlashed", validatorId: id, reason, amount: amt });
}

function slashPlayer(world: WorldState, events: Event[], id: PlayerId, reason: string): void {
  const p = world.table.players.find((x) => x.id === id);
  if (!p) return;
  const amt = Math.min(world.config.params.playerTimeoutSlash, p.bond);
  p.bond -= amt;
  p.timeoutCount += 1;
  world.treasury += amt;
  events.push({ type: "PlayerSlashed", playerId: id, reason, amount: amt });
  if (p.bond < world.config.params.playerBondMin && p.status !== "Ejected") {
    p.status = "Ejected";
    events.push({ type: "PlayerEjected", playerId: id, reason: "bond below minimum" });
  }
}

function applyTimeoutDefaultAction(toCall: number): { action: PlayerAction; result: "check" | "fold" } {
  if (toCall === 0) return { action: { type: "check" }, result: "check" };
  return { action: { type: "fold" }, result: "fold" };
}

function normalizePlayerAction(action: PlayerAction, toCall: number): PlayerAction {
  if (action.type === "check" && toCall !== 0) return { type: "fold" };
  if (action.type === "call" && toCall === 0) return { type: "check" };
  return action;
}

function dealFromDeck(world: WorldState, pos: number): number {
  const deck = world.table.hand?.dealer.deck;
  if (!deck) throw new Error("deck not initialized");
  if (pos < 0 || pos >= deck.length) throw new Error(`invalid deck pos: ${pos}`);
  return deck[pos];
}

function verifyShuffleIsPermutation(prev: number[], next: number[]): boolean {
  if (prev.length !== next.length) return false;
  const a = [...prev].sort((x, y) => x - y);
  const b = [...next].sort((x, y) => x - y);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function collectValidatorDecisions(
  world: WorldState,
  behavior: Map<ValidatorId, ValidatorBehavior>,
  kind: "shuffle" | "enc" | "pub",
  ctx: { epochId: number; handId: number; round?: number; pos?: number; playerId?: PlayerId }
): Map<ValidatorId, ValidatorDecision> {
  const decisions = new Map<ValidatorId, ValidatorDecision>();
  const committee = world.table.hand?.dealer.committee;
  if (!committee) throw new Error("hand committee missing");

  for (const vId of committee.members) {
    const v = world.validators.get(vId);
    if (!v || v.status !== "Active") continue;
    const b = behavior.get(vId);
    if (!b) throw new Error(`missing validator behavior for ${vId}`);

    let d: ValidatorDecision;
    if (kind === "shuffle") {
      d = b.onShuffle({ epochId: ctx.epochId, handId: ctx.handId, round: ctx.round ?? 0 });
    } else if (kind === "enc") {
      if (ctx.pos === undefined || !ctx.playerId) throw new Error("enc share ctx incomplete");
      d = b.onEncShare({ epochId: ctx.epochId, handId: ctx.handId, pos: ctx.pos, playerId: ctx.playerId });
    } else {
      if (ctx.pos === undefined) throw new Error("pub share ctx incomplete");
      d = b.onPubShare({ epochId: ctx.epochId, handId: ctx.handId, pos: ctx.pos });
    }
    decisions.set(vId, d);
  }

  return decisions;
}

export function createDefaultConfig(seed: number): SimConfig {
  return {
    seed,
    tableId: "T1",
    params: {
      smallBlind: 1,
      bigBlind: 2,
      playerBondMin: 10,
      playerTimeoutSlash: 2,
      dealerSlash: 50
    },
    playerCount: 6,
    startingStack: 100,
    startingBond: 20,
    validatorSetSize: 6,
    committeeSize: 4,
    thresholdT: 3,
    startingValidatorStake: 200,
    committeePlan: undefined,
    refundBlindsOnPreActionAbort: true,
    coordinatorOnline: true,
    hands: 1,
    rotateCommitteeEveryHand: false
  };
}

export function createWorld(config: SimConfig, prng: Prng): WorldState {
  const validators = new Map<ValidatorId, Validator>();
  for (let i = 0; i < config.validatorSetSize; i++) {
    const id = validatorId(i);
    validators.set(id, { id, stake: config.startingValidatorStake, status: "Active", slashCount: 0 });
  }

  const players: Player[] = [];
  if (!Number.isInteger(config.playerCount) || config.playerCount < 2 || config.playerCount > 9) {
    throw new Error(`playerCount must be an integer between 2 and 9 (got ${config.playerCount})`);
  }
  for (let i = 0; i < config.playerCount; i++) {
    players.push({
      id: playerId(i),
      seat: i,
      stack: config.startingStack,
      committed: 0,
      bond: config.startingBond,
      status: "Seated",
      timeoutCount: 0
    });
  }

  const world: WorldState = {
    config,
    treasury: 0,
    validators,
    table: {
      tableId: config.tableId,
      params: config.params,
      players,
      hand: null,
      buttonSeat: 0
    },
    epochId: 1,
    nextHandId: 1
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyWorld = world as any;
  anyWorld.__committeeIndex = 0;

  // Select initial committee (or use committee plan if provided).
  if (config.committeePlan?.[0]) {
    anyWorld.__nextCommittee = { epochId: world.epochId, members: config.committeePlan[0], thresholdT: config.thresholdT };
  } else {
    anyWorld.__nextCommittee = selectCommittee(world, prng);
  }

  assertInvariants(world);
  return world;
}

function selectCommittee(world: WorldState, prng: Prng): Committee {
  const all = [...world.validators.values()].filter((v) => v.status === "Active").map((v) => v.id);
  if (all.length < world.config.committeeSize) {
    throw new Error(`not enough active validators for committee: have=${all.length} need=${world.config.committeeSize}`);
  }
  prng.shuffleInPlace(all);
  const members = all.slice(0, world.config.committeeSize);
  return { epochId: world.epochId, members, thresholdT: world.config.thresholdT };
}

function getNextCommittee(world: WorldState, prng: Prng): Committee {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyWorld = world as any;
  const plan = world.config.committeePlan;
  if (plan) {
    const idx = (anyWorld.__committeeIndex ?? 0) as number;
    const members = plan[idx];
    if (members) {
      if (members.length !== world.config.committeeSize) {
        throw new Error(`committeePlan[${idx}] must have size ${world.config.committeeSize} (got ${members.length})`);
      }
      for (const id of members) {
        const v = world.validators.get(id);
        if (!v) throw new Error(`committeePlan[${idx}] references unknown validator ${id}`);
        if (v.status !== "Active") throw new Error(`committeePlan[${idx}] references non-active validator ${id} (${v.status})`);
      }
      return { epochId: world.epochId, members, thresholdT: world.config.thresholdT };
    }
    // If a plan exists but is shorter than `hands`, fall back to sampling.
  }
  if (anyWorld.__nextCommittee) return anyWorld.__nextCommittee as Committee;
  const c = selectCommittee(world, prng);
  anyWorld.__nextCommittee = c;
  return c;
}

function rotateCommittee(world: WorldState, prng: Prng): Committee {
  world.epochId += 1;
  if (world.config.committeePlan) {
    // Planned committees are handled in getNextCommittee()/startHand(); do not overwrite.
    return getNextCommittee(world, prng);
  }
  const c = selectCommittee(world, prng);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (world as any).__nextCommittee = c;
  return c;
}

function startHand(world: WorldState, events: Event[], prng: Prng): void {
  const committee = getNextCommittee(world, prng);

  // Reset per-hand player state.
  for (const p of world.table.players) {
    p.committed = 0;
    if (p.status === "Ejected") continue;
    if (p.bond < world.table.params.playerBondMin) {
      p.status = "SitOut";
    } else {
      p.status = "Seated";
    }
  }

  world.table.hand = {
    handId: world.nextHandId++,
    phase: "HandInit",
    dealer: {
      committee,
      deck: null,
      deckCommit: null,
      deckCursor: 0
    },
    board: [],
    holeCards: new Map(),
    potTotal: 0,
    didBetBeyondBlinds: false
  };

  events.push({
    type: "HandStarted",
    tableId: world.table.tableId,
    handId: world.table.hand.handId,
    epochId: committee.epochId,
    committee: [...committee.members]
  });

  if (world.config.committeePlan) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyWorld = world as any;
    anyWorld.__committeeIndex = ((anyWorld.__committeeIndex ?? 0) as number) + 1;
  }
}

function postBlinds(world: WorldState): void {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");

  const seated = world.table.players.filter((p) => p.status === "Seated");
  if (seated.length < 2) throw new Error("need at least 2 seated players for blinds");

  const nextSeatedFrom = (startSeatExclusive: number): Player => {
    for (let i = 1; i <= world.table.players.length; i++) {
      const seat = (startSeatExclusive + i) % world.table.players.length;
      const p = world.table.players.find((x) => x.seat === seat);
      if (p?.status === "Seated") return p;
    }
    throw new Error("no seated player found");
  }

  const sb = nextSeatedFrom(world.table.buttonSeat);
  const bb = nextSeatedFrom(sb.seat);

  const sbAmt = world.table.params.smallBlind;
  const bbAmt = world.table.params.bigBlind;

  if (sb.stack < sbAmt || bb.stack < bbAmt) throw new Error("v0: insufficient stack for blinds");
  sb.stack -= sbAmt;
  sb.committed += sbAmt;
  bb.stack -= bbAmt;
  bb.committed += bbAmt;

  hand.potTotal = sumCommitted(world.table.players);
}

function initDeck(world: WorldState): void {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");
  const deck = Array.from({ length: 52 }, (_, i) => i);
  hand.dealer.deck = deck;
}

function runShuffle(world: WorldState, events: Event[], prng: Prng, behaviors: Behaviors): void {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");
  hand.phase = "Shuffle";

  if (!hand.dealer.deck) throw new Error("deck not initialized");

  const committee = hand.dealer.committee;
  for (let round = 0; round < committee.members.length; round++) {
    const shufflerId = committee.members[round];
    const shuffler = world.validators.get(shufflerId);
    if (!shuffler || shuffler.status !== "Active") continue;

    const b = behaviors.validator.get(shufflerId);
    if (!b) throw new Error(`missing validator behavior for ${shufflerId}`);
    const decision = b.onShuffle({ epochId: committee.epochId, handId: hand.handId, round });

    if (decision === "withhold") {
      slashValidator(world, events, shufflerId, `withheld shuffle round ${round}`);
      continue;
    }

    if (decision === "submit-invalid") {
      slashValidator(world, events, shufflerId, `invalid shuffle proof round ${round}`);
      continue;
    }

    const prev = hand.dealer.deck;
    const next = [...prev];
    prng.shuffleInPlace(next);
    if (!verifyShuffleIsPermutation(prev, next)) {
      slashValidator(world, events, shufflerId, `shuffle not a permutation round ${round}`);
      continue;
    }
    hand.dealer.deck = next;
  }

  const commit = sha256Hex(hand.dealer.deck.join(","));
  hand.dealer.deckCommit = commit;
  events.push({ type: "DeckFinalized", tableId: world.table.tableId, handId: hand.handId, deckCommit: commit });
}

function collectSharesOrAbort(
  world: WorldState,
  events: Event[],
  behaviors: Behaviors,
  kind: "enc" | "pub",
  pos: number,
  playerId?: PlayerId
): boolean {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");

  const committee = hand.dealer.committee;
  const decisions = collectValidatorDecisions(
    world,
    behaviors.validator,
    kind === "enc" ? "enc" : "pub",
    { epochId: committee.epochId, handId: hand.handId, pos, playerId }
  );

  let valid = 0;
  for (const [vId, d] of decisions) {
    if (d === "submit-valid") valid += 1;
    else if (d === "submit-invalid") slashValidator(world, events, vId, `${kind} share invalid proof pos ${pos}`);
    else slashValidator(world, events, vId, `${kind} share withheld pos ${pos}`);
  }

  const threshold = committee.thresholdT;
  if (valid < threshold) {
    abortHand(world, events, `threshold failure for ${kind} shares at pos ${pos}: have=${valid} need=${threshold}`);
    return false;
  }

  return true;
}

function dealHoleCards(world: WorldState, events: Event[], behaviors: Behaviors): void {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");
  hand.phase = "DealHole";

  for (const p of world.table.players) {
    if (p.status !== "Seated") continue;
    if (p.bond < world.table.params.playerBondMin) {
      p.status = "SitOut";
      continue;
    }
    p.status = "InHand";
    hand.holeCards.set(p.id, []);
  }

  for (const p of remainingPlayers(world.table)) {
    for (let h = 0; h < 2; h++) {
      const pos = hand.dealer.deckCursor++;
      if (!collectSharesOrAbort(world, events, behaviors, "enc", pos, p.id)) return;
      const card = dealFromDeck(world, pos);
      hand.holeCards.get(p.id)!.push(card);
      assertInvariants(world);
    }
  }
}

function runPreflopBetting(world: WorldState, events: Event[], behaviors: Behaviors): void {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");
  hand.phase = "PreflopBetting";

  // Action starts left of big blind (button+3), wraps until big blind acts.
  const startSeat = (world.table.buttonSeat + 3) % world.table.players.length;
  const seatsOrdered = Array.from({ length: world.table.players.length }, (_, i) => (startSeat + i) % world.table.players.length);

  let currentBet = world.table.params.bigBlind;
  const minRaiseTo = currentBet * 2;

  for (const seat of seatsOrdered) {
    const p = world.table.players.find((x) => x.seat === seat);
    if (!p || p.status !== "InHand") continue;

    const toCall = Math.max(0, currentBet - p.committed);
    const b = behaviors.player.get(p.id);
    if (!b) throw new Error(`missing player behavior for ${p.id}`);
    const decision = b.onPreflopAction({ handId: hand.handId, playerId: p.id, toCall, minRaiseTo });

    let action = decision;
    if (action.type === "withhold") {
      const { action: def, result } = applyTimeoutDefaultAction(toCall);
      events.push({ type: "TimeoutApplied", tableId: world.table.tableId, handId: hand.handId, playerId: p.id, result });
      slashPlayer(world, events, p.id, "player action timeout");
      action = def;
    }

    action = normalizePlayerAction(action, toCall);

    if (action.type === "fold") {
      if (p.status !== "Ejected") p.status = "Folded";
      events.push({ type: "ActionApplied", tableId: world.table.tableId, handId: hand.handId, playerId: p.id, action: "fold" });
    } else if (action.type === "check") {
      events.push({ type: "ActionApplied", tableId: world.table.tableId, handId: hand.handId, playerId: p.id, action: "check" });
      hand.didBetBeyondBlinds = true;
    } else if (action.type === "call") {
      const pay = Math.min(toCall, p.stack);
      p.stack -= pay;
      p.committed += pay;
      events.push({ type: "ActionApplied", tableId: world.table.tableId, handId: hand.handId, playerId: p.id, action: `call ${pay}` });
      hand.didBetBeyondBlinds = true;
    } else if (action.type === "raiseTo") {
      const raiseTo = Math.max(action.amount, minRaiseTo);
      const need = Math.max(0, raiseTo - p.committed);
      if (need > p.stack) {
        // v0: treat insufficient raise as call
        const pay = Math.min(toCall, p.stack);
        p.stack -= pay;
        p.committed += pay;
        events.push({ type: "ActionApplied", tableId: world.table.tableId, handId: hand.handId, playerId: p.id, action: `call ${pay}` });
      } else {
        p.stack -= need;
        p.committed += need;
        currentBet = raiseTo;
        events.push({
          type: "ActionApplied",
          tableId: world.table.tableId,
          handId: hand.handId,
          playerId: p.id,
          action: `raiseTo ${raiseTo}`
        });
      }
      hand.didBetBeyondBlinds = true;
    }

    hand.potTotal = sumCommitted(world.table.players);

    const remaining = remainingPlayers(world.table);
    if (remaining.length === 1) {
      // Early win, no further reveals needed.
      const winner = remaining[0];
      const pot = hand.potTotal;
      winner.stack += pot;
      for (const pl of activePlayersInHand(world.table)) pl.committed = 0;
      hand.potTotal = 0;
      hand.phase = "HandComplete";
      events.push({ type: "HandCompleted", tableId: world.table.tableId, handId: hand.handId, winner: winner.id, pot });
      return;
    }

    assertInvariants(world);
  }
}

function revealStreet(world: WorldState, events: Event[], behaviors: Behaviors, street: "flop" | "turn" | "river"): boolean {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");

  const count = street === "flop" ? 3 : 1;
  const cards: number[] = [];
  for (let i = 0; i < count; i++) {
    const pos = hand.dealer.deckCursor++;
    if (!collectSharesOrAbort(world, events, behaviors, "pub", pos)) return false;
    cards.push(dealFromDeck(world, pos));
  }
  hand.board.push(...cards);
  events.push({ type: "StreetRevealed", tableId: world.table.tableId, handId: hand.handId, street, cards });
  assertInvariants(world);
  return true;
}

function showdownAndSettle(world: WorldState, events: Event[]): void {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");

  const remaining = remainingPlayers(world.table);
  if (remaining.length === 0) {
    abortHand(world, events, "no remaining players");
    return;
  }
  if (remaining.length === 1) {
    const winner = remaining[0];
    winner.stack += hand.potTotal;
    for (const pl of activePlayersInHand(world.table)) pl.committed = 0;
    events.push({ type: "HandCompleted", tableId: world.table.tableId, handId: hand.handId, winner: winner.id, pot: hand.potTotal });
    hand.potTotal = 0;
    hand.phase = "HandComplete";
    return;
  }

  // v0: deterministic "winner" heuristic to allow full settlement.
  let winner = remaining[0];
  let best = Number.POSITIVE_INFINITY;
  for (const p of remaining) {
    const cards = hand.holeCards.get(p.id) ?? [];
    const score = cards.reduce((a, b) => a + b, 0);
    if (score < best) {
      best = score;
      winner = p;
    }
  }

  winner.stack += hand.potTotal;
  for (const pl of activePlayersInHand(world.table)) pl.committed = 0;
  events.push({ type: "HandCompleted", tableId: world.table.tableId, handId: hand.handId, winner: winner.id, pot: hand.potTotal });
  hand.potTotal = 0;
  hand.phase = "HandComplete";
}

function abortHand(world: WorldState, events: Event[], reason: string): void {
  const hand = world.table.hand;
  if (!hand) throw new Error("hand not started");
  hand.phase = "HandAborted";
  hand.abortedReason = reason;

  // Refund semantics (SPEC 8.2 Option A), with a special-case for pre-action abort blinds.
  const refundBlinds = hand.didBetBeyondBlinds || world.config.refundBlindsOnPreActionAbort;
  for (const p of world.table.players) {
    if (p.committed === 0) continue;
    if (refundBlinds) {
      p.stack += p.committed;
    } else {
      world.treasury += p.committed;
    }
    p.committed = 0;
  }
  hand.potTotal = 0;

  events.push({ type: "HandAborted", tableId: world.table.tableId, handId: hand.handId, reason });
}

export function runSimulation(config: SimConfig, behaviors: Behaviors): SimulationResult {
  const prng = new Prng(config.seed);
  const world = createWorld(config, prng);
  const events: Event[] = [{ type: "TableCreated", tableId: config.tableId }];

  for (let i = 0; i < config.hands; i++) {
    if (config.rotateCommitteeEveryHand && i > 0) rotateCommittee(world, prng);

    startHand(world, events, prng);
    postBlinds(world);
    initDeck(world);
    runShuffle(world, events, prng, behaviors);
    assertInvariants(world);

    dealHoleCards(world, events, behaviors);
    assertInvariants(world);
    if (world.table.hand?.phase === "HandAborted") continue;

    runPreflopBetting(world, events, behaviors);
    assertInvariants(world);
    if (world.table.hand?.phase === "HandComplete") continue;
    if (world.table.hand?.phase === "HandAborted") continue;

    world.table.hand!.phase = "FlopReveal";
    if (!revealStreet(world, events, behaviors, "flop")) continue;
    world.table.hand!.phase = "TurnReveal";
    if (!revealStreet(world, events, behaviors, "turn")) continue;
    world.table.hand!.phase = "RiverReveal";
    if (!revealStreet(world, events, behaviors, "river")) continue;

    world.table.hand!.phase = "Showdown";
    showdownAndSettle(world, events);
    assertInvariants(world);

    // Advance button to keep action ordering non-degenerate.
    world.table.buttonSeat = (world.table.buttonSeat + 1) % world.table.players.length;
  }

  return { world, events };
}
