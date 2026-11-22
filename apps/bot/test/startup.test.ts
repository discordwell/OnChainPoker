import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { PokerBot } from "../src/bot.js";
import type { BotConfig } from "../src/config.js";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const ME = "ocp1me";

const config: BotConfig = {
  strategy: "calling-station",
  tableId: "1",
  buyIn: null,
  password: "",
  cosmosRpcUrl: "http://127.0.0.1:26657",
  cosmosLcdUrl: "http://127.0.0.1:1317",
  bech32Prefix: "ocp",
  gasPrice: "0uchips",
  pollIntervalMs: 1_000,
  autoStartHand: false,
  autoSit: true,
  autoRebuy: false,
  rebuyDelayMs: 5_000,
  name: "test-bot",
};

// A bot whose table reads answer in turn: "missing" (the SDK's null), "fail" (a thrown read), then a table it sits at.
function botWithTableReads(answers: Array<"missing" | "fail">) {
  const readTimes: number[] = [];
  const client = {
    getTable: async () => {
      readTimes.push(Date.now());
      const answer = answers.shift();
      if (answer === "fail") throw new Error("LCD HTTP 500: query failed");
      if (answer === "missing") return null;
      return { seats: [{ player: ME, stack: "1000000" }] };
    },
  };
  const bot = new PokerBot({
    client: client as any,
    config,
    strategy: { name: "stub", decide: () => ({ action: "check" }) },
    sk: 1n,
    pkBytes: new Uint8Array(32),
    address: ME,
  });
  const outcome = bot.start().then(
    () => "started",
    (err: Error) => `threw: ${err.message}`
  );
  return { bot, readTimes, outcome };
}

describe("rule 3: the bot waits for its table; it does not die for it", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries reading its table until the chain has it, instead of throwing", async () => {
    const { bot, readTimes, outcome } = botWithTableReads(["missing", "fail"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await outcome).toBe("started");
    expect(readTimes).toEqual([0, 1_000, 3_000]);
    await bot.stop();
  });

  it("backs off from 1 s, doubling, and stops growing at 30 s", async () => {
    const { bot, readTimes, outcome } = botWithTableReads(Array(8).fill("missing"));
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await outcome).toBe("started");
    expect(readTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000, 121_000]);
    await bot.stop();
  });
});

async function closedPortUrl(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  await new Promise((r) => srv.close(r));
  return `http://127.0.0.1:${port}`;
}

async function throwawayEnv(): Promise<Record<string, string>> {
  const url = await closedPortUrl();
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    BOT_TABLE_ID: "1",
    BOT_PRIVKEY_HEX: "02".repeat(32),
    BOT_COSMOS_RPC_URL: url,
    BOT_COSMOS_LCD_URL: url,
  };
}

// Starts the bot's real entry point and resolves on the first of: `until` matches its
// output, or it exits. The process is killed either way.
function runBot(env: Record<string, string>, until: RegExp): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: appDir, env });
    let output = "";
    const onData = (d: Buffer) => {
      output += d;
      if (until.test(output)) {
        resolve({ exitCode: child.exitCode, output });
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => resolve({ exitCode: code, output }));
  });
}

describe("rule 3: the bot process waits for the chain and exits only for what waiting cannot cure", () => {
  it("keeps retrying the connection while the chain RPC refuses it", async () => {
    const { exitCode, output } = await runBot(await throwawayEnv(), /retrying in/);
    expect(exitCode, `bot exited while the chain was unreachable:\n${output}`).toBeNull();
  }, 120_000);

  it("exits at once for bad configuration", async () => {
    const env = await throwawayEnv();
    delete (env as Record<string, string | undefined>).BOT_TABLE_ID;
    const { exitCode, output } = await runBot(env, /retrying in/);
    expect(exitCode, output).toBe(1);
    expect(output).toMatch(/BOT_TABLE_ID is required/);
  }, 120_000);

  it("exits at once for bad credentials", async () => {
    const env = { ...(await throwawayEnv()), BOT_PRIVKEY_HEX: "not-a-key" };
    const { exitCode, output } = await runBot(env, /retrying in/);
    expect(exitCode, output).toBe(1);
    expect(output).toMatch(/private key must be 32-byte hex/);
  }, 120_000);
});
