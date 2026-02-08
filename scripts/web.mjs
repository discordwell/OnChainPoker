import path from "node:path";
import process from "node:process";

import {
  ROOT_DIR,
  fileExists,
  findLatestDeployment,
  log,
  readJson,
  registerShutdown,
  spawnInherit,
  writeWebEnvLocal
} from "./_util.mjs";

const rpcUrl = process.env.OCP_RPC_URL ?? "http://127.0.0.1:8545";
const deploymentsDir = path.join(ROOT_DIR, "deployments");
const webDir = path.join(ROOT_DIR, "apps/web");
const envLocalPath = path.join(webDir, ".env.local");

if (!(await fileExists(envLocalPath))) {
  const deploymentPath =
    (await findLatestDeployment({ deploymentsDir, chainId: "31337", preferredNetwork: "localhost" })) ??
    (await findLatestDeployment({ deploymentsDir, chainId: "31337" })) ??
    (await findLatestDeployment({ deploymentsDir }));

  if (!deploymentPath) {
    throw new Error(
      "apps/web/.env.local missing and no deployments found. Run `pnpm localnet` first."
    );
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
}

let webProc = null;
registerShutdown(async () => {
  if (!webProc) return;
  log("[ws10] Stopping web...");
  webProc.kill("SIGINT");
  await new Promise((r) => webProc.once("exit", r));
});

log("[ws10] Starting web...");
webProc = spawnInherit("pnpm", ["-C", "apps/web", "dev"], { cwd: ROOT_DIR, env: process.env });
await new Promise((r) => webProc.once("exit", r));

