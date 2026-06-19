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
      seatIntentTtlMs: 5_000,
      requireWriteAuth: false,
      writeAuthToken: null,
      writeRateLimitEnabled: false,
      writeRateLimitMax: 30,
      writeRateLimitWindowMs: 60_000,
      faucet: {
        enabled: false, mnemonic: null, amount: "5000000", denom: "uchips",
        cooldownMs: 3_600_000, ipCooldownMs: 600_000, bech32Prefix: "ocp",
        gasPrice: "0uchips", rpcUrl: "http://127.0.0.1:26657", lcdUrl: "http://127.0.0.1:1317",
      },
    },
    store,
    chain,
    ws: {
      broadcastChainEvent: () => {},
      broadcastToTopic: () => {},
      broadcast: () => {},
      close: async () => {}
    }
  });
}

// A realistic dealer-module DealerHand JSON (snake_case as the LCD returns it).
// pos 0 + 1 are seat 0's two hole cards; each card has one enc-share per
// validator, tagged with that validator's Shamir index.
const DEALER_HAND = {
  hand: {
    epoch_id: 42,
    deck_size: 52,
    finalized: true,
    deck: [
      { c1: "YzFfcG9zMA==", c2: "YzJfcG9zMA==" }, // pos 0
      { c1: "YzFfcG9zMQ==", c2: "YzJfcG9zMQ==" }  // pos 1
    ],
    enc_shares: [
      { pos: 0, validator: "ocpvaloper1aaa", index: 1, enc_share: "c2hhcmUwMQ==", pk_player: "cGsw", proof: "cHJvb2Yw" },
      { pos: 0, validator: "ocpvaloper1bbb", index: 2, enc_share: "c2hhcmUwMg==", pk_player: "cGsw", proof: "cHJvb2Yx" },
      { pos: 1, validator: "ocpvaloper1aaa", index: 1, enc_share: "c2hhcmUxMQ==", pk_player: "cGsw", proof: "cHJvb2Yy" },
      { pos: 1, validator: "ocpvaloper1bbb", index: 2, enc_share: "c2hhcmUxMg==", pk_player: "cGsw", proof: "cHJvb2Yz" }
    ]
  }
};

const DEALER_PATH = "/onchainpoker/dealer/v1/tables/5/hands/42";

test("enc-shares route forwards each validator's Shamir index and filters by pos", async () => {
  const chain = new StubChainAdapter();
  chain.set(DEALER_PATH, DEALER_HAND);

  const app = makeApp(chain);
  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/dealer/hand/5/42/enc-shares/0`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.shares.length, 2, "only pos-0 shares returned");
    // The index MUST be present — without it the client cannot run the
    // Lagrange interpolation and hole-card recovery fails.
    assert.deepEqual(
      json.shares.map((s: any) => s.index).sort(),
      [1, 2]
    );
    assert.equal(json.shares[0].validator, "ocpvaloper1aaa");
    assert.equal(json.shares[0].encShare, "c2hhcmUwMQ==");
    assert.equal(json.shares[0].proofEncShare, "cHJvb2Yw");
    assert.equal(json.shares[0].pkPlayer, "cGsw");
  });
});

test("ciphertext route returns the deck entry from the dealer module", async () => {
  const chain = new StubChainAdapter();
  chain.set(DEALER_PATH, DEALER_HAND);

  const app = makeApp(chain);
  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/dealer/hand/5/42/ciphertext/1`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.c1, "YzFfcG9zMQ==");
    assert.equal(json.c2, "YzJfcG9zMQ==");
  });
});

test("enc-shares route 404s when the dealer hand is absent", async () => {
  const chain = new StubChainAdapter();
  // No dealer-hand response registered.
  const app = makeApp(chain);
  await withHttpServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/dealer/hand/5/42/enc-shares/0`);
    assert.equal(res.status, 404);
  });
});

test("regression: dealer routes read the dealer module, NOT the poker table.hand.dealer", async () => {
  // The poker module's table.hand.dealer (DealerMeta) has no deck or enc_shares,
  // so reading from it always yielded empty data and broke hole-card recovery.
  // Register a (bogus) poker table that carries deck/shares but leave the dealer
  // module endpoint empty: the routes must NOT fall back to the poker table.
  const chain = new StubChainAdapter();
  chain.set("/onchainpoker/poker/v1/tables/5", {
    table: {
      id: 5,
      hand: {
        handId: 42,
        dealer: {
          deck: [{ c1: "WkVST18=", c2: "WkVST18=" }, { c1: "WkVST18=", c2: "WkVST18=" }],
          encShares: [{ pos: 0, validator: "phantom", index: 9, encShare: "WkVST18=" }]
        }
      }
    }
  });

  const app = makeApp(chain);
  await withHttpServer(app, async (baseUrl) => {
    const encRes = await fetch(`${baseUrl}/v1/dealer/hand/5/42/enc-shares/0`);
    assert.equal(encRes.status, 404, "must not source shares from the poker table");
    const ctRes = await fetch(`${baseUrl}/v1/dealer/hand/5/42/ciphertext/0`);
    assert.equal(ctRes.status, 404, "must not source ciphertext from the poker table");
  });
});
