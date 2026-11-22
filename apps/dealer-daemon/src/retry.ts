import { logError } from "./log.js";

const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** Calls fn until it resolves, waiting 1 s, 2 s, 4 s ... and at most 30 s between attempts. */
export async function retryUntilOk<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let delay = FIRST_DELAY_MS; ; delay = Math.min(delay * 2, MAX_DELAY_MS)) {
    try {
      return await fn();
    } catch (err) {
      logError(`${what} failed, retrying in ${delay}ms`, err);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
