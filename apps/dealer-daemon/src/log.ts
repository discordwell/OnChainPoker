export function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [dealer-daemon] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString();
  const errStr = err instanceof Error ? err.message : String(err ?? "");
  console.error(`[${ts}] [dealer-daemon] ERROR: ${msg}${errStr ? ` — ${errStr}` : ""}`);
}
