/**
 * Lightweight tween engine for PixiJS animations.
 * Runs on the PixiJS ticker (requestAnimationFrame-driven).
 */

export type EasingFn = (t: number) => number;

export const Easing = {
  linear: (t: number) => t,
  easeInQuad: (t: number) => t * t,
  easeOutQuad: (t: number) => t * (2 - t),
  easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeOutCubic: (t: number) => --t * t * t + 1,
  easeInOutCubic: (t: number) =>
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  easeOutBack: (t: number) => {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
  easeOutElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
} as const;

interface ActiveTween {
  target: Record<string, number>;
  from: Record<string, number>;
  to: Record<string, number>;
  duration: number;
  elapsed: number;
  easing: EasingFn;
  onUpdate?: () => void;
  onComplete?: () => void;
  resolve: () => void;
}

const activeTweens: ActiveTween[] = [];
let tickerBound = false;

function tick(dt: { deltaMS: number }) {
  const ms = dt.deltaMS;
  for (let i = activeTweens.length - 1; i >= 0; i--) {
    const tw = activeTweens[i]!;
    tw.elapsed += ms;
    const progress = Math.min(1, tw.elapsed / tw.duration);
    const eased = tw.easing(progress);

    for (const key of Object.keys(tw.to)) {
      const start = tw.from[key]!;
      const end = tw.to[key]!;
      tw.target[key] = start + (end - start) * eased;
    }

    tw.onUpdate?.();

    if (progress >= 1) {
      activeTweens.splice(i, 1);
      tw.onComplete?.();
      tw.resolve();
    }
  }
}

export interface TweenOptions {
  /** Target object whose properties will be animated */
  target: Record<string, number>;
  /** Property values to animate to */
  to: Record<string, number>;
  /** Duration in milliseconds */
  duration: number;
  /** Easing function (default: easeOutCubic) */
  easing?: EasingFn;
  /** Called each frame during the tween */
  onUpdate?: () => void;
  /** Called when the tween completes */
  onComplete?: () => void;
  /** Delay before starting (ms) */
  delay?: number;
}

/**
 * Animate properties on a target object.
 * Returns a Promise that resolves when the animation completes.
 */
export function tween(opts: TweenOptions): Promise<void> {
  const { target, to, duration, easing = Easing.easeOutCubic, onUpdate, onComplete, delay } = opts;

  const start = () => {
    return new Promise<void>((resolve) => {
      // Capture starting values
      const from: Record<string, number> = {};
      for (const key of Object.keys(to)) {
        from[key] = (target as Record<string, number>)[key] ?? 0;
      }

      activeTweens.push({
        target: target as Record<string, number>,
        from,
        to,
        duration: Math.max(1, duration),
        elapsed: 0,
        easing,
        onUpdate,
        onComplete,
        resolve,
      });
    });
  };

  if (delay && delay > 0) {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        start().then(resolve);
      }, delay);
    });
  }

  return start();
}

/**
 * Bind the tweener to a PixiJS Application ticker.
 * Call once during app initialization.
 */
export function bindTweener(app: { ticker: { add: (fn: (dt: { deltaMS: number }) => void) => void } }) {
  if (tickerBound) return;
  tickerBound = true;
  app.ticker.add(tick);
}

/**
 * Cancel all active tweens (useful on scene teardown).
 */
export function cancelAll() {
  for (const tw of activeTweens) {
    tw.resolve();
  }
  activeTweens.length = 0;
}

/**
 * Run multiple tweens sequentially.
 */
export async function sequence(...tweens: TweenOptions[]): Promise<void> {
  for (const t of tweens) {
    await tween(t);
  }
}

/**
 * Run multiple tweens in parallel.
 */
export function parallel(...tweens: TweenOptions[]): Promise<void[]> {
  return Promise.all(tweens.map((t) => tween(t)));
}

/**
 * Wait for a given number of milliseconds.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
