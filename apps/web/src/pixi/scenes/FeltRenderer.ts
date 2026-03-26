/**
 * Renders the poker table felt surface as PixiJS graphics.
 * Replicates the CSS felt design with gradients and borders.
 */
import { Container, Graphics } from "pixi.js";
import { ACCENT, ACCENT_SOFT, BG_A, LINE, RING } from "@feltprotocol/design-tokens/tokens";

export class FeltRenderer extends Container {
  private feltGfx = new Graphics();
  private innerLine = new Graphics();
  private ambientGlow = new Graphics();
  private _w = 0;
  private _h = 0;

  constructor() {
    super();
    this.addChild(this.ambientGlow, this.feltGfx, this.innerLine);
  }

  resize(w: number, h: number) {
    this._w = w;
    this._h = h;
    this.draw();
  }

  private draw() {
    const w = this._w;
    const h = this._h;
    const cx = w / 2;
    const cy = h / 2;
    const rx = w * 0.46;
    const ry = h * 0.40;

    // Ambient overhead glow
    this.ambientGlow.clear();
    this.ambientGlow.ellipse(cx, cy * 0.3, rx * 0.6, ry * 0.4);
    this.ambientGlow.fill({ color: ACCENT, alpha: 0.04 });

    // Main felt surface
    this.feltGfx.clear();

    // Outer wood frame
    this.feltGfx.ellipse(cx, cy, rx + 8, ry + 8);
    this.feltGfx.fill({ color: 0x1a1207 });

    // Gold rim
    this.feltGfx.ellipse(cx, cy, rx + 5, ry + 5);
    this.feltGfx.stroke({ color: RING, width: 2, alpha: 0.35 });

    // Felt border
    this.feltGfx.ellipse(cx, cy, rx + 3, ry + 3);
    this.feltGfx.fill({ color: 0x0a4a37 });

    // Main felt — emerald green
    this.feltGfx.ellipse(cx, cy, rx, ry);
    this.feltGfx.fill({ color: 0x0d6b4e });

    // Felt highlight — lighter patch at top for overhead light effect
    this.feltGfx.ellipse(cx, cy - ry * 0.15, rx * 0.7, ry * 0.5);
    this.feltGfx.fill({ color: 0x11805d, alpha: 0.3 });

    // Inner decorative line
    this.innerLine.clear();
    this.innerLine.ellipse(cx, cy, rx * 0.82, ry * 0.75);
    this.innerLine.stroke({ color: ACCENT_SOFT, width: 1.5, alpha: 0.5 });
  }
}
