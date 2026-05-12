import path from "path";
import { spawn } from "child_process";

type Step = {
  label: string;
  cwd: string;
  command: string;
  args: string[];
};

const root = path.join(__dirname, "..");
const runLive = process.argv.slice(2).some((arg) => arg.toLowerCase() === "live");

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
  console.log("  PER Strict Opaque E2E");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Mode: ${runLive ? "offline + live" : "offline"}`);
  console.log(
    "  Contract: no plaintext PER persistence/logging, redacted runtime, and private approval-gate proof."
  );

  const steps: Step[] = [
    {
      label: "Strict PER regression suite",
      cwd: root,
      command: "npx",
      args: [
        "vitest",
        "run",
        "tests/no_plaintext_per_logs.test.ts",
        "tests/no_plaintext_per_persistence.test.ts",
        "tests/private_execution_terms.test.ts",
        "tests/per_strict_legacy_paths.test.ts",
      ],
    },
  ];

  if (runLive) {
    steps.push(
      {
        label: "PER redaction live proof",
        cwd: root,
        command: "npx",
        args: ["ts-node", "test/per_redaction_e2e_test.ts"],
      },
      {
        label: "PER buyer-only live approval gate",
        cwd: root,
        command: "npx",
        args: ["ts-node", "test/full_diagram_live_e2e.ts", "buyer_only", "private_only"],
      }
    );
  }

  for (const step of steps) {
    await runStep(step);
  }

  console.log("\n✅ PER strict opaque E2E passed.");
}

main().catch((error) => {
  console.error(`\n❌ PER strict opaque E2E failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
