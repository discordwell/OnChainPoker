/**
 * Per-seat container: player name, stack, hole cards, turn ring, D/SB/BB markers.
 */
import { Container, Graphics, Sprite, Text, TextStyle, Texture } from "pixi.js";
import { CardSprite } from "./CardSprite";
import { tween, Easing } from "../animations/Tweener";
import { generateIdenticon } from "../../lib/identicon";
import { INK, MUTED, RING, ACCENT, PANEL_SOLID, LINE, DANGER } from "@feltprotocol/design-tokens/tokens";

const INFO_W = 140;
const INFO_H = 48;
const INFO_R = 10;

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

  private identiconSprite: Sprite | null = null;
  private _identiconAddr = "";
  private static _texCache = new Map<string, Texture>();

  private _data: SeatData | null = null;
  private _isActive = false;
  private _timerPct = 0;
  private _timerUrgent = false;
  private _markers: string[] = [];
  private _displayName = "";

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
      fontWeight: "500",
      fill: RING,
    });
    const badgeStyle = new TextStyle({
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: 9,
      fontWeight: "700",
      fill: INK,
      letterSpacing: 1,
    });

    this.nameText = new Text({ text: "", style: nameStyle });
    this.stackText = new Text({ text: "", style: stackStyle });
    this.badgeText = new Text({ text: "", style: badgeStyle });

    this.nameText.anchor.set(0.5, 0);
    this.stackText.anchor.set(0.5, 0);
    this.badgeText.anchor.set(0.5, 0.5);

    // Cards above the info panel — slightly larger
    this.card0.scale.set(0.9);
    this.card1.scale.set(0.9);
    this.card0.position.set(-20, 0);
    this.card1.position.set(20, 0);
    this.cardsContainer.addChild(this.card0, this.card1);
    this.cardsContainer.position.set(0, -52);

    // Info panel below cards
    this.nameText.position.set(0, 7);
    this.stackText.position.set(0, 24);
    this.badgeText.position.set(0, 40);

    this.addChild(this.ring, this.cardsContainer, this.infoBg, this.nameText, this.stackText, this.badgeText, this.markerContainer);

    this.pivot.set(0, 0);
  }

  update(data: SeatData, isActive: boolean, timerPct: number, timerUrgent: boolean, markers: string[], displayName?: string) {
    this._data = data;
    this._isActive = isActive;
    this._timerPct = timerPct;
    this._timerUrgent = timerUrgent;
    this._markers = markers;
    this._displayName = displayName ?? "";
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
    const borderAlpha = isEmpty ? 0.2 : this._isActive ? 0.9 : 0.5;

    // Info background
    this.infoBg.clear();
    if (isEmpty) {
      // Dashed outline for empty seats
      this.infoBg.roundRect(-INFO_W / 2, 0, INFO_W, INFO_H, INFO_R);
      this.infoBg.fill({ color: PANEL_SOLID, alpha: 0.3 });
      this.infoBg.roundRect(-INFO_W / 2, 0, INFO_W, INFO_H, INFO_R);
      this.infoBg.stroke({ color: LINE, width: 1, alpha: 0.25 });
    } else {
      this.infoBg.roundRect(-INFO_W / 2, 0, INFO_W, INFO_H, INFO_R);
      this.infoBg.fill({ color: PANEL_SOLID, alpha: 0.92 });
      this.infoBg.roundRect(-INFO_W / 2, 0, INFO_W, INFO_H, INFO_R);
      this.infoBg.stroke({ color: borderColor, width: 1.5, alpha: borderAlpha });
    }

    // Identicon
    if (!isEmpty && d.player && d.player !== this._identiconAddr) {
      this._identiconAddr = d.player;
      let tex = SeatSprite._texCache.get(d.player);
      if (!tex) {
        const dataUrl = generateIdenticon(d.player, 24);
        tex = Texture.from(dataUrl);
        SeatSprite._texCache.set(d.player, tex);
      }
      if (this.identiconSprite) this.removeChild(this.identiconSprite);
      this.identiconSprite = new Sprite(tex);
      this.identiconSprite.width = 20;
      this.identiconSprite.height = 20;
      this.identiconSprite.position.set(-INFO_W / 2 + 6, 14);
      this.identiconSprite.roundPixels = true;
      this.addChild(this.identiconSprite);
    }
    if (isEmpty && this.identiconSprite) {
      this.removeChild(this.identiconSprite);
      this.identiconSprite = null;
      this._identiconAddr = "";
    }

    // Name & stack
    if (isEmpty) {
      this.nameText.text = "Empty";
      this.nameText.style.fill = MUTED;
      this.nameText.style.fontSize = 11;
      this.stackText.text = "";
      this.badgeText.text = "";
      this.alpha = 0.35;
    } else {
      const name = this._displayName || (d.player.length > 16
        ? `${d.player.slice(0, 8)}...${d.player.slice(-4)}`
        : d.player);
      this.nameText.text = name;
      this.nameText.style.fill = INK;
      this.nameText.style.fontSize = 12;
      this.stackText.text = d.stack;
      this.alpha = d.folded ? 0.4 : 1;

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

    // Active turn ring — more prominent
    this.ring.clear();
    if (this._isActive && !isEmpty) {
      const ringR = 46;
      const ringColor = this._timerUrgent ? DANGER : RING;

      // Outer glow
      this.ring.circle(0, INFO_H / 2, ringR + 4);
      this.ring.fill({ color: ringColor, alpha: 0.06 });

      if (this._timerPct > 0) {
        // Timer arc
        const startAngle = -Math.PI / 2;
        const endAngle = startAngle + this._timerPct * Math.PI * 2;
        this.ring.arc(0, INFO_H / 2, ringR, startAngle, endAngle);
        this.ring.stroke({ color: ringColor, width: 3.5, alpha: 0.9 });

        // Background arc (remaining time)
        this.ring.arc(0, INFO_H / 2, ringR, endAngle, startAngle + Math.PI * 2);
        this.ring.stroke({ color: LINE, width: 2, alpha: 0.25 });
      } else {
        // Static pulsing glow ring
        this.ring.circle(0, INFO_H / 2, ringR);
        this.ring.stroke({ color: RING, width: 2.5, alpha: 0.7 });
      }
    }

    // D/SB/BB markers — support multiple
    this.markerContainer.removeChildren();
    if (this._markers.length > 0) {
      let offsetX = 0;
      for (const mk of this._markers) {
        const markerBg = new Graphics();
        const markerText = new Text({
          text: mk,
          style: new TextStyle({
            fontFamily: '"Space Grotesk", sans-serif',
            fontSize: 9,
            fontWeight: "700",
            fill: mk === "D" ? 0x1a1a2e : PANEL_SOLID,
          }),
        });
        markerText.anchor.set(0.5, 0.5);

        const markerColor = mk === "D" ? 0xffffff
          : mk === "SB" ? 0xd4c59a
          : RING;

        markerBg.circle(0, 0, 11);
        markerBg.fill({ color: markerColor });

        const chip = new Container();
        chip.addChild(markerBg, markerText);
        chip.position.set(-INFO_W / 2 - 10 + offsetX, INFO_H / 2);
        this.markerContainer.addChild(chip);

        offsetX -= 22; // stack markers to the left
      }
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
