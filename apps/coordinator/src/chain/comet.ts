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

export function v0TableToTableInfo(v0: any, nowMs = Date.now()): TableInfo {
  const params = v0?.params ?? {};
  const maxPlayers = Number(params.maxPlayers ?? params.max_players ?? 9);
  const smallBlind = String(params.smallBlind ?? params.small_blind ?? "0");
  const bigBlind = String(params.bigBlind ?? params.big_blind ?? "0");
  const minBuyIn = String(params.minBuyIn ?? params.min_buy_in ?? "0");
  const maxBuyIn = String(params.maxBuyIn ?? params.max_buy_in ?? "0");
  const label = String(v0?.label ?? "") || undefined;
  const passwordHash = String(params.passwordHash ?? params.password_hash ?? "") || undefined;

  return {
    tableId: String(v0?.id ?? ""),
    label,
    params: { maxPlayers, smallBlind, bigBlind, minBuyIn, maxBuyIn, passwordHash },
    status: v0?.hand ? "in_hand" : "open",
    updatedAtMs: nowMs
  };
}

export function v0EventsToChainEvents(events: CometTxEvent[] | undefined, base: { eventIndexStart: number; timeMs: number }): ChainEvent[] {
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

export class CometChainAdapter implements ChainAdapter {
  readonly kind = "comet" as const;

  private readonly rpcUrl: string;
  private readonly wsUrl: string;
  private readonly lcdUrl: string;

  private nextEventIndex = 1;

  private ws: WebSocket | null = null;
  private subscribers = new Set<(event: ChainEvent) => void>();
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(args: { rpcUrl: string; wsUrl?: string; lcdUrl?: string }) {
    this.rpcUrl = args.rpcUrl;
    this.wsUrl = args.wsUrl ?? toWebSocketUrl(args.rpcUrl);
    this.lcdUrl = args.lcdUrl ?? "http://127.0.0.1:1317";
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
    const json = await this.lcdFetch<any>("/onchainpoker/poker/v1/tables");
    const rawIds: any[] = Array.isArray(json?.table_ids) ? json.table_ids : Array.isArray(json?.tableIds) ? json.tableIds : [];
    const ids = rawIds.map((x) => String(x)).filter(Boolean);
    ids.sort((a, b) => a.localeCompare(b));

    const tables = await Promise.all(ids.map((id) => this.getTable(id).catch(() => null)));
    return tables.filter((t): t is TableInfo => t != null);
  }

  async getTable(tableId: string): Promise<TableInfo | null> {
    const id = String(tableId ?? "").trim();
    if (!id) return null;
    const json = await this.lcdFetch<any>(`/onchainpoker/poker/v1/tables/${encodeURIComponent(id)}`);
    const v0 = json?.table ?? json;
    if (!v0) return null;
    return v0TableToTableInfo(v0);
  }

  async queryJson<T = unknown>(path: string): Promise<T | null> {
    return this.lcdFetch<T>(path);
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
          // Subscription rejected; close and let reconnection logic handle it.
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

      // CometBFT: txResult.result.events or txResult.events.
      const events: CometTxEvent[] = txResult.result?.events ?? txResult.events ?? [];
      if (!Array.isArray(events) || events.length === 0) return;

      const nowMs = Date.now();
      const chainEvents = v0EventsToChainEvents(events, { eventIndexStart: this.nextEventIndex, timeMs: nowMs });
      this.nextEventIndex += chainEvents.length;

      for (const ev of chainEvents) {
        for (const cb of this.subscribers) cb(ev);
      }
    });

    const onCloseOrError = () => {
      if (this.ws === ws) this.ws = null;
      if (!subscribed) {
        // If we never subscribed, don't hot-loop. (Bad URL, CORS proxy, etc.)
        this.scheduleReconnect(2000);
        return;
      }
      // If we were subscribed, attempt reconnect quickly.
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
      // Force terminate if close hangs.
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

  private async lcdFetch<T>(path: string): Promise<T | null> {
    const u = new URL(this.lcdUrl);
    const basePath = u.pathname.replace(/\/+$/, "");
    const rel = String(path ?? "").trim();
    u.pathname = `${basePath}${rel.startsWith("/") ? "" : "/"}${rel}`;
    const res = await fetch(u.toString());
    if (!res.ok) return null;
    return (await res.json()) as T;
  }
}
