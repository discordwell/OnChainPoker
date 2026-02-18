import assert from "node:assert/strict";
import test from "node:test";

import { SigningStargateClient } from "@cosmjs/stargate";
import { connectOcpCosmosSigningClient, walletFromPrivKey } from "../dist/index.js";

test("Cosmos signing: walletFromPrivKey accepts 0x-prefixed and bare hex with prefix", async () => {
  const privateKeyHex = "11".repeat(32);
  const a = await walletFromPrivKey({ privateKeyHex, prefix: "ocp" });
  const b = await walletFromPrivKey({ privateKeyHex: `0x${privateKeyHex}`, prefix: "ocp" });

  const aAddr = (await a.getAccounts())[0]?.address ?? "";
  const bAddr = (await b.getAccounts())[0]?.address ?? "";
  assert.match(aAddr, /^ocp1/);
  assert.equal(aAddr, bAddr);
});

test("Cosmos signing: walletFromPrivKey rejects non-32-byte hex", async () => {
  await assert.rejects(
    () => walletFromPrivKey({ privateKeyHex: "abcd", prefix: "ocp" }),
    /private key must be 32-byte hex/,
  );
});

test("Cosmos signing: signAndBroadcastAuto uses LCD polling fallback when lcdUrl is set", async () => {
  const originalConnect = SigningStargateClient.connectWithSigner;
  const originalFetch = globalThis.fetch;

  let simulateCalls = 0;
  let syncCalls = 0;
  let broadcastCalls = 0;
  let fetchCalls = 0;
  try {
    SigningStargateClient.connectWithSigner = async () => ({
      simulate: async () => {
        simulateCalls += 1;
        return 123_456;
      },
      signAndBroadcastSync: async (_address, _msgs, _fee, _memo) => {
        syncCalls += 1;
        return "abcd12";
      },
      signAndBroadcast: async () => {
        broadcastCalls += 1;
        return { code: 999 };
      },
    });

    globalThis.fetch = async (url) => {
      fetchCalls += 1;
      assert.equal(String(url), "http://127.0.0.1:1317/cosmos/tx/v1beta1/txs/ABCD12");
      return new Response(
        JSON.stringify({
          tx_response: {
            height: "22",
            tx_index: 3,
            code: 0,
            txhash: "abcd12",
            raw_log: "",
            events: [{ type: "poker", attributes: [{ key: "tableId", value: "1" }] }],
            gas_wanted: "150000",
            gas_used: "123456",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const signing = await connectOcpCosmosSigningClient({
      rpcUrl: "http://127.0.0.1:26657",
      signer: {
        async getAccounts() {
          return [{ address: "ocp1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz0m3v8" }];
        },
      },
      gasPrice: "0uocp",
      lcdUrl: "http://127.0.0.1:1317",
    });

    const out = await signing.signAndBroadcastAuto([]);
    assert.equal(out.height, 22);
    assert.equal(out.txIndex, 3);
    assert.equal(out.code, 0);
    assert.equal(out.transactionHash, "ABCD12");
    assert.equal(out.gasWanted, 150000n);
    assert.equal(out.gasUsed, 123456n);

    assert.equal(simulateCalls, 1);
    assert.equal(syncCalls, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(broadcastCalls, 0);
  } finally {
    SigningStargateClient.connectWithSigner = originalConnect;
    globalThis.fetch = originalFetch;
  }
});

test("Cosmos signing: signAndBroadcastAuto uses direct broadcast when lcdUrl is omitted", async () => {
  const originalConnect = SigningStargateClient.connectWithSigner;

  let simulateCalls = 0;
  let syncCalls = 0;
  let broadcastCalls = 0;
  try {
    const expected = {
      height: 9,
      txIndex: 0,
      code: 0,
      transactionHash: "ABCDEF",
      events: [],
      rawLog: "",
      msgResponses: [],
      gasWanted: 100000n,
      gasUsed: 90000n,
    };

    SigningStargateClient.connectWithSigner = async () => ({
      simulate: async () => {
        simulateCalls += 1;
        return 100_000;
      },
      signAndBroadcastSync: async () => {
        syncCalls += 1;
        return "ignored";
      },
      signAndBroadcast: async () => {
        broadcastCalls += 1;
        return expected;
      },
    });

    const signing = await connectOcpCosmosSigningClient({
      rpcUrl: "http://127.0.0.1:26657",
      signer: {
        async getAccounts() {
          return [{ address: "ocp1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz0m3v8" }];
        },
      },
      gasPrice: "0uocp",
    });

    const out = await signing.signAndBroadcastAuto([]);
    assert.deepEqual(out, expected);
    assert.equal(simulateCalls, 1);
    assert.equal(syncCalls, 0);
    assert.equal(broadcastCalls, 1);
  } finally {
    SigningStargateClient.connectWithSigner = originalConnect;
  }
});
