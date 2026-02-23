import type http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { ChainEvent } from "./types.js";
import type { CoordinatorStore } from "./store.js";

type ClientState = {
  subs: Set<string>;
  lastChatMs?: number;
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
  broadcastToTopic: (topic: string, msg: unknown) => void;
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

      if (anyMsg.type === "table_chat") {
        const tableId = typeof anyMsg.tableId === "string" ? anyMsg.tableId : "";
        const text = typeof anyMsg.text === "string" ? anyMsg.text.slice(0, 200) : "";
        const sender = typeof anyMsg.sender === "string" ? anyMsg.sender : "";
        if (!tableId || !text || !sender) {
          sendJson(ws, { type: "error", error: "table_chat requires tableId, text, sender" });
          return;
        }
        if (!state.subs.has(`table:${tableId}`)) {
          sendJson(ws, { type: "error", error: "not subscribed to table" });
          return;
        }
        const now = Date.now();
        if (state.lastChatMs && now - state.lastChatMs < 1000) {
          sendJson(ws, { type: "error", error: "chat rate limited (1 msg/sec)" });
          return;
        }
        state.lastChatMs = now;
        const chatMsg = { sender, text, timeMs: now };
        opts.store.addChatMessage(tableId, chatMsg);
        broadcastToTopic(`table:${tableId}`, { type: "table_chat", tableId, ...chatMsg });
        return;
      }

      if (anyMsg.type === "chat_history") {
        const tableId = typeof anyMsg.tableId === "string" ? anyMsg.tableId : "";
        if (!tableId) {
          sendJson(ws, { type: "error", error: "chat_history requires tableId" });
          return;
        }
        sendJson(ws, { type: "chat_history", tableId, messages: opts.store.getChatHistory(tableId) });
        return;
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  function broadcastToTopic(topic: string, msg: unknown): void {
    for (const [ws, state] of clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (state.subs.has(topic)) sendJson(ws, msg);
    }
  }

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

  return { broadcastChainEvent, broadcastToTopic, broadcast, close };
}
