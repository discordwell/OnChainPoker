import assert from "node:assert/strict";
import test from "node:test";

import { clientIpFromForwarded } from "../src/clientIp.js";

test("no X-Forwarded-For header → uses the direct socket IP", () => {
  assert.equal(clientIpFromForwarded(undefined, "10.0.0.5"), "10.0.0.5");
  assert.equal(clientIpFromForwarded("", "10.0.0.5"), "10.0.0.5");
});

test("single trusted proxy: uses the proxy-appended right-most hop, not a spoofed prefix", () => {
  // nginx `$proxy_add_x_forwarded_for` yields "<client-sent>, <real-peer>".
  // The real client is the LAST element; a forged prefix must be ignored.
  assert.equal(clientIpFromForwarded("9.9.9.9, 203.0.113.7", "127.0.0.1", 1), "203.0.113.7");
  assert.equal(clientIpFromForwarded("evil, 1.2.3.4, 203.0.113.7", "127.0.0.1", 1), "203.0.113.7");
});

test("single trusted proxy, honest client: uses the only hop", () => {
  assert.equal(clientIpFromForwarded("203.0.113.7", "127.0.0.1", 1), "203.0.113.7");
});

test("spoofed XFF cannot mint distinct rate-limit keys (the bypass this fixes)", () => {
  // Same real client, different forged prefixes → must resolve to ONE key.
  const a = clientIpFromForwarded("aaa, 203.0.113.7", "127.0.0.1", 1);
  const b = clientIpFromForwarded("bbb.bbb, 203.0.113.7", "127.0.0.1", 1);
  assert.equal(a, "203.0.113.7");
  assert.equal(a, b);
});

test("two trusted proxies: counts hops from the right", () => {
  // client-spoof, cdn-appended-client, nginx-appended-cdn
  assert.equal(
    clientIpFromForwarded("evil, 203.0.113.7, 198.51.100.1", "127.0.0.1", 2),
    "203.0.113.7"
  );
});

test("fewer hops than trusted count → fail safe to the direct socket IP", () => {
  assert.equal(clientIpFromForwarded("203.0.113.7", "127.0.0.1", 2), "127.0.0.1");
});

test("trustedHops = 0 ignores X-Forwarded-For entirely (no proxy in front)", () => {
  assert.equal(clientIpFromForwarded("203.0.113.7", "127.0.0.1", 0), "127.0.0.1");
});

test("array header value is normalized before parsing", () => {
  assert.equal(clientIpFromForwarded(["9.9.9.9, 203.0.113.7"], "127.0.0.1", 1), "203.0.113.7");
  assert.equal(clientIpFromForwarded(["9.9.9.9", "203.0.113.7"], "127.0.0.1", 1), "203.0.113.7");
});

test("empty direct IP falls back to 'unknown'", () => {
  assert.equal(clientIpFromForwarded(undefined, "", 1), "unknown");
});
