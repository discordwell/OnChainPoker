/**
 * Renders the poker table felt surface as PixiJS graphics.
 * Rich layered design: wood frame, gold rim, emerald felt with lighting.
 */
import { Container, Graphics } from "pixi.js";
import { ACCENT, ACCENT_SOFT, LINE, RING } from "@feltprotocol/design-tokens/tokens";

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
    const rx = w * 0.45;
    const ry = h * 0.38;

    // ─── Ambient overhead glow ───
    this.ambientGlow.clear();
    // Wide soft glow
    this.ambientGlow.ellipse(cx, cy * 0.5, rx * 0.8, ry * 0.6);
    this.ambientGlow.fill({ color: ACCENT, alpha: 0.03 });
    // Focused spotlight
    this.ambientGlow.ellipse(cx, cy * 0.6, rx * 0.35, ry * 0.3);
    this.ambientGlow.fill({ color: 0xf0bf4f, alpha: 0.02 });

    // ─── Table surface ───
    this.feltGfx.clear();

    // Outer shadow (table depth)
    this.feltGfx.ellipse(cx, cy + 4, rx + 14, ry + 14);
    this.feltGfx.fill({ color: 0x000000, alpha: 0.25 });

    // Wood frame — dark walnut
    this.feltGfx.ellipse(cx, cy, rx + 10, ry + 10);
    this.feltGfx.fill({ color: 0x1a1207 });

    // Wood grain highlight
    this.feltGfx.ellipse(cx, cy - 2, rx + 9, ry + 9);
    this.feltGfx.stroke({ color: 0x2d2010, width: 1, alpha: 0.6 });

    // Gold rim — thin elegant line
    this.feltGfx.ellipse(cx, cy, rx + 5, ry + 5);
    this.feltGfx.stroke({ color: RING, width: 2, alpha: 0.4 });

    // Felt border — darker green edge
    this.feltGfx.ellipse(cx, cy, rx + 3, ry + 3);
    this.feltGfx.fill({ color: 0x084a35 });

    // Main felt — emerald green
    this.feltGfx.ellipse(cx, cy, rx, ry);
    this.feltGfx.fill({ color: 0x0d6b4e });

    // Felt highlight — overhead light creating a subtle bright spot
    this.feltGfx.ellipse(cx, cy - ry * 0.12, rx * 0.65, ry * 0.45);
    this.feltGfx.fill({ color: 0x11805d, alpha: 0.25 });

    // Even brighter center highlight
    this.feltGfx.ellipse(cx, cy - ry * 0.08, rx * 0.3, ry * 0.25);
    this.feltGfx.fill({ color: 0x15926a, alpha: 0.12 });

    // ─── Inner decorative line ───
    this.innerLine.clear();
    this.innerLine.ellipse(cx, cy, rx * 0.80, ry * 0.72);
    this.innerLine.stroke({ color: ACCENT_SOFT, width: 1.5, alpha: 0.4 });
  }
}
