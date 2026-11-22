import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CosmosLcdClient, OCP_TYPE_URLS, createOcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import { DealerDaemon } from "../src/daemon.js";
import type { DealerDaemonConfig } from "../src/config.js";

type LcdAnswer = { status: number; body: unknown } | "refused";

// The real SDK client over a fake LCD, so the test sees what the SDK makes of a failed read.
function daemonAgainst(lcd: Record<string, LcdAnswer>) {
  const sent: string[] = [];
  const fetchFn = (async (url: string) => {
    const path = new URL(url).pathname;
    const answer = lcd[path] ?? { status: 404, body: { message: "not found" } };
    if (answer === "refused") throw new TypeError("fetch failed");
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: "",
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
    };
  }) as unknown as typeof fetch;

  const client = createOcpCosmosClient({
    signing: {
      address: "ocp1caller",
      client: {} as any,
      signAndBroadcastAuto: async (msgs) => {
        sent.push(...msgs.map((m) => m.typeUrl));
        return { code: 0, events: [] } as any;
      },
    },
    lcd: new CosmosLcdClient({ baseUrl: "http://127.0.0.1:1317", fetchFn }),
  });

  const config: DealerDaemonConfig = {
    validatorAddress: "ocpvaloper1me",
    cosmosRpcUrl: "http://127.0.0.1:26657",
    cosmosLcdUrl: "http://127.0.0.1:1317",
    bech32Prefix: "ocp",
    gasPrice: "0uchips",
    stateDir: "/nonexistent",
    statePassphrase: "",
    autoBeginEpoch: true,
    autoInitHand: true,
    autoFinalize: true,
    pollIntervalMs: 3_600_000,
    committeeSize: 3,
    threshold: 2,
    shuffleRounds: 4,
  };
  const daemon = new DealerDaemon({ client, config, stateStore: {} as any });
  return { daemon, sent };
}

async function pollOnce(daemon: DealerDaemon): Promise<void> {
  await daemon.start();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  await daemon.stop();
}

const EPOCH = "/onchainpoker/dealer/v1/epoch";
const DKG = "/onchainpoker/dealer/v1/dkg";
const NO_EPOCH: LcdAnswer = { status: 200, body: { epoch: null } };
const NO_DKG: LcdAnswer = { status: 200, body: { dkg: null } };

describe("rule 1: a failed chain read is not an absent epoch", () => {
  it("sends nothing to the chain when the LCD refuses the epoch query", async () => {
    const { daemon, sent } = daemonAgainst({ [EPOCH]: "refused", [DKG]: "refused" });
    await pollOnce(daemon);
    assert.deepEqual(sent, []);
  });

  it("sends nothing to the chain when the epoch query answers an HTTP error", async () => {
    const { daemon, sent } = daemonAgainst({
      [EPOCH]: { status: 500, body: { code: 2, message: "query failed" } },
      [DKG]: NO_DKG,
    });
    await pollOnce(daemon);
    assert.deepEqual(sent, []);
  });

  it("sends nothing to the chain when the chain has no epoch but the DKG query fails", async () => {
    const { daemon, sent } = daemonAgainst({ [EPOCH]: NO_EPOCH, [DKG]: "refused" });
    await pollOnce(daemon);
    assert.deepEqual(sent, []);
  });

  it("begins an epoch when the chain answers that there is no epoch and no DKG", async () => {
    const { daemon, sent } = daemonAgainst({ [EPOCH]: NO_EPOCH, [DKG]: NO_DKG });
    await pollOnce(daemon);
    assert.ok(
      sent.includes(OCP_TYPE_URLS.dealer.beginEpoch),
      `expected MsgBeginEpoch among ${JSON.stringify(sent)}`
    );
  });
});
