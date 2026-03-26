/**
 * Per-seat container: player name, stack, hole cards, turn ring, D/SB/BB markers.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { CardSprite } from "./CardSprite";
import { tween, Easing } from "../animations/Tweener";
import { INK, MUTED, RING, ACCENT, PANEL_SOLID, LINE, DANGER } from "@feltprotocol/design-tokens/tokens";

const INFO_W = 130;
const INFO_H = 50;
const INFO_R = 8;

export interface SeatData {
  seat: number;
  player: string;
  stack: string;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
}

export class SeatSprite extends Container {
  private infoBg = new Graphics();
  private nameText: Text;
  private stackText: Text;
  private badgeText: Text;
  private ring = new Graphics();
  private markerContainer = new Container();
  readonly card0 = new CardSprite();
  readonly card1 = new CardSprite();
  private cardsContainer = new Container();

  private _data: SeatData | null = null;
  private _isActive = false;
  private _timerPct = 0;
  private _timerUrgent = false;
  private _marker: "" | "D" | "SB" | "BB" = "";

  constructor() {
    super();

    const nameStyle = new TextStyle({
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: 12,
      fontWeight: "600",
      fill: INK,
    });
    const stackStyle = new TextStyle({
      fontFamily: '"IBM Plex Mono", monospace',
      fontSize: 11,
      fill: RING,
    });
    const badgeStyle = new TextStyle({
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: 9,
      fontWeight: "700",
      fill: INK,
    });

    this.nameText = new Text({ text: "", style: nameStyle });
    this.stackText = new Text({ text: "", style: stackStyle });
    this.badgeText = new Text({ text: "", style: badgeStyle });

    this.nameText.anchor.set(0.5, 0);
    this.stackText.anchor.set(0.5, 0);
    this.badgeText.anchor.set(0.5, 0.5);

    // Cards above the info panel
    this.card0.scale.set(0.85);
    this.card1.scale.set(0.85);
    this.card0.position.set(-18, 0);
    this.card1.position.set(18, 0);
    this.cardsContainer.addChild(this.card0, this.card1);
    this.cardsContainer.position.set(0, -50);

    // Info panel below cards
    this.nameText.position.set(0, 6);
    this.stackText.position.set(0, 22);
    this.badgeText.position.set(0, 38);

    this.addChild(this.ring, this.cardsContainer, this.infoBg, this.nameText, this.stackText, this.badgeText, this.markerContainer);

    this.pivot.set(0, 0);
  }

  update(data: SeatData, isActive: boolean, timerPct: number, timerUrgent: boolean, marker: "" | "D" | "SB" | "BB") {
    this._data = data;
    this._isActive = isActive;
    this._timerPct = timerPct;
    this._timerUrgent = timerUrgent;
    this._marker = marker;
    this.draw();
  }

  setHoleCards(card0: number | null, card1: number | null, animate = false) {
    this.card0.setCard(card0, animate);
    this.card1.setCard(card1, animate);
    this.cardsContainer.visible = card0 != null || card1 != null;
  }

  showFaceDown(show: boolean) {
    if (show) {
      this.card0.setCard(null);
      this.card1.setCard(null);
      this.cardsContainer.visible = true;
    } else {
      this.cardsContainer.visible = false;
    }
  }

  private draw() {
    const d = this._data;
    if (!d) return;

    const isEmpty = !d.player;
    const borderColor = this._isActive ? RING : isEmpty ? LINE : ACCENT;
    const borderAlpha = isEmpty ? 0.3 : this._isActive ? 0.8 : 0.5;

    // Info background
    this.infoBg.clear();
    this.infoBg.roundRect(-INFO_W / 2, 0, INFO_W, INFO_H, INFO_R);
    this.infoBg.fill({ color: PANEL_SOLID, alpha: isEmpty ? 0.5 : 0.9 });
    this.infoBg.roundRect(-INFO_W / 2, 0, INFO_W, INFO_H, INFO_R);
    this.infoBg.stroke({ color: borderColor, width: 1.5, alpha: borderAlpha });

    // Name & stack
    if (isEmpty) {
      this.nameText.text = "Empty";
      this.nameText.style.fill = MUTED;
      this.stackText.text = "";
      this.badgeText.text = "";
      this.alpha = 0.5;
    } else {
      const name = d.player.length > 16
        ? `${d.player.slice(0, 8)}...${d.player.slice(-4)}`
        : d.player;
      this.nameText.text = name;
      this.nameText.style.fill = INK;
      this.stackText.text = d.stack;
      this.alpha = d.folded ? 0.45 : 1;

      if (d.folded) {
        this.badgeText.text = "FOLD";
        this.badgeText.style.fill = DANGER;
      } else if (d.allIn) {
        this.badgeText.text = "ALL-IN";
        this.badgeText.style.fill = RING;
      } else {
        this.badgeText.text = "";
      }
    }

    // Active turn ring
    this.ring.clear();
    if (this._isActive) {
      const ringR = 42;
      const ringColor = this._timerUrgent ? DANGER : RING;

      if (this._timerPct > 0) {
        // Timer arc
        const startAngle = -Math.PI / 2;
        const endAngle = startAngle + this._timerPct * Math.PI * 2;
        this.ring.arc(0, INFO_H / 2, ringR, startAngle, endAngle);
        this.ring.stroke({ color: ringColor, width: 3, alpha: 0.8 });

        // Background arc
        this.ring.arc(0, INFO_H / 2, ringR, endAngle, startAngle + Math.PI * 2);
        this.ring.stroke({ color: LINE, width: 2, alpha: 0.3 });
      } else {
        // Static glow ring
        this.ring.circle(0, INFO_H / 2, ringR);
        this.ring.stroke({ color: RING, width: 2, alpha: 0.6 });
      }
    }

    // D/SB/BB marker
    this.markerContainer.removeChildren();
    if (this._marker) {
      const markerBg = new Graphics();
      const markerText = new Text({
        text: this._marker,
        style: new TextStyle({
          fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 10,
          fontWeight: "700",
          fill: this._marker === "D" ? 0x1a1a2e : PANEL_SOLID,
        }),
      });
      markerText.anchor.set(0.5, 0.5);

      const markerColor = this._marker === "D" ? 0xffffff
        : this._marker === "SB" ? 0xd4c59a
        : RING;

      markerBg.circle(0, 0, 12);
      markerBg.fill({ color: markerColor });

      this.markerContainer.addChild(markerBg, markerText);
      this.markerContainer.position.set(-INFO_W / 2 - 8, INFO_H / 2);
    }
  }

  /** Animate the seat appearing (for when a player joins) */
  async animateJoin() {
    this.scale.set(0);
    this.alpha = 0;
    await tween({
      target: this.scale,
      to: { x: 1, y: 1 },
      duration: 300,
      easing: Easing.easeOutBack,
    });
    this.alpha = 1;
  }
}
