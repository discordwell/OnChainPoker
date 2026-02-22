import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { CardId } from "@onchainpoker/holdem-eval";
import { cardToString } from "@onchainpoker/holdem-eval";
import type { BotConfig } from "./config.js";
import type { Strategy, GameState } from "./strategy.js";
import { decryptHoleCards } from "./holeCards.js";
import { log, logError } from "./log.js";

// ---------------------------------------------------------------------------
// Helpers for accessing chain JSON (handles both camelCase and snake_case)
// ---------------------------------------------------------------------------

function g(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    if (obj?.[k] !== undefined) return obj[k];
  }
  return undefined;
}

function toInt(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseInt(v, 10);
  return 0;
}

function toBigInt(v: any): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && v) return BigInt(v);
  if (typeof v === "number") return BigInt(v);
  return 0n;
}

function isBettingPhase(phase: any): boolean {
  return phase === 2 || phase === "HAND_PHASE_BETTING";
}

function parseStreet(street: any): GameState["street"] {
  switch (street) {
    case 1: case "STREET_PREFLOP": return "preflop";
    case 2: case "STREET_FLOP": return "flop";
    case 3: case "STREET_TURN": return "turn";
    case 4: case "STREET_RIVER": return "river";
    default: return "preflop";
  }
}

function getPosition(
  mySeat: number,
  buttonSeat: number,
  sbSeat: number,
  bbSeat: number
): GameState["position"] {
  if (mySeat === sbSeat || mySeat === bbSeat) return "blinds";
  // Clockwise distance from BB → first positions after BB are early
  const fromBB = (mySeat - bbSeat + 9) % 9;
  const btnFromBB = (buttonSeat - bbSeat + 9) % 9;
  if (fromBB >= btnFromBB) return "late"; // at or past button
  if (btnFromBB <= 2) return "late"; // short-handed
  if (fromBB <= Math.ceil(btnFromBB / 3)) return "early";
  if (fromBB <= Math.ceil((2 * btnFromBB) / 3)) return "middle";
  return "late";
}

// ---------------------------------------------------------------------------
// PokerBot
// ---------------------------------------------------------------------------

export class PokerBot {
  private client: OcpCosmosClient;
  private config: BotConfig;
  private strategy: Strategy;
  private sk: bigint;
  private pkBytes: Uint8Array;
  private myAddress: string;
  private mySeat = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rebuyTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private stopped = false;
  private consecutiveFailures = 0;

  static readonly MAX_BACKOFF_MS = 60_000;

  /** Cache decrypted hole cards per handId */
  private holeCardCache = new Map<string, [CardId, CardId] | null>();
  private lastHandId = "";
  private rebuyPending = false;

  constructor(args: {
    client: OcpCosmosClient;
    config: BotConfig;
    strategy: Strategy;
    sk: bigint;
    pkBytes: Uint8Array;
    address: string;
  }) {
    this.client = args.client;
    this.config = args.config;
    this.strategy = args.strategy;
    this.sk = args.sk;
    this.pkBytes = args.pkBytes;
    this.myAddress = args.address;
  }

