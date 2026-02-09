import path from "node:path";
import process from "node:process";

import {
  ROOT_DIR,
  fileExists,
  findLatestDeployment,
  isPortOpen,
  log,
  readJson,
  registerShutdown,
  runInherit,
  spawnInherit,
  waitForPortOpen,
  writeWebEnvLocal
} from "./_util.mjs";

const rpcUrl = process.env.OCP_RPC_URL ?? "http://127.0.0.1:8545";
const url = new URL(rpcUrl);
const host = url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname;
const port = Number(url.port || "8545");

const deploymentsDir = path.join(ROOT_DIR, "deployments");
const webDir = path.join(ROOT_DIR, "apps/web");
const coordinatorPkg = path.join(ROOT_DIR, "apps/coordinator/package.json");

let nodeProc = null;
let startedNode = false;
let webProc = null;
let coordinatorProc = null;

async function shutdown() {
  const kills = [];

  if (webProc) {
    log("[ws10] Stopping web...");
    webProc.kill("SIGINT");
    kills.push(new Promise((r) => webProc.once("exit", r)));
  }

  if (coordinatorProc) {
    log("[ws10] Stopping coordinator...");
    coordinatorProc.kill("SIGINT");
    kills.push(new Promise((r) => coordinatorProc.once("exit", r)));
  }

  if (startedNode && nodeProc) {
    log("[ws10] Stopping Hardhat node...");
    nodeProc.kill("SIGINT");
    kills.push(new Promise((r) => nodeProc.once("exit", r)));
  }

  await Promise.allSettled(kills);
}

registerShutdown(async () => {
  await shutdown();
});

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

const deployment = await readJson(deploymentPath);
if (!deployment?.token || !deployment?.vault) {
  throw new Error(`Invalid deployment JSON: ${deploymentPath}`);
}

await writeWebEnvLocal({
  webDir,
  chainId: deployment.chainId ?? "31337",
  rpcUrl,
  tokenAddress: deployment.token,
  vaultAddress: deployment.vault
});

log("[ws10] Starting web...");
webProc = spawnInherit("pnpm", ["-C", "apps/web", "dev"], { cwd: ROOT_DIR, env: process.env });

if (await fileExists(coordinatorPkg)) {
  log("[ws10] Starting coordinator...");
  coordinatorProc = spawnInherit("pnpm", ["-C", "apps/coordinator", "dev"], {
    cwd: ROOT_DIR,
    env: process.env
  });
} else {
  log("[ws10] apps/coordinator not present; skipping coordinator.");
}

const waits = [];
waits.push(new Promise((r) => webProc.once("exit", (code, signal) => r({ name: "web", code, signal }))));
if (coordinatorProc) {
  waits.push(
    new Promise((r) => coordinatorProc.once("exit", (code, signal) => r({ name: "coordinator", code, signal })))
  );
}
if (nodeProc) {
  waits.push(new Promise((r) => nodeProc.once("exit", (code, signal) => r({ name: "localnet", code, signal }))));
}

const first = await Promise.race(waits);
log(`[ws10] ${first.name} exited (${first.code ?? "null"}). Shutting down...`);
await shutdown();
process.exitCode = first.code ?? 0;
