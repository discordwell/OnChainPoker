import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createCoordinatorServer } from "../src/server.js";
import { MockChainAdapter } from "../src/chain/mock.js";
import { CoordinatorStore } from "../src/store.js";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      t.unref?.();
    })
  ]);
}

function waitForWsEvent(ws: WebSocket, predicate: (msg: any) => boolean): Promise<any> {
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

test("WS8 acceptance: coordinator outage does not block direct chain queries", async () => {
  const chain = new MockChainAdapter();
  chain.createTable("t1");

  const store = new CoordinatorStore({
    artifactMaxBytes: 1_000_000,
    artifactCacheMaxBytes: 10_000_000
  });

  const server = createCoordinatorServer({
    config: {
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
      writeRateLimitWindowMs: 60_000
    },
    chain,
    store
  });

  const started = await server.start();
  const baseUrl = started.url;

  let ws: WebSocket | null = null;
  try {
    // Sanity: coordinator exposes table list.
    const tablesRes = await fetch(`${baseUrl}/v1/tables`);
    assert.equal(tablesRes.status, 200);
    const tablesJson = (await tablesRes.json()) as any;
    assert.equal(Array.isArray(tablesJson.tables), true);
    assert.equal(tablesJson.tables.some((t: any) => t.tableId === "t1"), true);

    // Subscribe via WS for events (UX path).
    ws = new WebSocket(baseUrl.replace("http://", "ws://") + "/ws");
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws!.once("open", () => resolve());
        ws!.once("error", (e) => reject(e));
      }),
      2_000,
      "ws open"
    );
    const subscribedP = waitForWsEvent(
      ws,
      (m) => m?.type === "subscribed" && m?.topic === "table" && m?.tableId === "t1"
    );
    ws.send(JSON.stringify({ type: "subscribe", topic: "table", tableId: "t1" }));
    await withTimeout(subscribedP, 2_000, "ws subscribed");

    // Emit an in-hand event and ensure it arrives via coordinator.
    const startedP = waitForWsEvent(ws, (m) => m?.type === "event" && m?.event?.name === "HandStarted");
    chain.startHand("t1", "h1");
    await withTimeout(startedP, 2_000, "HandStarted event via coordinator");

    // Coordinator goes offline mid-hand.
    const wsClosedP = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    await server.stop();
    await withTimeout(wsClosedP, 3_000, "ws close on shutdown");

    // Chain continues to progress (authoritative path).
    chain.completeHand("t1", "h1");

    const t1 = await chain.getTable("t1");
    assert.ok(t1);
    assert.equal(t1.status, "open");

    // Client can query chain directly for missed events.
    const missed = chain.getEventsSince(0);
    assert.equal(missed.some((e) => e.name === "HandCompleted"), true);
  } finally {
    try {
      ws?.close();
    } catch {
      // ignore
    }
    await server.stop().catch(() => {});
  }
});
