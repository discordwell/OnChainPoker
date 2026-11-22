import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));

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
    DEALER_VALIDATOR_ADDRESS: "ocpvaloper1throwaway",
    DEALER_VALIDATOR_PRIVKEY_HEX: "01".repeat(32),
    DEALER_COSMOS_RPC_URL: url,
    DEALER_COSMOS_LCD_URL: url,
    DEALER_STATE_DIR: mkdtempSync(join(tmpdir(), "ocp-dealer-startup-")),
    DEALER_STATE_ALLOW_UNENCRYPTED: "1",
  };
}

// Starts the daemon's real entry point and resolves on the first of: `until` matches its
// output, or it exits. The process is killed either way.
function runDaemon(env: Record<string, string>, until: RegExp): Promise<{ exitCode: number | null; output: string }> {
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

describe("rule 3: the dealer daemon waits for the chain; it does not die for it", () => {
  it("keeps retrying the connection while the chain RPC refuses it", { timeout: 120_000 }, async () => {
    const { exitCode, output } = await runDaemon(await throwawayEnv(), /retrying in/);
    assert.equal(exitCode, null, `daemon exited (code ${exitCode}) while the chain was unreachable:\n${output}`);
  });

  it("exits at once for bad configuration", { timeout: 120_000 }, async () => {
    const env = await throwawayEnv();
    delete (env as Record<string, string | undefined>).DEALER_VALIDATOR_ADDRESS;
    const { exitCode, output } = await runDaemon(env, /retrying in/);
    assert.equal(exitCode, 1, output);
    assert.match(output, /DEALER_VALIDATOR_ADDRESS is required/);
  });

  it("exits at once for bad credentials", { timeout: 120_000 }, async () => {
    const env = { ...(await throwawayEnv()), DEALER_VALIDATOR_PRIVKEY_HEX: "not-a-key" };
    const { exitCode, output } = await runDaemon(env, /retrying in/);
    assert.equal(exitCode, 1, output);
    assert.match(output, /private key must be 32-byte hex/);
  });
});
