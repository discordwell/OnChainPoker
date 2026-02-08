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

registerShutdown(async () => {
  if (!startedNode || !nodeProc) return;
  log("[ws10] Stopping Hardhat node...");
  nodeProc.kill("SIGINT");
  await new Promise((r) => nodeProc.once("exit", r));
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
  if (startedNode && nodeProc) {
    log("[ws10] Stopping Hardhat node...");
    nodeProc.kill("SIGINT");
    await new Promise((r) => nodeProc.once("exit", r));
  }
}
