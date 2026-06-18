import type { ChainEvent } from "../types.js";

/**
 * Fan a batch of chain events out to every subscriber, isolating per-subscriber
 * failures.
 *
 * Both chain adapters drive this from inside their RPC WebSocket `message`
 * handler. The coordinator installs no process-level `uncaughtException`
 * handler, so a subscriber throwing here would escape the handler as an
 * uncaught exception and crash the entire coordinator — disconnecting every
 * player. A throw would also abort delivery to the remaining subscribers in the
 * loop. Catching per-subscriber keeps one bad subscriber (or one bad event) from
 * taking down the relay or starving its siblings.
 *
 * `onError` is invoked once per failed `(subscriber, event)` pair; it must not
 * throw.
 */
export function dispatchChainEvents(
  subscribers: Iterable<(ev: ChainEvent) => void>,
  events: readonly ChainEvent[],
  onError?: (err: unknown, ev: ChainEvent) => void
): void {
  for (const ev of events) {
    for (const cb of subscribers) {
      try {
        cb(ev);
      } catch (err) {
        if (onError) onError(err, ev);
      }
    }
  }
}
