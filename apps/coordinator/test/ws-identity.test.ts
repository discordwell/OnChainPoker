import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import { createCoordinatorServer } from "../src/server.js";
import { MockChainAdapter } from "../src/chain/mock.js";
import { CoordinatorStore } from "../src/store.js";
import type { CoordinatorConfig } from "../src/config.js";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      t.unref?.();
    })
  ]);
}

function nextMessage(ws: WebSocket, predicate: (m: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (predicate(msg)) {
        ws.off("message", onMessage);
        resolve(msg);
      }
    };
    ws.on("message", onMessage);
  });
}

function makeConfig(): CoordinatorConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    corsOrigins: null,
    devRoutes: false,
    artifactMaxBytes: 1_000_000,
    artifactCacheMaxBytes: 10_000_000,
    seatIntentTtlMs: 5_000,
    requireWriteAuth: false,
    writeAuthToken: null,
    writeRateLimitEnabled: false,
    writeRateLimitMax: 30,
    writeRateLimitWindowMs: 60_000,
    faucet: {
      enabled: false,
      mnemonic: null,
      amount: "5000000",
      denom: "uchips",
      cooldownMs: 3_600_000,
      ipCooldownMs: 600_000,
      bech32Prefix: "ocp",
      gasPrice: "0uchips",
      rpcUrl: "http://127.0.0.1:26657",
      lcdUrl: "http://127.0.0.1:1317",
    },
  };
}

async function bootstrap(tableId: string) {
  const chain = new MockChainAdapter();
  chain.createTable(tableId);
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const server = createCoordinatorServer({ config: makeConfig(), chain, store });
  const started = await server.start();
  return { server, baseUrl: started.url };
}

async function openWs(baseUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(baseUrl.replace("http://", "ws://") + "/ws");
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e) => reject(e));
    }),
    2_000,
    "ws open"
  );
  return ws;
}

async function subscribeTable(ws: WebSocket, tableId: string): Promise<void> {
  const p = nextMessage(ws, (m) => m?.type === "subscribed" && m?.topic === "table" && m?.tableId === tableId);
  ws.send(JSON.stringify({ type: "subscribe", topic: "table", tableId }));
  await withTimeout(p, 2_000, "ws subscribed");
}

test("chat sender is server-derived; client-supplied sender is ignored", async () => {
  const { server, baseUrl } = await bootstrap("t1");
  let ws: WebSocket | null = null;
  try {
    ws = await openWs(baseUrl);
    await subscribeTable(ws, "t1");
    const broadcastP = nextMessage(ws, (m) => m?.type === "table_chat" && m?.tableId === "t1");
    ws.send(JSON.stringify({ type: "table_chat", tableId: "t1", text: "x", sender: "ocp1evil" }));
    const msg = await withTimeout(broadcastP, 2_000, "table_chat broadcast");
    assert.notEqual(msg.sender, "ocp1evil");
    assert.ok(typeof msg.sender === "string" && msg.sender.startsWith("anon-"), `expected anon- prefix, got ${msg.sender}`);
    assert.equal(msg.text, "x");
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await server.stop().catch(() => {});
  }
});

test("chat_history senders are anon-prefixed only and stable per connection", async () => {
  const { server, baseUrl } = await bootstrap("t2");
  let ws: WebSocket | null = null;
  try {
    ws = await openWs(baseUrl);
    await subscribeTable(ws, "t2");

    const firstP = nextMessage(ws, (m) => m?.type === "table_chat" && m?.text === "one");
    ws.send(JSON.stringify({ type: "table_chat", tableId: "t2", text: "one", sender: "ocp1impostor" }));
    await withTimeout(firstP, 2_000, "first chat");

    await new Promise((r) => setTimeout(r, 1100));

    const secondP = nextMessage(ws, (m) => m?.type === "table_chat" && m?.text === "two");
    ws.send(JSON.stringify({ type: "table_chat", tableId: "t2", text: "two", sender: "ocp1impostor" }));
    await withTimeout(secondP, 2_000, "second chat");

    const historyP = nextMessage(ws, (m) => m?.type === "chat_history" && m?.tableId === "t2");
    ws.send(JSON.stringify({ type: "chat_history", tableId: "t2" }));
    const history = await withTimeout(historyP, 2_000, "chat_history");
    const messages = history.messages as Array<{ sender: string; text: string }>;
    assert.equal(messages.length, 2);
    for (const m of messages) {
      assert.ok(m.sender.startsWith("anon-"), `expected anon- sender, got ${m.sender}`);
      assert.notEqual(m.sender, "ocp1impostor");
    }
    assert.equal(messages[0]!.sender, messages[1]!.sender);
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await server.stop().catch(() => {});
  }
});

