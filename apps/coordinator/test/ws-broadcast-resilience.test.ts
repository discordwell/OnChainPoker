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

async function subscribeGlobal(ws: WebSocket): Promise<void> {
  const p = nextMessage(ws, (m) => m?.type === "subscribed" && m?.topic === "global");
  ws.send(JSON.stringify({ type: "subscribe", topic: "global" }));
  await withTimeout(p, 2_000, "ws subscribed global");
}

// A chain event whose `data` carries a BigInt is unserializable: `JSON.stringify`
// throws inside `sendJson`. Before sendJson was made total, that throw propagated
// out of `broadcastChainEvent` and, in the real chain adapters, escaped the RPC
// WebSocket message handler as an uncaught exception — crashing the whole
// coordinator and disconnecting every player. This test pins that a poisoned
// event is dropped for that client while the relay stays up and keeps delivering.
test("an unserializable chain event does not crash the relay (sendJson is total)", async () => {
  const chain = new MockChainAdapter();
  chain.createTable("t1");
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const server = createCoordinatorServer({ config: makeConfig(), chain, store });
  const started = await server.start();

  let ws: WebSocket | null = null;
  try {
    ws = await openWs(started.url);
    await subscribeGlobal(ws);

    // Publishing an event with a BigInt in `data` must NOT throw: the subscriber
    // chain runs synchronously through broadcastChainEvent -> sendJson, and the
    // mock re-emits any listener throw out of publishEvent.
    assert.doesNotThrow(() => {
      chain.publishEvent({ name: "Poisoned", tableId: "t1", data: { big: 10n } });
    });

    // The relay survived: a subsequent, well-formed event is still delivered.
    const evP = nextMessage(ws, (m) => m?.type === "event" && m?.event?.name === "HandStarted");
    chain.startHand("t1", "1");
    const got = await withTimeout(evP, 2_000, "normal event after poisoned one");
    assert.equal(got.event.tableId, "t1");
    assert.equal(got.event.handId, "1");
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await server.stop().catch(() => {});
  }
});
