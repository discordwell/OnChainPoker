import WebSocket from "ws";
import type { ChainAdapter } from "./adapter.js";
import type { ChainEvent, TableInfo } from "../types.js";

type CometTxEventAttr = { key: string; value: string };
type CometTxEvent = { type: string; attributes?: CometTxEventAttr[] };

type CometWsMsg = {
  id?: number | string;
  result?: any;
  params?: any;
  error?: any;
};

function toWebSocketUrl(rpcUrl: string): string {
  const u = new URL(rpcUrl);
  const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
  u.protocol = wsProto;
  u.pathname = u.pathname.replace(/\/+$/, "") + "/websocket";
  return u.toString();
}

function extractTxResult(msg: CometWsMsg): any | null {
  // Tendermint/Comet websocket shapes vary. Try to be liberal.
  const root = (msg as any).result ?? (msg as any).params?.result ?? null;
  if (!root) return null;

  const data = root.data ?? root;
  const value = data.value ?? data;

  if (value && typeof value === "object" && "TxResult" in value) return (value as any).TxResult;
  if (value && typeof value === "object" && ("result" in value || "events" in value)) return value;

  return null;
}

function maybeBase64ToUtf8(s: string): string {
  // Cosmos/Tendermint RPC stacks sometimes return ABCI event keys/values base64-encoded.
  // Decode only when the string is a strict base64 round-trip and the decoded bytes are valid UTF-8.
  const norm = String(s ?? "");
  if (norm === "") return "";

  // Fast path: reject obviously non-base64.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(norm)) return norm;

  // Normalize padding for comparison.
  const padded = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4));
  let buf: Buffer;
  try {
    buf = Buffer.from(padded, "base64");
  } catch {
    return norm;
  }

  // Ensure strict round-trip.
  const round = buf.toString("base64");
  const stripPad = (x: string) => x.replace(/=+$/, "");
  if (stripPad(round) !== stripPad(padded)) return norm;

  const decoded = buf.toString("utf8");
  if (decoded.includes("\uFFFD")) return norm;
  return decoded;
}

function attrsToObject(attrs: CometTxEventAttr[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    if (!a || typeof a.key !== "string") continue;
    const k = maybeBase64ToUtf8(a.key);
    const v = maybeBase64ToUtf8(String(a.value ?? ""));
    out[k] = v;
  }
  return out;
}

export function cosmosEventsToChainEvents(
  events: CometTxEvent[] | undefined,
  base: { eventIndexStart: number; timeMs: number }
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
      timeMs: base.timeMs
    });
  }
  return out;
}

