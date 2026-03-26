/**
 * Win celebration — particle confetti effect for hand winners.
 */
import { Container, Graphics } from "pixi.js";
import { tween, Easing } from "../animations/Tweener";
import { RING, ACCENT, DANGER } from "@feltprotocol/design-tokens/tokens";

const CONFETTI_COLORS = [RING, ACCENT, 0xf5f0e8, 0xd4a843, 0x10906b, DANGER];

interface Particle {
  gfx: Graphics;
  vx: number;
  vy: number;
  rotation: number;
  life: number;
}

export class WinCelebration extends Container {
  private particles: Particle[] = [];
  private animating = false;

  constructor() {
    super();
  }

  /**
   * Fire confetti at the given position (winner's seat).
   * @param x Center X of the celebration
   * @param y Center Y of the celebration
   * @param big If true, more particles (bigger win)
   */
  async celebrate(x: number, y: number, big = false) {
    if (this.animating) return;
    this.animating = true;

    const count = big ? 40 : 20;

    for (let i = 0; i < count; i++) {
      const gfx = new Graphics();
      const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]!;
      const size = 3 + Math.random() * 4;

      // Random shape: rect or circle
      if (Math.random() > 0.5) {
        gfx.rect(-size / 2, -size, size, size * 2);
      } else {
        gfx.circle(0, 0, size);
      }
      gfx.fill({ color });

      gfx.position.set(x, y);
      gfx.alpha = 1;

      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 4;

      this.particles.push({
        gfx,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3, // upward bias
        rotation: (Math.random() - 0.5) * 0.3,
        life: 1,
      });

      this.addChild(gfx);
    }

    // Glow flash at center
    const flash = new Graphics();
    flash.circle(x, y, 30);
    flash.fill({ color: RING, alpha: 0.4 });
    this.addChild(flash);

    void tween({
      target: flash,
      to: { alpha: 0 },
      duration: 400,
      easing: Easing.easeOutQuad,
      onComplete: () => {
        this.removeChild(flash);
        flash.destroy();
      },
    });
    void tween({
      target: flash.scale,
      to: { x: 3, y: 3 },
      duration: 400,
      easing: Easing.easeOutCubic,
    });

    // Animate particles over ~60 frames
    const frames = 60;
    for (let f = 0; f < frames; f++) {
      for (const p of this.particles) {
        p.gfx.position.x += p.vx;
        p.gfx.position.y += p.vy;
        p.vy += 0.12; // gravity
        p.gfx.rotation += p.rotation;
        p.life -= 1 / frames;
        p.gfx.alpha = Math.max(0, p.life);
      }
      // Wait one frame (~16ms)
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Cleanup
    for (const p of this.particles) {
      this.removeChild(p.gfx);
      p.gfx.destroy();
    }
    this.particles = [];
    this.animating = false;
  }
}
