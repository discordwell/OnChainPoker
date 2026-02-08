import path from "node:path";
import process from "node:process";

import { ROOT_DIR, fileExists, log, runInherit } from "./_util.mjs";

const cmd = process.argv[2] ?? "dev";

const coordinatorDir = path.join(ROOT_DIR, "apps/coordinator");
const coordinatorPkg = path.join(coordinatorDir, "package.json");

if (!(await fileExists(coordinatorPkg))) {
  log(`[ws10] apps/coordinator not present; skipping (${cmd}).`);
  process.exit(0);
}

await runInherit("pnpm", ["-C", "apps/coordinator", cmd], { cwd: ROOT_DIR, env: process.env });

