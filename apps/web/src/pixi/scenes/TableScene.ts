/**
 * Root table scene — coordinates all visual elements of the poker table.
 * Manages animation state transitions by diffing incoming props.
 */
import { Container } from "pixi.js";
import { FeltRenderer } from "./FeltRenderer";
import { SeatSprite, type SeatData } from "./SeatSprite";
import { PotDisplay } from "./PotDisplay";
import { BoardRenderer } from "./BoardRenderer";
import { DealAnimation } from "./DealAnimation";
import { WinCelebration } from "./WinCelebration";
import { audioManager } from "../../audio/AudioManager";
import type { PokerTableProps } from "../../components/PokerTable";

/**
 * Seat positions around an elliptical table (0-1 normalized).
 * Index = seat number, arranged clockwise from bottom-center.
 */
const SEAT_POSITIONS: Array<{ x: number; y: number }> = [
  { x: 0.50, y: 0.90 },  // 0 - bottom center
  { x: 0.20, y: 0.80 },  // 1 - bottom left
  { x: 0.10, y: 0.50 },  // 2 - left
  { x: 0.16, y: 0.15 },  // 3 - top left
  { x: 0.37, y: 0.04 },  // 4 - top center-left
  { x: 0.63, y: 0.04 },  // 5 - top center-right
  { x: 0.84, y: 0.15 },  // 6 - top right
  { x: 0.90, y: 0.50 },  // 7 - right
  { x: 0.80, y: 0.80 },  // 8 - bottom right
];

export class TableScene extends Container {
  readonly felt = new FeltRenderer();
  readonly seatSprites: SeatSprite[] = [];
  readonly pot = new PotDisplay();
  readonly board = new BoardRenderer();
  readonly dealAnim = new DealAnimation();
  readonly winCelebration = new WinCelebration();

  private _w = 0;
  private _h = 0;
  private _prevHandId: string | null = null;
  private _prevBoardLen = 0;
  private _prevPot = "0";
  private _prevActionOn = -1;
  private _prevPhase = "";
  private _localSeat: number | null = null;

  constructor() {
    super();

    // Create 9 seat sprites
    for (let i = 0; i < 9; i++) {
      const seat = new SeatSprite();
      this.seatSprites.push(seat);
    }

    this.addChild(
      this.felt,
      this.board,
      this.pot,
      this.dealAnim,
      ...this.seatSprites,
      this.winCelebration,
    );
  }

  resize(w: number, h: number) {
    this._w = w;
    this._h = h;

    this.felt.resize(w, h);

    // Position seats
    for (let i = 0; i < 9; i++) {
      const pos = SEAT_POSITIONS[i]!;
      this.seatSprites[i]!.position.set(pos.x * w, pos.y * h);
    }

    // Board at center
    this.board.position.set(w / 2, h * 0.40);

    // Pot below board
    this.pot.position.set(w / 2, h * 0.55);

    // Deal animation deck position (center of table)
    this.dealAnim.setDeckPosition(w / 2, h * 0.35);
  }

  /** Optional name resolver for player display names (nicknames) */
  nameResolver: ((address: string) => string) | null = null;

