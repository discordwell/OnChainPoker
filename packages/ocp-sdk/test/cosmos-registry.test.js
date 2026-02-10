import assert from "node:assert/strict";
import test from "node:test";

import { createOcpRegistry, OCP_TYPE_URLS } from "../dist/index.js";

test("Cosmos: createOcpRegistry registers poker msgs and can encode", () => {
  const registry = createOcpRegistry();
  const bytes = registry.encode({
    typeUrl: OCP_TYPE_URLS.poker.createTable,
    value: {
      creator: "ocp1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0l0a7p",
      smallBlind: "1",
      bigBlind: "2",
      minBuyIn: "100",
      maxBuyIn: "1000",
      actionTimeoutSecs: "30",
      dealerTimeoutSecs: "120",
      playerBond: "100",
      rakeBps: 0,
      maxPlayers: 9,
      label: ""
    }
  });
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 0);
});

