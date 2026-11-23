import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const setting = (text, name) =>
  text.split("\n").filter((line) => line.startsWith(`${name}=`)).map((line) => line.slice(name.length + 1));

// A unit slowed at MemoryHigh keeps running and never restarts. A chain node held there for hours
// fell behind, and its validator was slashed and jailed (2026-11-23).
test("a service over its memory is restarted, never slowed", () => {
  const units = readdirSync(join(root, "deploy")).filter((name) => name.endsWith(".service"));
  assert.ok(units.includes("ocp-chain-node@.service"));
  for (const name of units) {
    const text = readFileSync(join(root, "deploy", name), "utf8");
    assert.deepEqual(setting(text, "MemoryHigh"), [], `${name} sets MemoryHigh`);
    if (setting(text, "MemoryMax").length > 0) {
      assert.deepEqual(setting(text, "Restart"), ["on-failure"], `${name} has a memory cap and does not restart`);
    }
  }
});

test("a new chain node starts with a bounded state-tree cache", () => {
  for (const name of ["production-genesis.sh", "testnet-genesis.sh"]) {
    const text = readFileSync(join(root, "apps/cosmos/scripts", name), "utf8");
    const size = Number(/^IAVL_CACHE_SIZE="(\d+)"$/m.exec(text)?.[1]);
    assert.ok(size > 0 && size < 781250, `${name} leaves the cache at the default size`);
    assert.match(text, /s\/\^iavl-cache-size = \.\*\/iavl-cache-size = \$\{IAVL_CACHE_SIZE\}\//, `${name} never writes the size`);
  }
});