test("subscribe with non-matching tableId regex is rejected", async () => {
  const { server, baseUrl } = await bootstrap("t3");
  let ws: WebSocket | null = null;
  try {
    ws = await openWs(baseUrl);
    const errorP = nextMessage(ws, (m) => m?.type === "error");
    ws.send(JSON.stringify({ type: "subscribe", topic: "table", tableId: "<script>" }));
    const err = await withTimeout(errorP, 2_000, "subscribe error");
    assert.equal(err.error, "invalid subscribe message");
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await server.stop().catch(() => {});
  }
});

test("table_chat to unknown tableId is rejected and creates no chat ring", async () => {
  const chain = new MockChainAdapter();
  chain.createTable("t1");
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const server = createCoordinatorServer({ config: makeConfig(), chain, store });
  const started = await server.start();
  let ws: WebSocket | null = null;
  try {
    ws = await openWs(started.url);
    await subscribeTable(ws, "nonsense99");
    const errP = nextMessage(ws, (m) => m?.type === "error");
    ws.send(JSON.stringify({ type: "table_chat", tableId: "nonsense99", text: "hi" }));
    const err = await withTimeout(errP, 2_000, "unknown table error");
    assert.equal(err.error, "unknown table");
    assert.equal(store.getChatHistory("nonsense99").length, 0);
    assert.equal(store.getTable("nonsense99"), null);

    await subscribeTable(ws, "t1");
    const okP = nextMessage(ws, (m) => m?.type === "table_chat" && m?.tableId === "t1");
    ws.send(JSON.stringify({ type: "table_chat", tableId: "t1", text: "ok" }));
    const ok = await withTimeout(okP, 2_000, "ok chat");
    assert.equal(ok.text, "ok");
    assert.equal(store.getChatHistory("t1").length, 1);
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await server.stop().catch(() => {});
  }
});

test("per-IP rate limit fires across multiple connections from same source", async () => {
  const { server, baseUrl } = await bootstrap("t4");
  const conns: WebSocket[] = [];
  try {
    const NUM_CONNS = 8;
    for (let i = 0; i < NUM_CONNS; i++) {
      const ws = await openWs(baseUrl);
      await subscribeTable(ws, "t4");
      conns.push(ws);
    }

    const sendOn = async (ws: WebSocket, idx: number): Promise<any> => {
      const p = nextMessage(ws, (m) => m?.type === "table_chat" || m?.type === "error");
      ws.send(JSON.stringify({ type: "table_chat", tableId: "t4", text: `m${idx}` }));
      return withTimeout(p, 2_000, `msg ${idx}`);
    };

    // Align with a fresh minute window. The per-IP bucket key is Math.floor(now/60_000),
    // so all 31 sends must land in the same minute. We wait until at least 5s remain.
    while (Date.now() % 60_000 > 55_000) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // 30 messages across 8 connections; same-WS gap is ~8 iterations × ~200ms ≈ 1.6s
    // which is comfortably above the per-WS 1 msg/sec limit. Total wall time ~6s.
    let received = 0;
    for (let i = 0; i < 30; i++) {
      const ws = conns[i % NUM_CONNS]!;
      const m = await sendOn(ws, i);
      if (m?.type === "error") {
        if (m.error === "chat rate limited (per-ip)") {
          assert.fail(`per-ip rate limit fired too early at message ${i}`);
        }
        assert.fail(`unexpected error at message ${i}: ${JSON.stringify(m)}`);
      }
      received++;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(received, 30);

    // 31st send hits the per-IP cap on any conn (different conn to avoid per-WS interaction).
    const m31 = await sendOn(conns[0]!, 30);
    assert.equal(m31?.type, "error");
    assert.equal(m31?.error, "chat rate limited (per-ip)");
  } finally {
    for (const c of conns) {
      try { c.close(); } catch { /* ignore */ }
    }
    await server.stop().catch(() => {});
  }
});
