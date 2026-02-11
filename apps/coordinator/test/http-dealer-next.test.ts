import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createHttpApp } from "../src/http.js";
import { CoordinatorStore } from "../src/store.js";
import type { ChainAdapter } from "../src/chain/adapter.js";
import type { ChainEvent, TableInfo } from "../src/types.js";

class StubChainAdapter implements ChainAdapter {
  readonly kind = "comet";
  private readonly responses = new Map<string, unknown>();

  set(path: string, value: unknown): void {
    this.responses.set(path, value);
  }

  async listTables(): Promise<TableInfo[]> {
    return [];
  }

  async getTable(_tableId: string): Promise<TableInfo | null> {
    return null;
  }

  subscribe(_cb: (event: ChainEvent) => void): () => void {
    return () => {};
  }

  async queryJson<T = unknown>(path: string): Promise<T | null> {
    return (this.responses.get(path) as T | undefined) ?? null;
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

function makeApp(chain: StubChainAdapter) {
  const store = new CoordinatorStore({
    artifactMaxBytes: 1_000_000,
    artifactCacheMaxBytes: 10_000_000
  });
  return createHttpApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      corsOrigins: null,
      devRoutes: false,
      artifactMaxBytes: 1_000_000,
      artifactCacheMaxBytes: 10_000_000,
      seatIntentTtlMs: 5_000
    },
    store,
    chain,
    ws: {
      broadcastChainEvent: () => {},
      broadcast: () => {},
      close: async () => {}
    }
  });
}

test("dealer next helper: decodes base64 board bytes for awaitFlop reveal pos", async () => {
  const chain = new StubChainAdapter();
  chain.set("/table/7", {
    id: 7,
    hand: {
      handId: 99,
      phase: "awaitFlop",
      board: "BQ==", // one board card (byte value 5)
      dealer: {
        finalized: true,
        cursor: 6
      }
    }
  });

  const app = makeApp(chain);
  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/appchain/v0/tables/7/dealer/next`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.action?.kind, "reveal");
    assert.equal(json.action?.pos, 7);
  });
});

test("dealer next helper: decodes base64 holePos bytes for awaitShowdown reveal pos", async () => {
  const holePos = Buffer.from([
    2, 5, // seat 0
    0, 3, // seat 1
    1, 4, // seat 2
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255
  ]).toString("base64");

  const chain = new StubChainAdapter();
  chain.set("/table/8", {
    id: 8,
    hand: {
      handId: 100,
      phase: "awaitShowdown",
      inHand: [true, true, true, false, false, false, false, false, false],
      folded: [false, false, true, false, false, false, false, false, false],
      dealer: {
        finalized: true,
        holePos,
        reveals: [{ pos: 0 }, { pos: 2 }]
      }
    }
  });

  const app = makeApp(chain);
  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/appchain/v0/tables/8/dealer/next`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.action?.kind, "reveal");
    // Eligible showdown hole positions from non-folded seats: seat1[0,3], seat0[2,5] -> [0,2,3,5]
    // 0 and 2 are already revealed, so next is 3.
    assert.equal(json.action?.pos, 3);
  });
});
