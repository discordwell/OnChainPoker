import type http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { ChainEvent } from "./types.js";
import type { CoordinatorStore } from "./store.js";

type ClientState = {
  subs: Set<string>;
};

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendJson(ws: WebSocket, msg: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

export type WsHub = {
  broadcastChainEvent: (ev: ChainEvent) => void;
  broadcast: (msg: unknown) => void;
  close: () => Promise<void>;
};

export function createWsHub(opts: {
  httpServer: http.Server;
  store: CoordinatorStore;
  path?: string;
}): WsHub {
  const wss = new WebSocketServer({
    server: opts.httpServer,
    path: opts.path ?? "/ws",
    maxPayload: 64 * 1024
  });

  const clients = new Map<WebSocket, ClientState>();

  wss.on("connection", (ws) => {
    const state: ClientState = { subs: new Set() };
    clients.set(ws, state);

    sendJson(ws, {
      type: "welcome",
      nowMs: Date.now(),
      hint: "send {type:'subscribe', topic:'global'} or {type:'subscribe', topic:'table', tableId:'...'}"
    });

    ws.on("message", (raw) => {
      const msg = safeJsonParse(raw.toString("utf8"));
      if (!msg || typeof msg !== "object") return;

      const anyMsg = msg as any;
      if (anyMsg.type === "ping") {
        sendJson(ws, { type: "pong", id: anyMsg.id ?? null, nowMs: Date.now() });
        return;
      }

      if (anyMsg.type === "snapshot") {
        sendJson(ws, { type: "snapshot", tables: opts.store.listTables(), nowMs: Date.now() });
        return;
      }

      if (anyMsg.type === "subscribe") {
        if (anyMsg.topic === "global") {
          state.subs.add("global");
          sendJson(ws, { type: "subscribed", topic: "global" });
          return;
        }
        if (anyMsg.topic === "table" && typeof anyMsg.tableId === "string" && anyMsg.tableId) {
          state.subs.add(`table:${anyMsg.tableId}`);
          sendJson(ws, { type: "subscribed", topic: "table", tableId: anyMsg.tableId });
          return;
        }
        sendJson(ws, { type: "error", error: "invalid subscribe message" });
        return;
      }

      if (anyMsg.type === "unsubscribe") {
        if (anyMsg.topic === "global") {
          state.subs.delete("global");
          sendJson(ws, { type: "unsubscribed", topic: "global" });
          return;
        }
        if (anyMsg.topic === "table" && typeof anyMsg.tableId === "string" && anyMsg.tableId) {
          state.subs.delete(`table:${anyMsg.tableId}`);
          sendJson(ws, { type: "unsubscribed", topic: "table", tableId: anyMsg.tableId });
          return;
        }
        sendJson(ws, { type: "error", error: "invalid unsubscribe message" });
        return;
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  function broadcast(msg: unknown): void {
    for (const ws of wss.clients) sendJson(ws, msg);
  }

  function broadcastChainEvent(ev: ChainEvent): void {
    const topic = ev.tableId ? `table:${ev.tableId}` : null;
    for (const [ws, state] of clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (state.subs.has("global") || (topic && state.subs.has(topic))) {
        sendJson(ws, { type: "event", event: ev });
      }
    }
  }

  async function close(): Promise<void> {
    for (const ws of wss.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      const t = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }, 250);
      t.unref?.();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return { broadcastChainEvent, broadcast, close };
}
