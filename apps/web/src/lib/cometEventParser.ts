/**
 * Browser-compatible CometBFT WebSocket event parsing.
 * Ported from apps/coordinator/src/chain/comet.ts — replaces Node Buffer
 * with atob() + TextDecoder for browser environments.
 */

export type ChainEvent = {
  name: string;
  tableId?: string;
  handId?: string;
  eventIndex: number;
  timeMs: number;
  data?: Record<string, string>;
};

type CometTxEventAttr = { key: string; value: string };
type CometTxEvent = { type: string; attributes?: CometTxEventAttr[] };

type CometWsMsg = {
  id?: number | string;
  result?: any;
  params?: any;
  error?: any;
};

/** Convert an HTTP(S) RPC URL to its CometBFT WebSocket endpoint. */
export function toWebSocketUrl(rpcUrl: string): string {
  const u = new URL(rpcUrl, globalThis.location?.origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/websocket";
  return u.toString();
}

/** Extract the TxResult payload from various CometBFT WS message shapes. */
export function extractTxResult(msg: CometWsMsg): any | null {
  const root = (msg as any).result ?? (msg as any).params?.result ?? null;
  if (!root) return null;

  const data = root.data ?? root;
  const value = data.value ?? data;

  if (value && typeof value === "object" && "TxResult" in value) return (value as any).TxResult;
  if (value && typeof value === "object" && ("result" in value || "events" in value)) return value;

  return null;
}

/**
 * Decode a potentially-base64 string to UTF-8.
 * CometBFT ABCI events may have base64-encoded keys/values.
 * Uses atob() + TextDecoder instead of Node's Buffer.
 */
export function maybeBase64ToUtf8(s: string): string {
  const norm = String(s ?? "");
  if (norm === "") return "";

  // Fast path: reject obviously non-base64.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(norm)) return norm;

  // Normalize padding for comparison.
  const padded = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4));

  let bytes: Uint8Array;
  try {
    const binary = atob(padded);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return norm;
  }

  // Strict round-trip check: re-encode and compare.
  let round: string;
  try {
    let binaryStr = "";
    for (const b of bytes) binaryStr += String.fromCharCode(b);
    round = btoa(binaryStr);
  } catch {
    return norm;
  }

  const stripPad = (x: string) => x.replace(/=+$/, "");
  if (stripPad(round) !== stripPad(padded)) return norm;

  // Decode as UTF-8; reject if replacement characters appear.
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    return norm;
  }
}

/** Convert ABCI event attributes to a plain object, decoding base64 keys/values. */
export function attrsToObject(attrs: CometTxEventAttr[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    if (!a || typeof a.key !== "string") continue;
    const k = maybeBase64ToUtf8(a.key);
    const v = maybeBase64ToUtf8(String(a.value ?? ""));
    out[k] = v;
  }
  return out;
}

/** Transform raw CometBFT ABCI events into typed ChainEvent objects. */
export function eventsToChainEvents(
  events: CometTxEvent[] | undefined,
  base: { eventIndexStart: number; timeMs: number },
): ChainEvent[] {
  const out: ChainEvent[] = [];
  let idx = base.eventIndexStart;
  for (const ev of events ?? []) {
    if (!ev || typeof ev.type !== "string") continue;
    const data = attrsToObject(ev.attributes);
    const tableId = data.tableId ? String(data.tableId) : undefined;
    const handId = data.handId ? String(data.handId) : undefined;
    out.push({
      name: ev.type,
      tableId,
      handId,
      data,
      eventIndex: idx++,
      timeMs: base.timeMs,
    });
  }
  return out;
}