  /**
   * Sync React props into the Pixi scene.
   * Detects state transitions and triggers animations.
   */
  syncProps(props: PokerTableProps) {
    const { seats, hand, localPlayerSeat, localHoleCards } = props;
    const handId = hand?.handId ?? null;
    const phase = hand?.phase ?? "";
    const pot = hand?.pot ?? "0";
    const boardCards = hand?.board ?? [];
    const actionOn = hand?.actionOn ?? -1;
    const buttonSeat = hand?.buttonSeat ?? -1;
    const sbSeat = hand?.smallBlindSeat ?? -1;
    const bbSeat = hand?.bigBlindSeat ?? -1;
    const actionDeadline = hand?.actionDeadline ?? 0;

    // Timer computation
    const now = Date.now();
    const deadlineMs = actionDeadline > 1e12 ? actionDeadline : actionDeadline * 1000;
    const remainingMs = deadlineMs > 0 ? Math.max(0, deadlineMs - now) : 0;
    const totalMs = 30_000;
    const timerPct = deadlineMs > 0 ? Math.min(1, remainingMs / totalMs) : 0;
    const timerUrgent = deadlineMs > 0 && remainingMs < 5000 && remainingMs > 0;

    // ─── Detect state transitions ───

    this._localSeat = localPlayerSeat;
    const isNewHand = handId !== null && handId !== this._prevHandId && this._prevHandId !== null;
    const newBoardCards = boardCards.filter((c) => c != null).length;
    const boardGrew = newBoardCards > this._prevBoardLen;
    const potChanged = pot !== this._prevPot && pot !== "0";
    const actionChanged = actionOn !== this._prevActionOn && actionOn >= 0;
    const phaseChanged = phase !== this._prevPhase && phase !== "";

    // ─── Sound triggers ───

    if (isNewHand) {
      audioManager.play("deal");
    }
    if (boardGrew && !isNewHand) {
      audioManager.play("cardFlip");
      audioManager.play("phaseChange");
    }
    if (potChanged && !isNewHand) {
      audioManager.play("chipClick");
    }
    if (actionChanged && actionOn === localPlayerSeat) {
      audioManager.play("yourTurn");
    }

    // ─── Update seats ───

    for (let i = 0; i < 9; i++) {
      const seatData = seats.find((s) => s.seat === i);
      const data: SeatData = seatData ?? {
        seat: i,
        player: "",
        stack: "",
        inHand: false,
        folded: false,
        allIn: false,
      };

      const isActive = i === actionOn;
      const markers: string[] = [];
      if (hand && data.player) {
        if (i === buttonSeat) markers.push("D");
        if (i === sbSeat) markers.push("SB");
        if (i === bbSeat) markers.push("BB");
      }

      const displayName = data.player && this.nameResolver ? this.nameResolver(data.player) : undefined;
      this.seatSprites[i]!.update(data, isActive, timerPct, timerUrgent, markers, displayName);

      // Hole cards
      const isLocal = i === localPlayerSeat;
      if (data.player && data.inHand && !data.folded) {
        if (isLocal && localHoleCards) {
          this.seatSprites[i]!.setHoleCards(localHoleCards[0], localHoleCards[1], isNewHand);
        } else {
          this.seatSprites[i]!.showFaceDown(true);
        }
      } else {
        this.seatSprites[i]!.showFaceDown(false);
      }
    }

    // ─── Board ───

    if (isNewHand) {
      this.board.clear();
    }

    if (boardGrew || isNewHand) {
      this.board.setBoard(boardCards, boardGrew && !isNewHand);
    } else if (!isNewHand) {
      // Quiet update (no animation)
      this.board.setBoard(boardCards, false);
    }

    // ─── Pot ───

    this.pot.setPot(pot);
    if (potChanged && !isNewHand) {
      void this.pot.pulse();
    }

    // ─── Deal animation on new hand ───

    if (isNewHand) {
      const occupiedSeats = seats
        .filter((s) => s.player && s.inHand)
        .map((s) => s.seat);
      const seatPositions = SEAT_POSITIONS.map((p) => ({
        x: p.x * this._w,
        y: p.y * this._h,
      }));
      void this.dealAnim.dealToSeats(seatPositions, occupiedSeats);
    }

    // ─── Save state for next diff ───

    this._prevHandId = handId;
    this._prevBoardLen = newBoardCards;
    this._prevPot = pot;
    this._prevActionOn = actionOn;
    this._prevPhase = phase;
  }

  /**
   * Called each frame for continuous animations (waiting dots, etc.).
   */
  tick() {
    this.board.animateWaiting();
  }

  /**
   * Trigger win celebration at a seat position.
   */
  celebrateWinner(seatIndex: number, big = false) {
    const pos = SEAT_POSITIONS[seatIndex];
    if (!pos) return;
    void this.winCelebration.celebrate(pos.x * this._w, pos.y * this._h, big);
  }
}
