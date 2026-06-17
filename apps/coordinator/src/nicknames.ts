/**
 * In-memory nickname registry with a hard size cap.
 *
 * Nicknames are ephemeral display data (lost on coordinator restart). The map
 * is keyed by player address, and — unlike the artifact cache and faucet
 * cooldown maps — was previously unbounded. A public, low-auth `PUT` endpoint
 * could grow it without limit (one entry per distinct address), so we cap it
 * here and evict the oldest entry (insertion order) once full. The cap is set
 * high enough that it only ever bites under abuse, never normal play.
 */
export class NicknameRegistry {
  private readonly map = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 50_000) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get size(): number {
    return this.map.size;
  }

  get(address: string): string | undefined {
    return this.map.get(address);
  }

  entries(): IterableIterator<[string, string]> {
    return this.map.entries();
  }

  /**
   * Register/update a nickname for `address`.
   * Returns `"taken"` if another address already holds the (case-insensitive)
   * nickname, otherwise `"ok"`.
   */
  set(address: string, nickname: string): "ok" | "taken" {
    const lower = nickname.toLowerCase();
    for (const [existingAddr, existingNick] of this.map) {
      if (existingAddr !== address && existingNick.toLowerCase() === lower) {
        return "taken";
      }
    }

    // Bound memory: when full, drop the oldest entry before inserting a new key.
    if (!this.map.has(address) && this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }

    this.map.set(address, nickname);
    return "ok";
  }
}