  async start(): Promise<void> {
    log(`Starting ${this.config.name} (${this.strategy.name}) on table ${this.config.tableId}`);
    log(`Address: ${this.myAddress}`);
    this.stopped = false;
    this.consecutiveFailures = 0;

    if (this.config.autoSit) {
      await this.ensureSeated();
    }

    this.scheduleNext(this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.rebuyTimer) {
      clearTimeout(this.rebuyTimer);
      this.rebuyTimer = null;
    }
    log("Stopped");
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.pollLoop();
    }, delayMs);
  }

  private nextDelay(): number {
    if (this.consecutiveFailures === 0) return this.config.pollIntervalMs;
    const backoff = this.config.pollIntervalMs * Math.pow(2, this.consecutiveFailures);
    return Math.min(backoff, PokerBot.MAX_BACKOFF_MS);
  }

  private async pollLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.pollOnce();
      if (this.consecutiveFailures > 0) {
        log(`RECOVERED after ${this.consecutiveFailures} failures`);
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      const delay = this.nextDelay();
      logError(`poll error (failure #${this.consecutiveFailures}, next in ${delay}ms)`, err);
      if (this.consecutiveFailures >= 3) {
        log(`DEGRADED — ${this.consecutiveFailures} consecutive failures, backoff ${delay}ms`);
      }
    }
    this.scheduleNext(this.nextDelay());
  }

  // ---------- Seating ----------

  private async ensureSeated(): Promise<void> {
    const table = await this.client.getTable(this.config.tableId);
    if (!table) throw new Error(`Table ${this.config.tableId} not found`);

    const seats: any[] = table.seats ?? [];

    // Already seated?
    for (let i = 0; i < seats.length; i++) {
      if (seats[i]?.player === this.myAddress) {
        this.mySeat = i;
        log(`Already seated at seat ${i}`);
        return;
      }
    }

    // Pick seat
    let seat = this.config.seat;
    if (seat === null) {
      for (let i = 0; i < seats.length; i++) {
        if (!seats[i]?.player) {
          seat = i;
          break;
        }
      }
    }
    if (seat === null) throw new Error("No empty seat available");

    const params = table.params ?? {};
    const buyIn = this.config.buyIn ?? g(params, "minBuyIn", "min_buy_in") ?? "1000000";

    log(`Sitting at seat ${seat} with buy-in ${buyIn}`);

    await this.client.pokerSit({
      tableId: this.config.tableId,
      seat,
      buyIn,
      pkPlayer: this.pkBytes,
    });

    this.mySeat = seat;
    log(`Seated successfully at seat ${seat}`);
  }

  // ---------- Poll loop ----------

  private async pollOnce(): Promise<void> {
    if (this.processing || this.rebuyPending) return;
    this.processing = true;

    try {
      const table = await this.client.getTable(this.config.tableId);
      if (!table) return;

      const seats: any[] = table.seats ?? [];

      // Resolve seat if unknown
      if (this.mySeat === -1) {
        for (let i = 0; i < seats.length; i++) {
          if (seats[i]?.player === this.myAddress) {
            this.mySeat = i;
            break;
          }
        }
        if (this.mySeat === -1) return;
      }

      const hand = table.hand;

      // Auto-rebuy: if no active hand and our stack is 0, leave and re-sit
      if (!hand && this.config.autoRebuy && !this.rebuyPending) {
        const myStack = toBigInt(seats[this.mySeat]?.stack);
        if (myStack === 0n && seats[this.mySeat]?.player === this.myAddress) {
          this.rebuyPending = true;
          log(`Stack is 0 — rebuying after ${this.config.rebuyDelayMs}ms...`);
          this.rebuyTimer = setTimeout(() => {
            void (async () => {
              try {
                await this.client.pokerLeave({ tableId: this.config.tableId });
                log("Left table for rebuy");
                this.mySeat = -1;
                await new Promise((r) => setTimeout(r, 1000));
                await this.ensureSeated();
                log("Rebuy complete — re-seated");
              } catch (err) {
                logError("Rebuy failed", err);
              } finally {
                this.rebuyPending = false;
              }
            })();
          }, this.config.rebuyDelayMs);
          return;
        }
      }

      // No active hand — optionally start one
      if (!hand) {
        if (this.config.autoStartHand) {
          const seated = seats.filter(
            (s: any) => s.player && toBigInt(s.stack) > 0n
          ).length;
          if (seated >= 2) {
            log("Starting new hand...");
            await this.client
              .pokerStartHand({ tableId: this.config.tableId })
              .catch((err) => logError("startHand failed", err));
          }
        }
        return;
      }

      // Only act during betting phase
      if (!isBettingPhase(g(hand, "phase"))) return;

      // Only act on our turn
      const actionOn = toInt(g(hand, "actionOn", "action_on"));
      if (actionOn !== this.mySeat) return;

      // Hand identification
      const handId = String(g(hand, "handId", "hand_id") ?? "0");

      // Clear cache when hand changes
      if (handId !== this.lastHandId) {
        this.holeCardCache.clear();
        this.lastHandId = handId;
      }

      // Decrypt hole cards (cached per handId)
      const holeCards = await this.tryGetHoleCards(table, handId);

      // Build game state
      const street = parseStreet(g(hand, "street"));
      const board: CardId[] = (hand.board ?? []).filter(
        (c: number) => c >= 0 && c < 52
      );

      const betTo = toBigInt(g(hand, "betTo", "bet_to"));
      const minRaiseSize = toBigInt(g(hand, "minRaiseSize", "min_raise_size"));
      const streetCommits: any[] = g(hand, "streetCommit", "street_commit") ?? [];
      const totalCommits: any[] = g(hand, "totalCommit", "total_commit") ?? [];
      const myStreetCommit = toBigInt(streetCommits[this.mySeat]);
      const myStack = toBigInt(seats[this.mySeat]?.stack);

      let pot = 0n;
      for (const tc of totalCommits) pot += toBigInt(tc);

      const toCall = betTo > myStreetCommit ? betTo - myStreetCommit : 0n;
      const minRaise = betTo + minRaiseSize;

      const params = table.params ?? {};
      const bigBlind = toBigInt(g(params, "bigBlind", "big_blind"));

      const buttonSeat = toInt(g(hand, "buttonSeat", "button_seat"));
      const sbSeat = toInt(g(hand, "smallBlindSeat", "small_blind_seat"));
      const bbSeat = toInt(g(hand, "bigBlindSeat", "big_blind_seat"));
      const inHand: boolean[] = g(hand, "inHand", "in_hand") ?? [];
      const playersInHand = inHand.filter(Boolean).length;
      const position = getPosition(this.mySeat, buttonSeat, sbSeat, bbSeat);
      const isLastToAct = playersInHand <= 2 && toCall === 0n;

      const gameState: GameState = {
        street,
        holeCards,
        board,
        myStack,
        pot,
        betTo,
        myStreetCommit,
        toCall,
        minRaise,
        bigBlind,
        position,
        playersInHand,
        isLastToAct,
      };

      // Decide and execute
      const decision = this.strategy.decide(gameState);
      let { action } = decision;
      let amount = decision.amount ?? 0n;

      // Sanitize: can't bet/raise more than all-in
      const allIn = myStack + myStreetCommit;
      if ((action === "bet" || action === "raise") && amount > allIn) {
        amount = allIn;
      }

      // Ensure raise meets minimum
      if (action === "raise" && amount < minRaise) {
        amount = allIn >= minRaise ? minRaise : allIn;
      }

      const holeStr = holeCards
        ? `[${cardToString(holeCards[0])} ${cardToString(holeCards[1])}]`
        : "[??]";
      const boardStr = board.length > 0 ? board.map(cardToString).join(" ") : "-";
      log(
        `Hand #${handId} ${street} ${holeStr} | board=${boardStr} | ` +
          `${action}${amount > 0n ? " " + amount : ""} ` +
          `(pot=${pot} betTo=${betTo} toCall=${toCall} stack=${myStack})`
      );

      await this.client.pokerAct({
        tableId: this.config.tableId,
        action,
        amount,
      });
    } finally {
      this.processing = false;
    }
  }

  // ---------- Hole card decryption ----------

  private async tryGetHoleCards(
    table: any,
    handId: string
  ): Promise<[CardId, CardId] | null> {
    // Return cached result
    const cached = this.holeCardCache.get(handId);
    if (cached !== undefined) return cached;

    try {
      const dealer = table.hand?.dealer;
      if (!dealer) return null;

      const holePos: number[] = g(dealer, "holePos", "hole_pos") ?? [];
      const pos0 = holePos[this.mySeat * 2];
      const pos1 = holePos[this.mySeat * 2 + 1];
      if (pos0 === undefined || pos1 === undefined || pos0 === 255 || pos1 === 255) {
        return null;
      }

      const dealerHand = await this.client.getDealerHand(
        this.config.tableId,
        handId
      );
      if (!dealerHand) return null;

      const result = decryptHoleCards(
        dealerHand,
        [pos0, pos1],
        this.pkBytes,
        this.sk
      );

      this.holeCardCache.set(handId, result);
      if (result) {
        log(
          `Decrypted hole cards: ${cardToString(result[0])} ${cardToString(result[1])}`
        );
      }
      return result;
    } catch (err) {
      logError("hole card decryption failed", err);
      this.holeCardCache.set(handId, null);
      return null;
    }
  }
}
