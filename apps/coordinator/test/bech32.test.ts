import assert from "node:assert/strict";
import test from "node:test";

import { decodeBech32Prefix } from "../src/faucet.js";

const validOcp = "ocp1qyqszqgpqyqszqgpqyqszqgpqyqszqgpnvpqjr";
const validOcp55 = "ocp124242424242424242424242424242424ss69rf";
const validOcpAb = "ocp14w46h2at4w46h2at4w46h2at4w46h2ata36twz";
const validCosmos = "cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
const validCosmosZero = "cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a";
const validCosmosMixed = "cosmos1qv8pjfp08fz4qkmxw97g0y5a4zemajw5xkxy6v";
const validOsmo = "osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgp6gjwmw";

test("decodeBech32Prefix accepts valid ocp address", () => {
  assert.equal(decodeBech32Prefix(validOcp), "ocp");
});

test("decodeBech32Prefix accepts a second valid ocp address (0x55 payload)", () => {
  assert.equal(decodeBech32Prefix(validOcp55), "ocp");
});

test("decodeBech32Prefix accepts a third valid ocp address (0xAB payload)", () => {
  assert.equal(decodeBech32Prefix(validOcpAb), "ocp");
});

test("decodeBech32Prefix accepts a valid cosmos address", () => {
  assert.equal(decodeBech32Prefix(validCosmos), "cosmos");
});

test("decodeBech32Prefix accepts cosmos all-zeros payload", () => {
  assert.equal(decodeBech32Prefix(validCosmosZero), "cosmos");
});

test("decodeBech32Prefix accepts cosmos mixed-payload address", () => {
  assert.equal(decodeBech32Prefix(validCosmosMixed), "cosmos");
});

test("decodeBech32Prefix accepts a valid osmo address", () => {
  assert.equal(decodeBech32Prefix(validOsmo), "osmo");
});

test("decodeBech32Prefix accepts a valid 30-byte payload (longer ocp address)", () => {
  const longerOcp = "ocp1amhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhweghfeu";
  assert.equal(decodeBech32Prefix(longerOcp), "ocp");
});

test("decodeBech32Prefix rejects mixed-case strings (BIP-173)", () => {
  assert.equal(decodeBech32Prefix("Cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du"), null);
  assert.equal(decodeBech32Prefix(validCosmos.toUpperCase().slice(0, 3) + validCosmos.slice(3)), null);
});

test("decodeBech32Prefix rejects empty string", () => {
  assert.equal(decodeBech32Prefix(""), null);
});

test("decodeBech32Prefix rejects too-short strings (no separator)", () => {
  assert.equal(decodeBech32Prefix("ocp"), null);
  assert.equal(decodeBech32Prefix("ocp1"), null);
  assert.equal(decodeBech32Prefix("ocp1q"), null);
  assert.equal(decodeBech32Prefix("ocp1qqqqq"), null);
});

test("decodeBech32Prefix rejects strings missing the '1' separator", () => {
  assert.equal(decodeBech32Prefix("ocpqyqszqgpqyqszqgpqyqszqgpqyqszqgpnvpqjr"), null);
});

test("decodeBech32Prefix rejects strings longer than 90 chars", () => {
  const tooLong = "a".repeat(91);
  assert.equal(decodeBech32Prefix(tooLong), null);
});

test("decodeBech32Prefix rejects invalid charset (contains 'b')", () => {
  const bad = validOcp.slice(0, -1) + "b";
  assert.equal(decodeBech32Prefix(bad), null);
});

test("decodeBech32Prefix rejects invalid charset (contains 'i')", () => {
  const bad = validOcp.slice(0, -2) + "ia";
  assert.equal(decodeBech32Prefix(bad), null);
});

test("decodeBech32Prefix rejects invalid charset (contains 'o')", () => {
  const bad = validOcp.slice(0, -3) + "oab";
  assert.equal(decodeBech32Prefix(bad), null);
});

test("decodeBech32Prefix rejects bad checksum (last char flipped)", () => {
  const bad = validOcp.slice(0, -1) + "a";
  assert.equal(decodeBech32Prefix(bad), null);
});

test("decodeBech32Prefix rejects bad checksum (cosmos last char flipped)", () => {
  const bad = validCosmos.slice(0, -1) + "z";
  assert.equal(decodeBech32Prefix(bad), null);
});

test("decodeBech32Prefix rejects non-string inputs", () => {
  assert.equal(decodeBech32Prefix(undefined as unknown as string), null);
  assert.equal(decodeBech32Prefix(null as unknown as string), null);
  assert.equal(decodeBech32Prefix(123 as unknown as string), null);
});

test("decodeBech32Prefix rejects non-ASCII/control characters", () => {
  assert.equal(decodeBech32Prefix("ocp1\x00qyqszqgpqyqszqgpqyqszqgpqyqszqgpnvpqjr"), null);
  assert.equal(decodeBech32Prefix("ocp1ÿqyqszqgpqyqszqgpqyqszqgpqyqszqgpnvpqjr"), null);
});

test("decodeBech32Prefix returns the HRP, not the configured faucet prefix", () => {
  assert.notEqual(decodeBech32Prefix(validCosmos), "ocp");
  assert.equal(decodeBech32Prefix(validCosmos), "cosmos");
});
