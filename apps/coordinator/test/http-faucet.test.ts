import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createHttpApp } from "../src/http.js";
import { loadConfig, type CoordinatorConfig, type FaucetConfig } from "../src/config.js";
import type { ChainAdapter } from "../src/chain/adapter.js";
import type { ChainEvent, TableInfo } from "../src/types.js";
import { CoordinatorStore } from "../src/store.js";
import type { FaucetService, FaucetStatus, FaucetDripResult } from "../src/faucet.js";

class StubChainAdapter implements ChainAdapter {
  readonly kind = "mock";
  async listTables(): Promise<TableInfo[]> { return []; }
  async getTable(): Promise<TableInfo | null> { return null; }
  subscribe(): () => void { return () => {}; }
}

const defaultFaucetConfig: FaucetConfig = {
  enabled: false,
  mnemonic: null,
  amount: "10000000",
  denom: "uchips",
  cooldownMs: 3_600_000,
  ipCooldownMs: 600_000,
  bech32Prefix: "ocp",
  gasPrice: "0uchips",
  rpcUrl: "http://127.0.0.1:26657",
  lcdUrl: "http://127.0.0.1:1317",
};

function makeConfig(overrides: Partial<CoordinatorConfig> = {}): CoordinatorConfig {
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
    faucet: defaultFaucetConfig,
    ...overrides,
  };
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

class MockFaucetService {
  private dripCount = 0;
  private shouldFail = false;
  private failStatus = 429;
  private failMessage = "rate limited";
  private failRetryAfter = 60;

  setFail(status: number, message: string, retryAfter = 60) {
    this.shouldFail = true;
    this.failStatus = status;
    this.failMessage = message;
    this.failRetryAfter = retryAfter;
  }

  getStatus(): FaucetStatus {
    return {
      enabled: true,
      address: "ocp1faucetaddr",
      amount: "10000000",
      denom: "uchips",
      cooldownSecs: 3600,
    };
  }

  async drip(address: string, _clientIp: string): Promise<FaucetDripResult> {
    if (this.shouldFail) {
      const err = new Error(this.failMessage) as any;
      err.status = this.failStatus;
      err.retryAfter = this.failRetryAfter;
      throw err;
    }
    this.dripCount++;
    return {
      txHash: `HASH${this.dripCount}`,
      amount: "10000000",
      denom: "uchips",
    };
  }

  stop() {}

  getDripCount() { return this.dripCount; }
}

test("GET /v1/faucet/status returns disabled when no faucet", async () => {
  const config = makeConfig();
  const chain = new StubChainAdapter();
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const app = createHttpApp({
    config, store, chain,
    ws: { broadcastChainEvent: () => {}, broadcastToTopic: () => {}, broadcast: () => {}, close: async () => {} },
  });

  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/faucet/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.enabled, false);
  });
});

test("GET /v1/faucet/status returns enabled with faucet service", async () => {
  const config = makeConfig();
  const chain = new StubChainAdapter();
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const faucet = new MockFaucetService();
  const app = createHttpApp({
    config, store, chain, faucet: faucet as unknown as FaucetService,
    ws: { broadcastChainEvent: () => {}, broadcastToTopic: () => {}, broadcast: () => {}, close: async () => {} },
  });

  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/faucet/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.enabled, true);
    assert.equal(data.address, "ocp1faucetaddr");
    assert.equal(data.amount, "10000000");
  });
});

test("POST /v1/faucet drips tokens", async () => {
  const config = makeConfig();
  const chain = new StubChainAdapter();
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const faucet = new MockFaucetService();
  const app = createHttpApp({
    config, store, chain, faucet: faucet as unknown as FaucetService,
    ws: { broadcastChainEvent: () => {}, broadcastToTopic: () => {}, broadcast: () => {}, close: async () => {} },
  });

  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "ocp1testaddr" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.txHash, "HASH1");
    assert.equal(data.amount, "10000000");
    assert.equal(faucet.getDripCount(), 1);
  });
});

test("POST /v1/faucet returns 400 without address", async () => {
  const config = makeConfig();
  const chain = new StubChainAdapter();
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const faucet = new MockFaucetService();
  const app = createHttpApp({
    config, store, chain, faucet: faucet as unknown as FaucetService,
    ws: { broadcastChainEvent: () => {}, broadcastToTopic: () => {}, broadcast: () => {}, close: async () => {} },
  });

  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /v1/faucet returns 429 on rate limit", async () => {
  const config = makeConfig();
  const chain = new StubChainAdapter();
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const faucet = new MockFaucetService();
  faucet.setFail(429, "rate limited", 30);
  const app = createHttpApp({
    config, store, chain, faucet: faucet as unknown as FaucetService,
    ws: { broadcastChainEvent: () => {}, broadcastToTopic: () => {}, broadcast: () => {}, close: async () => {} },
  });

  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "ocp1testaddr" }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "30");
  });
});

test("POST /v1/faucet returns 404 when faucet disabled", async () => {
  const config = makeConfig();
  const chain = new StubChainAdapter();
  const store = new CoordinatorStore({ artifactMaxBytes: 1_000_000, artifactCacheMaxBytes: 10_000_000 });
  const app = createHttpApp({
    config, store, chain,
    ws: { broadcastChainEvent: () => {}, broadcastToTopic: () => {}, broadcast: () => {}, close: async () => {} },
  });

  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "ocp1testaddr" }),
    });
    assert.equal(res.status, 404);
  });
});

test("loadConfig parses faucet env vars", () => {
  const cfg = loadConfig({
    FAUCET_ENABLED: "true",
    FAUCET_MNEMONIC: "test mnemonic words",
    FAUCET_AMOUNT: "5000000",
    FAUCET_COOLDOWN_SECS: "1800",
    FAUCET_IP_COOLDOWN_SECS: "300",
  });
  assert.equal(cfg.faucet.enabled, true);
  assert.equal(cfg.faucet.mnemonic, "test mnemonic words");
  assert.equal(cfg.faucet.amount, "5000000");
  assert.equal(cfg.faucet.cooldownMs, 1_800_000);
  assert.equal(cfg.faucet.ipCooldownMs, 300_000);
});
