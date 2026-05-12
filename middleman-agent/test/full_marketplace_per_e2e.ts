import path from "path";
import { spawn } from "child_process";

type Step = {
  label: string;
  cwd: string;
  command: string;
  args: string[];
};

const workspaceRoot = path.join(__dirname, "..", "..");
const middlemanRoot = path.join(workspaceRoot, "middleman-agent");
const apiRoot = path.join(workspaceRoot, "api-server");
const frontendRoot = path.join(workspaceRoot, "frontend");

function runStep(step: Step): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n── ${step.label} ──`);
    console.log(`cwd: ${step.cwd}`);
    console.log(`cmd: ${step.command} ${step.args.join(" ")}`);

    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${step.label} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Marketplace + Observatory PER Proof Pack");
  console.log("═══════════════════════════════════════════════════════");
  console.log(
    "  Contract proof: marketplace discovery, observatory reconciliation, and strict-PER settlement surfaces stay aligned. This is not the literal live settlement runtime proof."
  );

  const steps: Step[] = [
    {
      label: "API package typecheck gate",
      cwd: apiRoot,
      command: "npm",
      args: ["run", "typecheck"],
    },
    {
      label: "Frontend marketplace compile gate",
      cwd: frontendRoot,
      command: "npx",
      args: ["tsc", "--noEmit"],
    },
    {
      label: "API marketplace + observatory proof",
      cwd: apiRoot,
      command: "npx",
      args: [
        "vitest",
        "run",
        "tests/encrypt_status_proxy.test.ts",
        "tests/stats_consistency.test.ts",
        "tests/transaction_monitor_status_policy.test.ts",
        "tests/per_marketplace_bridge.test.ts",
        "tests/per_ticket_redaction.test.ts",
        "tests/per_marketplace_offer_flow.test.ts",
      ],
    },
    {
      label: "Middleman marketplace + observatory proof",
      cwd: middlemanRoot,
      command: "npx",
      args: [
        "vitest",
        "run",
        "tests/observatory_bridge_auth.test.ts",
        "tests/meridian_client_marketplace_flow.test.ts",
        "tests/marketplace_per_contract_e2e.test.ts",
      ],
    },
  ];

  for (const step of steps) {
    await runStep(step);
  }

  console.log("\n✅ Marketplace + observatory PER proof pack passed.");
}

main().catch((error) => {
  console.error(
    `\n❌ Marketplace + observatory PER proof pack failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
