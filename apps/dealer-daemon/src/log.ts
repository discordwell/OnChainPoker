// log() and logError() lines are rate-limited by shape (the line with its numbers masked):
// a condition that persists prints once, then at most once per five minutes with the count of
// repeats it stands for. logProgress() is for lines an operator needs every time.
const REPEAT_WINDOW_MS = 5 * 60_000;
const NUMBERS = /\b[0-9a-f]{16,}\b|\d+/gi;
const lastShown = new Map<string, { at: number; repeats: number }>();
/** Shapes remembered at once. The oldest goes first, so a daemon that runs for months holds no more. */
const MAX_SHAPES = 500;

function write(stream: "log" | "error", line: string): void {
  const ts = new Date().toISOString();
  console[stream](`[${ts}] [dealer-daemon] ${line}`);
}

function writeLimited(stream: "log" | "error", line: string): void {
  const now = Date.now();
  const shape = line.replace(NUMBERS, "#");
  const last = lastShown.get(shape);
  if (last && now - last.at < REPEAT_WINDOW_MS) {
    last.repeats++;
    return;
  }
  lastShown.delete(shape);
  lastShown.set(shape, { at: now, repeats: 0 });
  if (lastShown.size > MAX_SHAPES) lastShown.delete(lastShown.keys().next().value!);
  const repeats = last?.repeats ? ` (${last.repeats} more like this since ${new Date(last.at).toISOString()})` : "";
  write(stream, line + repeats);
}

export function log(msg: string): void {
  writeLimited("log", msg);
}

export function logProgress(msg: string): void {
  write("log", msg);
}

export function logError(msg: string, err?: unknown): void {
  const errStr = err instanceof Error ? err.message : String(err ?? "");
  writeLimited("error", `ERROR: ${msg}${errStr ? ` — ${errStr}` : ""}`);
}
