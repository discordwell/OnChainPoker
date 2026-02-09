import path from "node:path";
import process from "node:process";

import {
  ROOT_DIR,
  findLatestDeployment,
  isPortOpen,
  log,
  registerShutdown,
  runInherit,
  spawnInherit,
  waitForPortOpen
} from "./_util.mjs";

const rpcUrl = process.env.OCP_RPC_URL ?? "http://127.0.0.1:8545";
const url = new URL(rpcUrl);
const host = url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname;
const port = Number(url.port || "8545");

const deploymentsDir = path.join(ROOT_DIR, "deployments");

let nodeProc = null;
let startedNode = false;

async function stopNode() {
  if (!startedNode || !nodeProc) return;
  const proc = nodeProc;
  nodeProc = null;
  startedNode = false;
  log("[ws10] Stopping Hardhat node...");

  // Avoid hanging forever:
  // - attach listeners before signaling (race-free)
  // - if the process already exited, don't wait for an event that already fired
  // - enforce timeouts + SIGKILL fallback
  let settled = false;
  /** @type {(value: { code: number | null; signal: string | null; source: string }) => void} */
  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  function cleanup() {
    proc.removeListener("exit", onExit);
    proc.removeListener("close", onClose);
  }

  function settle(code, sig, source) {
    if (settled) return;
    settled = true;
    cleanup();
    resolveExit({ code: code ?? null, signal: sig ?? null, source });
  }

  function onExit(code, sig) {
    settle(code, sig, "exit");
  }
  function onClose(code, sig) {
    settle(code, sig, "close");
  }

  proc.once("exit", onExit);
  proc.once("close", onClose);

  // Handle the race where the process already exited before listeners were registered.
  if (proc.exitCode !== null) {
    settle(proc.exitCode, proc.signalCode ?? null, "already-exited");
  } else {
    try {
      proc.kill("SIGINT");
    } catch {
      // ignore
    }
  }

  async function waitOrTimeout(ms) {
    const res = await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), ms))
    ]);
    return res;
  }

  const first = await waitOrTimeout(5_000);
  if (first && typeof first === "object" && "timeout" in first) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    const second = await waitOrTimeout(2_000);
    if (second && typeof second === "object" && "timeout" in second) {
      cleanup();
      try {
        proc.unref();
      } catch {
        // ignore
      }
    }
  }

}

registerShutdown(async () => {
  await stopNode();
});

try {
  const alreadyRunning = await isPortOpen({ host, port });
  if (!alreadyRunning) {
    log(`[ws10] Starting Hardhat node at ${rpcUrl}...`);
    nodeProc = spawnInherit(
      "pnpm",
      ["-C", "packages/contracts", "node", "--port", String(port)],
      { cwd: ROOT_DIR, env: process.env }
    );
    startedNode = true;
    await waitForPortOpen({ host, port });
  } else {
    log(`[ws10] RPC already listening at ${rpcUrl} (reusing).`);
  }

  log("[ws10] Deploying contracts (local)...");
  await runInherit("pnpm", ["-C", "packages/contracts", "deploy:local"], {
    cwd: ROOT_DIR,
    env: { ...process.env, OCP_RPC_URL: rpcUrl }
  });

  const deploymentPath =
    (await findLatestDeployment({ deploymentsDir, chainId: "31337", preferredNetwork: "localhost" })) ??
    (await findLatestDeployment({ deploymentsDir, chainId: "31337" })) ??
    (await findLatestDeployment({ deploymentsDir }));

  if (!deploymentPath) {
    throw new Error("No deployment JSON found (expected `deployments/*.json`).");
  }

  log("[ws10] Running integration smoke...");
  await runInherit(
    "pnpm",
    ["-C", "packages/contracts", "exec", "hardhat", "run", "scripts/integration-smoke.ts", "--network", "localhost"],
    {
      cwd: ROOT_DIR,
      env: { ...process.env, OCP_RPC_URL: rpcUrl, DEPLOYMENT_PATH: deploymentPath }
    }
  );
} finally {
  await stopNode();
}
