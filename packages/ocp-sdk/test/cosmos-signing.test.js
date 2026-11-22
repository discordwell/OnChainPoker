import assert from "node:assert/strict";
import test from "node:test";

import { walletFromPrivKey } from "../dist/index.js";

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
