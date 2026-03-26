/**
 * Community cards area — renders flop/turn/river with staggered flip animations.
 */
import { Container, Text, TextStyle } from "pixi.js";
import { CardSprite } from "./CardSprite";
import { tween, Easing, wait } from "../animations/Tweener";
import { MUTED } from "@feltprotocol/design-tokens/tokens";

const CARD_GAP = 8;

export class BoardRenderer extends Container {
  private cards: CardSprite[] = [];
  private waitingText: Text;
  private _currentBoard: (number | null)[] = [];

  constructor() {
    super();

    // Create 5 card slots (flop 3 + turn 1 + river 1)
    for (let i = 0; i < 5; i++) {
      const card = new CardSprite();
      card.visible = false;
      this.cards.push(card);
      this.addChild(card);
    }

    this.waitingText = new Text({
      text: "Waiting for cards",
      style: new TextStyle({
        fontFamily: '"Space Grotesk", sans-serif',
        fontSize: 14,
        fill: MUTED,
        letterSpacing: 1,
      }),
    });
    this.waitingText.anchor.set(0.5, 0.5);
    this.addChild(this.waitingText);

    this.layoutCards();
  }

  private layoutCards() {
    const cardW = this.cards[0]!.cardWidth;
    const totalWidth = 5 * cardW + 4 * CARD_GAP;
    const startX = -totalWidth / 2 + cardW / 2;

    // Flop (0-2) grouped, then gap, turn (3), gap, river (4)
    for (let i = 0; i < 5; i++) {
      let x = startX + i * (cardW + CARD_GAP);
      // Extra gap between flop and turn
      if (i >= 3) x += CARD_GAP * 2;
      // Extra gap between turn and river
      if (i >= 4) x += CARD_GAP;
      this.cards[i]!.position.set(x, 0);
    }
  }

  /**
   * Update board cards. Detects which cards are new and animates them.
   */
  async setBoard(board: (number | null)[], animate = true) {
    const prevLen = this._currentBoard.filter((c) => c != null).length;
    const newLen = board.filter((c) => c != null).length;
    this._currentBoard = [...board];

    this.waitingText.visible = newLen === 0;

    for (let i = 0; i < 5; i++) {
      const card = this.cards[i]!;
      const cardId = i < board.length ? board[i] ?? null : null;

      if (cardId != null) {
        card.visible = true;

        const isNew = i >= prevLen && animate;
        if (isNew) {
          // Animate card appearing: slide down + flip
          card.position.y = -30;
          card.alpha = 0;
          card.setCard(cardId, false);

          const delay = (i - prevLen) * 120; // stagger
          await wait(delay);

          void tween({
            target: card.position,
            to: { y: 0 },
            duration: 300,
            easing: Easing.easeOutCubic,
          });
          void tween({
            target: card,
            to: { alpha: 1 },
            duration: 200,
            easing: Easing.linear,
          });
          card.setCard(cardId, true);
        } else {
          card.setCard(cardId, false);
          card.alpha = 1;
          card.position.y = 0;
        }
      } else {
        card.visible = false;
      }
    }
  }

  /** Reset all cards (new hand) */
  clear() {
    this._currentBoard = [];
    this.waitingText.visible = true;
    for (const card of this.cards) {
      card.visible = false;
      card.setCard(null);
    }
  }
}
