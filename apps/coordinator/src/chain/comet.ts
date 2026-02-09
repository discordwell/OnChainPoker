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

function attrsToObject(attrs: CometTxEventAttr[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    if (!a || typeof a.key !== "string") continue;
    out[a.key] = String(a.value ?? "");
  }
  return out;
}

export function v0TableToTableInfo(v0: any, nowMs = Date.now()): TableInfo {
  const params = v0?.params ?? {};
  const maxPlayers = Number(params.maxPlayers ?? 9);
  const smallBlind = String(params.smallBlind ?? "0");
  const bigBlind = String(params.bigBlind ?? "0");
  const minBuyIn = String(params.minBuyIn ?? "0");
  const maxBuyIn = String(params.maxBuyIn ?? "0");

  return {
    tableId: String(v0?.id ?? ""),
    params: { maxPlayers, smallBlind, bigBlind, minBuyIn, maxBuyIn },
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

  private nextEventIndex = 1;

  private ws: WebSocket | null = null;
  private subscribers = new Set<(event: ChainEvent) => void>();
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(args: { rpcUrl: string; wsUrl?: string }) {
    this.rpcUrl = args.rpcUrl;
    this.wsUrl = args.wsUrl ?? toWebSocketUrl(args.rpcUrl);
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
    const ids = await this.abciQueryJson<number[]>("/tables");
    const norm = (ids ?? []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
    norm.sort((a, b) => a - b);

    const tables = await Promise.all(norm.map((id) => this.getTable(String(id))));
    return tables.filter((t): t is TableInfo => t != null);
  }

  async getTable(tableId: string): Promise<TableInfo | null> {
    const id = String(tableId ?? "").trim();
    if (!id) return null;
    const v0 = await this.abciQueryJson<any>(`/table/${id}`);
    if (!v0) return null;
    return v0TableToTableInfo(v0);
  }

  async queryJson<T = unknown>(path: string): Promise<T | null> {
    return this.abciQueryJson<T>(path);
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

  private async cometRpc<T>(method: string, params?: unknown): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") throw new Error("comet rpc: invalid json");
    if ((json as any).error) throw new Error(`comet rpc error: ${JSON.stringify((json as any).error)}`);
    return (json as any).result as T;
  }

  private async abciQueryJson<T>(path: string): Promise<T | null> {
    const result = await this.cometRpc<any>("abci_query", { path });
    const valueB64 = result?.response?.value ?? "";
    if (!valueB64) return null;
    const bytes = Buffer.from(String(valueB64), "base64");
    return JSON.parse(bytes.toString("utf8")) as T;
  }
}
