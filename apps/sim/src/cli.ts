import { getScenarioById, getScenarios } from "./scenarios.js";

function usage(): string {
  return [
    "Usage:",
    "  pnpm -C apps/sim sim --list",
    "  pnpm -C apps/sim sim <scenarioId>",
    "",
    "Scenarios:"
  ].join("\n");
}

function printScenarios(): void {
  console.log(usage());
  for (const s of getScenarios()) console.log(`  - ${s.id}: ${s.description}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printScenarios();
    process.exit(0);
  }

  if (args.includes("--list")) {
    printScenarios();
    process.exit(0);
  }

  const scenarioId = args[0]!;
  const scenario = getScenarioById(scenarioId);
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioId}\n`);
    printScenarios();
    process.exit(2);
  }

  const res = scenario.run();

  const lastHand = res.world.table.hand;
  const handSummary =
    lastHand?.phase === "HandAborted"
      ? `aborted: ${lastHand.abortedReason}`
      : lastHand?.phase === "HandComplete"
        ? "completed"
        : lastHand
          ? `ended in phase: ${lastHand.phase}`
          : "no hand";

  console.log(`Scenario: ${scenario.id}`);
  console.log(`Result: ${handSummary}`);
  console.log(`Treasury: ${res.world.treasury}`);
  for (const p of res.world.table.players.slice(0, 6)) {
    console.log(`${p.id}: stack=${p.stack} bond=${p.bond} status=${p.status} timeouts=${p.timeoutCount}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

