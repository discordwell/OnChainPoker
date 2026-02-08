import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcTransport } from "../dist/appchain/transports/jsonrpc.js";

test("JsonRpcTransport.request() sends JSON-RPC 2.0 payload", async () => {
  const originalFetch = globalThis.fetch;
  try {
    /** @type {{url?: string, opts?: any}} */
    const seen = {};

    globalThis.fetch = async (url, opts) => {
      seen.url = String(url);
      seen.opts = opts;
      const req = JSON.parse(String(opts?.body ?? "{}"));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const t = new JsonRpcTransport({ url: "http://example.invalid/rpc" });
    const res = await t.request("ocp_getTable", { tableId: "1" });
    assert.deepEqual(res, { ok: true });

    assert.equal(seen.url, "http://example.invalid/rpc");
    assert.equal(seen.opts.method, "POST");

    const body = JSON.parse(String(seen.opts.body));
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.method, "ocp_getTable");
    assert.deepEqual(body.params, { tableId: "1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JsonRpcTransport.request() throws on JSON-RPC error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, opts) => {
      const req = JSON.parse(String(opts?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "boom" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const t = new JsonRpcTransport({ url: "http://example.invalid/rpc" });
    await assert.rejects(() => t.request("ocp_getTable", { tableId: "1" }), /JSON-RPC error -32000: boom/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

