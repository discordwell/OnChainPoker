import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createHttpApp } from "../src/http.js";
import { loadConfig, type CoordinatorConfig } from "../src/config.js";
import type { ChainAdapter } from "../src/chain/adapter.js";
import type { ChainEvent, TableInfo } from "../src/types.js";
import { CoordinatorStore } from "../src/store.js";

class StubChainAdapter implements ChainAdapter {
  readonly kind = "mock";

  async listTables(): Promise<TableInfo[]> {
    return [];
  }

  async getTable(_tableId: string): Promise<TableInfo | null> {
    return null;
  }

  subscribe(_cb: (event: ChainEvent) => void): () => void {
    return () => {};
  }
}

async function withHttpServer<T>(
  app: ReturnType<typeof createHttpApp>,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected address()");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeApp(overrides: Partial<CoordinatorConfig> = {}) {
  const chain = new StubChainAdapter();
  const store = new CoordinatorStore({
    artifactMaxBytes: 1_000_000,
    artifactCacheMaxBytes: 10_000_000
  });

  const config: CoordinatorConfig = {
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
    ...overrides
  };

  return createHttpApp({
    config,
    store,
    chain,
    ws: {
      broadcastChainEvent: () => {},
      broadcast: () => {},
      close: async () => {}
    }
  });
}

test("loadConfig uses restrictive production defaults for write/CORS", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production"
      }),
    /COORDINATOR_WRITE_TOKEN must be set when write auth is enabled/
  );

  const cfg = loadConfig({
    NODE_ENV: "production",
    COORDINATOR_WRITE_TOKEN: "secret"
  });
  assert.equal(cfg.requireWriteAuth, true);
  assert.equal(cfg.writeRateLimitEnabled, true);
  assert.equal(cfg.corsOrigins?.length, 0);

  const wild = loadConfig({
    NODE_ENV: "production",
    COORDINATOR_WRITE_TOKEN: "secret",
    CORS_ORIGINS: "*"
  });
  assert.deepEqual(wild.corsOrigins, ["*"]);
});

test("write endpoints require authorization when enabled", async () => {
  const app = makeApp({
    requireWriteAuth: true,
    writeAuthToken: "secret"
  });

  const payload = {
    tableId: "t1",
    seat: 1,
    player: "0xplayer"
  };

  await withHttpServer(app, async (baseUrl) => {
    const noAuth = await fetch(`${baseUrl}/v1/seat-intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(noAuth.status, 401);

    const badAuth = await fetch(`${baseUrl}/v1/seat-intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer wrong"
      },
      body: JSON.stringify(payload)
    });
    assert.equal(badAuth.status, 401);

    const goodAuth = await fetch(`${baseUrl}/v1/seat-intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer secret"
      },
      body: JSON.stringify(payload)
    });
    assert.equal(goodAuth.status, 200);
  });
});

test("write endpoint rate limits requests", async () => {
  const app = makeApp({
    writeRateLimitEnabled: true,
    writeRateLimitMax: 1,
    writeRateLimitWindowMs: 60_000
  });

  const payload = {
    tableId: "t1",
    seat: 1,
    player: "0xplayer"
  };

  await withHttpServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/v1/seat-intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/v1/seat-intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(second.status, 429);
  });
});
