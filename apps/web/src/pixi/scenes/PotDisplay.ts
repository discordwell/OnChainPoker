/**
 * Pot amount display with chip icon, centered on the table.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { RING, PANEL_SOLID, INK } from "@feltprotocol/design-tokens/tokens";
import { tween, Easing } from "../animations/Tweener";

export class PotDisplay extends Container {
  private bg = new Graphics();
  private chipIcon = new Graphics();
  private potText: Text;

  constructor() {
    super();

    this.potText = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: 16,
        fontWeight: "600",
        fill: INK,
      }),
    });
    this.potText.anchor.set(0, 0.5);
    this.potText.position.set(14, 0);

    // Chip icon — small circle with radial gradient look
    this.chipIcon.circle(0, 0, 8);
    this.chipIcon.fill({ color: RING });
    this.chipIcon.circle(0, 0, 5);
    this.chipIcon.fill({ color: 0xd4a843 });
    this.chipIcon.circle(0, 0, 2);
    this.chipIcon.fill({ color: RING });

    this.addChild(this.bg, this.chipIcon, this.potText);
  }

  setPot(amount: string) {
    if (amount === "0" || !amount) {
      this.visible = false;
      return;
    }
    this.visible = true;
    this.potText.text = amount;

    // Redraw background to fit text
    const textW = this.potText.width;
    const padH = 12;
    const padV = 8;
    const totalW = 14 + textW + padH * 2;
    const totalH = 20 + padV * 2;

    this.bg.clear();
    this.bg.roundRect(-padH - 8, -totalH / 2, totalW, totalH, totalH / 2);
    this.bg.fill({ color: PANEL_SOLID, alpha: 0.85 });
  }

  /** Animate pot changing (pulse effect) */
  async pulse() {
    await tween({
      target: this.scale,
      to: { x: 1.15, y: 1.15 },
      duration: 150,
      easing: Easing.easeOutQuad,
    });
    await tween({
      target: this.scale,
      to: { x: 1, y: 1 },
      duration: 200,
      easing: Easing.easeOutCubic,
    });
  }
}