function asNumber(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asString(x: unknown): string {
  if (typeof x === "string") return x;
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  return "";
}

function pokerTableToTableInfo(v: any, nowMs = Date.now()): TableInfo {
  const params = v?.params ?? v?.table?.params ?? {};

  const maxPlayers = asNumber(params.maxPlayers) ?? 9;
  const smallBlind = asString(params.smallBlind ?? params.small_blind ?? "0");
  const bigBlind = asString(params.bigBlind ?? params.big_blind ?? "0");
  const minBuyIn = asString(params.minBuyIn ?? params.min_buy_in ?? "0");
  const maxBuyIn = asString(params.maxBuyIn ?? params.max_buy_in ?? "0");

  // We expect the poker module to expose status in a stable string form.
  // Coordinator only needs a coarse lobby status.
  const statusRaw = String(v?.status ?? v?.table?.status ?? "");
  const status: TableInfo["status"] =
    statusRaw === "in_hand" || statusRaw === "IN_HAND"
      ? "in_hand"
      : statusRaw === "closed" || statusRaw === "CLOSED"
        ? "closed"
        : "open";

  return {
    tableId: asString(v?.tableId ?? v?.table?.tableId ?? v?.id ?? v?.table?.id),
    params: { maxPlayers, smallBlind, bigBlind, minBuyIn, maxBuyIn },
    status: status === "open" && (v?.hand ?? v?.table?.hand) ? "in_hand" : status,
    updatedAtMs: nowMs
  };
}

async function fetchJson<T>(fetchFn: typeof fetch, url: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetchFn(url, { method: "GET", headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

function joinUrl(baseUrl: string, path: string): string {
  const u = new URL(baseUrl);
  const basePath = u.pathname.replace(/\/+$/, "");
  const rel = String(path ?? "").trim();
  u.pathname = `${basePath}${rel.startsWith("/") ? "" : "/"}${rel}`;
  return u.toString();
}

export class CosmosChainAdapter implements ChainAdapter {
  readonly kind = "cosmos" as const;

  private readonly rpcUrl: string;
  private readonly wsUrl: string;
  private readonly lcdUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  private nextEventIndex = 1;

  private ws: WebSocket | null = null;
  private subscribers = new Set<(event: ChainEvent) => void>();
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(args: { rpcUrl: string; lcdUrl: string; wsUrl?: string; headers?: Record<string, string>; fetchFn?: typeof fetch }) {
    this.rpcUrl = args.rpcUrl;
    this.wsUrl = args.wsUrl ?? toWebSocketUrl(args.rpcUrl);
    this.lcdUrl = args.lcdUrl;
    this.headers = { ...(args.headers ?? {}) };
    this.fetchFn = args.fetchFn ?? fetch;
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.closeWs();
  }

  subscribe(cb: (event: ChainEvent) => void): () => void {
    this.subscribers.add(cb);
    void this.ensureWs();
    return () => {
      this.subscribers.delete(cb);
      if (this.subscribers.size === 0) void this.closeWs();
    };
  }

  async listTables(): Promise<TableInfo[]> {
    // Assumption (coordination): x/poker exposes grpc-gateway query routes.
    // - GET /onchainpoker/poker/v1/tables -> { tableIds: [...] } (preferred) OR { tables: [...] }
    // - GET /onchainpoker/poker/v1/tables/{id} -> { table: {...} }
    const json = await fetchJson<any>(this.fetchFn, joinUrl(this.lcdUrl, "/onchainpoker/poker/v1/tables"), this.headers);

    // Variant A: response includes full tables.
    const rawTables: any[] = Array.isArray(json?.tables) ? json.tables : Array.isArray(json?.table) ? json.table : [];
    if (rawTables.length > 0) return rawTables.map((t) => pokerTableToTableInfo(t));

    // Variant B: response only includes ids (current proto).
    const rawIds: any[] = Array.isArray(json?.tableIds) ? json.tableIds : Array.isArray(json?.table_ids) ? json.table_ids : [];
    const ids = rawIds.map((x) => asString(x)).filter(Boolean);
    ids.sort((a, b) => a.localeCompare(b));

    const tables = await Promise.all(ids.map((id) => this.getTable(id).catch(() => null)));
    return tables.filter((t): t is TableInfo => t != null);
  }

  async getTable(tableId: string): Promise<TableInfo | null> {
    const id = String(tableId ?? "").trim();
    if (!id) return null;
    const url = joinUrl(this.lcdUrl, `/onchainpoker/poker/v1/tables/${encodeURIComponent(id)}`);
    const json = await fetchJson<any>(this.fetchFn, url, this.headers).catch(() => null);
    if (!json) return null;
    const t = json.table ?? json;
    const info = pokerTableToTableInfo(t);
    if (!info.tableId) info.tableId = id;
    return info.tableId ? info : null;
  }

  async queryJson<T = unknown>(path: string): Promise<T | null> {
    const p = String(path ?? "").trim();
    if (!p.startsWith("/")) return null;
    const json = await fetchJson<T>(this.fetchFn, joinUrl(this.lcdUrl, p), this.headers).catch(() => null);
    return json;
  }

  private async ensureWs(): Promise<void> {
    if (this.ws || this.subscribers.size === 0) return;

    const ws = new WebSocket(this.wsUrl, { maxPayload: 2 * 1024 * 1024 });
    this.ws = ws;

    const subId = 1;
    let subscribed = false;

    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: subId, method: "subscribe", params: { query: "tm.event='Tx'" } }));
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.id === subId) {
        if (msg.error) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }
        subscribed = true;
        return;
      }

      const txResult = extractTxResult(msg);
      if (!txResult) return;

      const events: CometTxEvent[] = txResult.result?.events ?? txResult.events ?? [];
      if (!Array.isArray(events) || events.length === 0) return;

      const nowMs = Date.now();
      const chainEvents = cosmosEventsToChainEvents(events, { eventIndexStart: this.nextEventIndex, timeMs: nowMs });
      this.nextEventIndex += chainEvents.length;

      for (const ev of chainEvents) {
        for (const cb of this.subscribers) cb(ev);
      }
    });

    const onCloseOrError = () => {
      if (this.ws === ws) this.ws = null;
      if (!subscribed) {
        this.scheduleReconnect(2000);
        return;
      }
      this.scheduleReconnect(250);
    };

    ws.on("close", onCloseOrError);
    ws.on("error", onCloseOrError);
  }

  private scheduleReconnect(ms: number): void {
    if (this.reconnectTimer) return;
    if (this.subscribers.size === 0) return;
    const t = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureWs();
    }, ms);
    t.unref?.();
    this.reconnectTimer = t;
  }

  private async closeWs(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const ws = this.ws;
    this.ws = null;
    if (!ws) return;

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        ws.off("close", cleanup);
        ws.off("error", cleanup);
        resolve();
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
      try {
        ws.close();
      } catch {
        cleanup();
      }
      const t = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        cleanup();
      }, 250);
      t.unref?.();
    });
  }
}
