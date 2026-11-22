// Who sends a hand's step, and how a step's messages are cut into transactions. Pure: the daemon
// reads the chain, these decide, the handlers send.

type Member = { readonly validator: string };

/**
 * The qualified members in the chain's order, starting at `offset` (mod their count). A step that
 * any member may take, or that needs shares from only `threshold` of them, goes to the first in
 * this order: a different first member for each hand and each card spreads the work.
 */
export function turnOrder(qualified: readonly Member[], offset: number): readonly string[] {
  const n = qualified.length;
  if (n === 0) return [];
  const start = ((offset % n) + n) % n;
  return [...qualified.slice(start), ...qualified.slice(0, start)].map((m) => m.validator);
}

/**
 * Whether `me` sends its shares for a step now. The first `threshold` members in the order send as
 * soon as the step opens; the others once a later block shows it still open. A member that sends
 * nothing in a step that completes is never penalized; the chain penalizes the members whose shares
 * are missing when the step's deadline passes, so the others are one block behind, not absent.
 * `openedAtUnix` is the block time the step opened at (its deadline minus the table's dealer timeout),
 * so a daemon that restarts keeps its place.
 */
export function sharesNow(args: {
  order: readonly string[];
  threshold: number;
  me: string;
  openedAtUnix: number;
  nowUnix: number;
}): boolean {
  const rank = args.order.indexOf(args.me);
  if (rank < 0) return false;
  return rank < args.threshold || args.nowUnix > args.openedAtUnix;
}

/**
 * The transactions for `items`, by how many earlier transactions of this step failed: one with
 * everything, then halves, then one item each. A batch that fails once more is split again, so a
 * single item the chain refuses holds back only itself.
 */
export function batches<T>(items: readonly T[], failures: number): readonly (readonly T[])[] {
  if (items.length === 0) return [];
  const size = failures <= 0 ? items.length : failures === 1 ? Math.ceil(items.length / 2) : 1;
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Pending = { readonly sentAt: number; readonly holdBlocks: number };

/**
 * Transactions sent and not yet settled, by step. A step's transaction holds that step back for
 * `holdBlocks` blocks after the one it was sent from (Infinity: until it settles), so a block read
 * before the transaction could land does not send it again. Once the hold is over the chain's state
 * decides: a step that is still open is sent again.
 */
export class InFlight {
  private readonly pending = new Map<string, Pending>();
  private readonly failed = new Map<string, number>();

  holds(key: string, height: number): boolean {
    const p = this.pending.get(key);
    return p !== undefined && height <= p.sentAt + p.holdBlocks;
  }

  /** How many transactions of this step the chain refused, failed in a block, or let expire. */
  failures(key: string): number {
    return this.failed.get(key) ?? 0;
  }

  fail(key: string): void {
    this.failed.set(key, this.failures(key) + 1);
  }

  track(key: string, sentAt: number, holdBlocks: number, landed: Promise<unknown>, onFailure: (err: unknown) => void): void {
    const entry = { sentAt, holdBlocks };
    this.pending.set(key, entry);
    const settle = () => {
      if (this.pending.get(key) === entry) this.pending.delete(key);
    };
    landed.then(settle, (err) => {
      settle();
      this.fail(key);
      onFailure(err);
    });
  }

  /** Forgets the steps of every other hand of the table: `prefix` is "t<table>:", `keep` "t<table>:h<hand>:". */
  forgetAllBut(prefix: string, keep: string): void {
    for (const map of [this.pending, this.failed]) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix) && !key.startsWith(keep)) map.delete(key);
    }
  }
}
