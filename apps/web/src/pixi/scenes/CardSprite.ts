/**
 * Playing card sprite with flip animation support.
 * Renders face-up cards with rank/suit or face-down with a cross-hatch pattern.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { tween, Easing } from "../animations/Tweener";
import { INK, ACCENT } from "@feltprotocol/design-tokens/tokens";

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["\u2663", "\u2666", "\u2665", "\u2660"]; // clubs, diamonds, hearts, spades
const RED_SUITS = new Set([1, 2]); // diamonds, hearts

const CARD_W = 52;
const CARD_H = 74;
const CARD_RADIUS = 4;

export class CardSprite extends Container {
  private bg = new Graphics();
  private rankText: Text;
  private suitText: Text;
  private backPattern = new Graphics();
  private _cardId: number | null = null;
  private _faceUp = false;

  constructor() {
    super();

    const rankStyle = new TextStyle({
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: 16,
      fontWeight: "700",
    });
    const suitStyle = new TextStyle({
      fontFamily: "sans-serif",
      fontSize: 14,
    });

    this.rankText = new Text({ text: "", style: rankStyle });
    this.suitText = new Text({ text: "", style: suitStyle });

    this.rankText.anchor.set(0, 0);
    this.rankText.position.set(4, 2);
    this.suitText.anchor.set(0.5, 0.5);
    this.suitText.position.set(CARD_W / 2, CARD_H / 2);

    this.addChild(this.bg, this.backPattern, this.rankText, this.suitText);
    this.pivot.set(CARD_W / 2, CARD_H / 2);

    this.drawBack();
  }

  get cardWidth() { return CARD_W; }
  get cardHeight() { return CARD_H; }

  setCard(cardId: number | null, animate = false) {
    if (cardId === this._cardId) return;
    this._cardId = cardId;
    this._faceUp = cardId != null && cardId >= 0 && cardId < 52;

    if (animate && this._faceUp) {
      void this.flipIn();
    } else {
      this.render_();
    }
  }

  /** Flip animation: scale X to 0, change card, scale back */
  async flipIn() {
    // Scale down to 0 on X axis
    await tween({
      target: this.scale,
      to: { x: 0 },
      duration: 120,
      easing: Easing.easeInQuad,
    });

    this.render_();

    // Scale back up
    await tween({
      target: this.scale,
      to: { x: 1 },
      duration: 180,
      easing: Easing.easeOutBack,
    });
  }

  private render_() {
    this.bg.clear();
    this.backPattern.clear();

    if (this._faceUp && this._cardId != null) {
      this.drawFace(this._cardId);
    } else {
      this.drawBack();
    }
  }

  private drawFace(cardId: number) {
    const suitIdx = Math.floor(cardId / 13);
    const rankIdx = cardId % 13;
    const rank = RANKS[rankIdx] ?? "?";
    const suit = SUITS[suitIdx] ?? "?";
    const isRed = RED_SUITS.has(suitIdx);
    const color = isRed ? 0xc0392b : 0x1a1a2e;

    // Card background — cream
    this.bg.roundRect(0, 0, CARD_W, CARD_H, CARD_RADIUS);
    this.bg.fill({ color: 0xf5f0e8 });
    this.bg.roundRect(0, 0, CARD_W, CARD_H, CARD_RADIUS);
    this.bg.stroke({ color: 0xd4cfc4, width: 1 });

    // Subtle bevel highlight
    this.bg.roundRect(1, 1, CARD_W - 2, CARD_H / 2, CARD_RADIUS);
    this.bg.fill({ color: 0xffffff, alpha: 0.08 });

    this.rankText.text = rank;
    this.rankText.style.fill = color;
    this.rankText.visible = true;

    this.suitText.text = suit;
    this.suitText.style.fill = color;
    this.suitText.style.fontSize = 22;
    this.suitText.visible = true;

    this.backPattern.visible = false;
  }

  private drawBack() {
    // Card back — emerald with cross-hatch pattern
    this.bg.roundRect(0, 0, CARD_W, CARD_H, CARD_RADIUS);
    this.bg.fill({ color: 0x0a4a37 });
    this.bg.roundRect(0, 0, CARD_W, CARD_H, CARD_RADIUS);
    this.bg.stroke({ color: ACCENT, width: 1.5, alpha: 0.4 });

    // Inner border
    this.bg.roundRect(4, 4, CARD_W - 8, CARD_H - 8, 2);
    this.bg.stroke({ color: 0x11805d, width: 0.5, alpha: 0.6 });

    // Cross-hatch lines
    this.backPattern.visible = true;
    const step = 8;
    for (let i = -CARD_H; i < CARD_W + CARD_H; i += step) {
      this.backPattern.moveTo(i, 0).lineTo(i + CARD_H, CARD_H);
      this.backPattern.moveTo(i + CARD_H, 0).lineTo(i, CARD_H);
    }
    this.backPattern.stroke({ color: 0x11805d, width: 0.4, alpha: 0.3 });

    // Center diamond
    const cx = CARD_W / 2, cy = CARD_H / 2, d = 10;
    this.backPattern.moveTo(cx, cy - d).lineTo(cx + d, cy).lineTo(cx, cy + d).lineTo(cx - d, cy).closePath();
    this.backPattern.fill({ color: ACCENT, alpha: 0.15 });
    this.backPattern.stroke({ color: ACCENT, width: 0.8, alpha: 0.3 });

    // Clip to card bounds
    this.backPattern.mask = (() => {
      const m = new Graphics();
      m.roundRect(0, 0, CARD_W, CARD_H, CARD_RADIUS);
      m.fill({ color: 0xffffff });
      return m;
    })();
    this.addChild(this.backPattern.mask as Graphics);

    this.rankText.visible = false;
    this.suitText.visible = false;
  }
}
