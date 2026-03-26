/**
 * Card dealing animation — cards slide from a central deck position to player seats.
 */
import { Container, Graphics } from "pixi.js";
import { CardSprite } from "./CardSprite";
import { tween, Easing, wait } from "../animations/Tweener";
import { ACCENT } from "@feltprotocol/design-tokens/tokens";

export class DealAnimation extends Container {
  private deckPosition = { x: 0, y: 0 };
  private flyingCards: CardSprite[] = [];

  constructor() {
    super();
  }

  setDeckPosition(x: number, y: number) {
    this.deckPosition.x = x;
    this.deckPosition.y = y;
  }

  /**
   * Animate dealing cards to seat positions.
   * @param seatPositions Array of {x, y} positions for each occupied seat
   * @param seatIndices Which seat indices are occupied and in hand
   */
  async dealToSeats(seatPositions: Array<{ x: number; y: number }>, seatIndices: number[]) {
    // Clean up any previous flying cards
    for (const card of this.flyingCards) {
      this.removeChild(card);
      card.destroy();
    }
    this.flyingCards = [];

    // Deal two cards to each seat in sequence
    for (let round = 0; round < 2; round++) {
      for (const idx of seatIndices) {
        const pos = seatPositions[idx];
        if (!pos) continue;

        const card = new CardSprite();
        card.setCard(null); // face down
        card.position.set(this.deckPosition.x, this.deckPosition.y);
        card.scale.set(0.7);
        card.alpha = 0;
        this.addChild(card);
        this.flyingCards.push(card);

        // Animate card flying to seat
        void tween({
          target: card,
          to: { alpha: 1 },
          duration: 80,
          easing: Easing.linear,
        });

        await tween({
          target: card.position,
          to: { x: pos.x + (round === 0 ? -12 : 12), y: pos.y - 50 },
          duration: 180,
          easing: Easing.easeOutCubic,
        });

        // Fade out (the real seat cards will be shown by the SeatSprite)
        void tween({
          target: card,
          to: { alpha: 0 },
          duration: 100,
          easing: Easing.linear,
        });

        await wait(30); // small gap between cards
      }
    }

    // Clean up flying cards after animation
    await wait(150);
    for (const card of this.flyingCards) {
      this.removeChild(card);
      card.destroy();
    }
    this.flyingCards = [];
  }
}
