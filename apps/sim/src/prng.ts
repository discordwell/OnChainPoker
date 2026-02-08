// Deterministic PRNG for simulation. Do NOT use Math.random().
export class Prng {
  private a: number;

  constructor(seed: number) {
    // Ensure 32-bit unsigned seed.
    this.a = seed >>> 0;
    if (this.a === 0) this.a = 0x6d2b79f5; // avoid a trivial all-zero seed state
  }

  // Mulberry32
  nextU32(): number {
    let t = (this.a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  int(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new Error("Prng.int bounds must be integers");
    }
    if (maxExclusive <= minInclusive) {
      throw new Error("Prng.int maxExclusive must be > minInclusive");
    }
    const span = maxExclusive - minInclusive;
    return minInclusive + (this.nextU32() % span);
  }

  shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}

