/**
 * Community cards area — renders flop/turn/river with staggered flip animations.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { CardSprite } from "./CardSprite";
import { tween, Easing, wait } from "../animations/Tweener";
import { MUTED, ACCENT } from "@feltprotocol/design-tokens/tokens";

const CARD_GAP = 10;

export class BoardRenderer extends Container {
  private cards: CardSprite[] = [];
  private waitingText: Text;
  private waitingDots = new Graphics();
  private _currentBoard: (number | null)[] = [];
  private _dotPhase = 0;

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
      text: "WAITING FOR CARDS",
      style: new TextStyle({
        fontFamily: '"Space Grotesk", sans-serif',
        fontSize: 13,
        fontWeight: "500",
        fill: MUTED,
        letterSpacing: 2,
      }),
    });
    this.waitingText.anchor.set(0.5, 0.5);
    this.waitingText.position.set(0, -8);

    // Animated dots below waiting text
    this.waitingDots.position.set(0, 10);
    this.addChild(this.waitingText, this.waitingDots);

    this.layoutCards();
  }

  private layoutCards() {
    const cardW = this.cards[0]!.cardWidth;
    const totalWidth = 5 * cardW + 4 * CARD_GAP + CARD_GAP * 3; // extra gaps between streets
    const startX = -totalWidth / 2 + cardW / 2;

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
   * Call each frame to animate the waiting dots.
   */
  animateWaiting() {
    if (!this.waitingText.visible) return;
    this._dotPhase = (this._dotPhase + 0.02) % (Math.PI * 2);

    this.waitingDots.clear();
    for (let i = 0; i < 3; i++) {
      const phase = this._dotPhase + i * 0.8;
      const alpha = 0.2 + 0.3 * Math.max(0, Math.sin(phase));
      this.waitingDots.circle(-12 + i * 12, 0, 2.5);
      this.waitingDots.fill({ color: ACCENT, alpha });
    }
  }

  /**
   * Update board cards. Detects which cards are new and animates them.
   */
  setBoard(board: (number | null)[], animate = true) {
    const prevLen = this._currentBoard.filter((c) => c != null).length;
    const newLen = board.filter((c) => c != null).length;
    this._currentBoard = [...board];

    this.waitingText.visible = newLen === 0;
    this.waitingDots.visible = newLen === 0;

    for (let i = 0; i < 5; i++) {
      const card = this.cards[i]!;
      const cardId = i < board.length ? board[i] ?? null : null;

      if (cardId != null) {
        card.visible = true;

        const isNew = i >= prevLen && animate;
        if (isNew) {
          // Reset card position for animation
          const baseY = 0;
          card.position.y = -40;
          card.alpha = 0;

          const staggerDelay = (i - prevLen) * 150;

          // Animate: slide down + fade in + flip (all non-blocking)
          void tween({
            target: card.position,
            to: { y: baseY },
            duration: 350,
            easing: Easing.easeOutBack,
            delay: staggerDelay,
          });
          void tween({
            target: card,
            to: { alpha: 1 },
            duration: 200,
            easing: Easing.linear,
            delay: staggerDelay,
          });

          // Flip the card face-up with a short delay
          setTimeout(() => {
            card.setCard(cardId, true);
          }, staggerDelay + 50);
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
    this.waitingDots.visible = true;
    for (const card of this.cards) {
      card.visible = false;
      card.setCard(null);
    }
  }
}
