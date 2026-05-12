import fs from "fs";
import path from "path";
import { spawn } from "child_process";

type FailureClass =
  | "magicblock_tee"
  | "magicblock_auth"
  | "encrypt"
  | "ika"
  | "solana_rpc"
  | "umbra"
  | "approval_gate"
  | "internal_pipeline"
  | "unknown";

type ScenarioId = "private_blocked" | "public_blocked" | "full_happy_path";

type Scenario = {
  id: ScenarioId;
  label: string;
  args: string[];
  tags: string[];
};

type RunResult = {
  scenario: ScenarioId;
  label: string;
  tags: string[];
  iteration: number;
  attempt: number;
  success: boolean;
  durationMs: number;
  classification?: FailureClass;
  exitCode?: number | null;
  reportPath?: string;
};

const cwd = path.join(__dirname, "..");
const runs = Number(process.env.DIAGRAM_SOAK_RUNS || "5");
const maxTransientRetries = Number(process.env.DIAGRAM_SOAK_TRANSIENT_RETRIES || "3");
const retryBaseDelayMs = Number(process.env.DIAGRAM_SOAK_RETRY_BASE_MS || "3000");
const scenarioTimeoutMs = Number(process.env.DIAGRAM_SOAK_SCENARIO_TIMEOUT_MS || "420000");
const reportDir = path.join(cwd, "artifacts", "diagram-soak");
const SUCCESS_SENTINEL = "✅ Full diagram live E2E passed.";

const ALL_SCENARIOS: Record<ScenarioId, Scenario> = {
  private_blocked: {
    id: "private_blocked",
    label: "PER buyer-only approval gate",
    args: ["buyer_only", "private_only"],
    tags: ["phase7", "strict_per", "approval_gate", "private_only"],
  },
  public_blocked: {
    id: "public_blocked",
    label: "ER buyer-only approval gate",
    args: ["buyer_only", "public_only"],
    tags: ["phase7", "er", "approval_gate", "public_only"],
  },
  full_happy_path: {
    id: "full_happy_path",
    label: "Full ER+PER happy path",
    args: [],
    tags: ["phase7", "diagram", "happy_path", "public_and_private"],
  },
};

function selectedScenarios(): Scenario[] {
  const raw = (process.env.DIAGRAM_SOAK_SCENARIOS || "private_blocked,full_happy_path")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as ScenarioId[];

  return raw.map((id) => {
    const scenario = ALL_SCENARIOS[id];
    if (!scenario) {
      throw new Error(`Unsupported DIAGRAM_SOAK_SCENARIOS entry: ${id}`);
    }
    return scenario;
  });
}

function ensureReportDir(): void {
  fs.mkdirSync(reportDir, { recursive: true });
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function classifyFailure(output: string): FailureClass {
  const lower = output.toLowerCase();

  if (
    lower.includes("devnet-tee.magicblock.app") ||
    lower.includes("per_tee_integrity_error") ||
    lower.includes("per_verifying_tee_integrity") ||
    lower.includes("permission did not become active on tee") ||
    lower.includes("tee integrity verification failed")
  ) {
    return "magicblock_tee";
  }

  if (
    lower.includes("failed to authenticate") ||
    lower.includes("per auth token retry") ||
    lower.includes("scorechain client") ||
    lower.includes("no native root ca certificates") ||
    lower.includes("per_auth_failed")
  ) {
    return "magicblock_auth";
  }

  if (
    lower.includes("encrypt_grpc") ||
    lower.includes("ciphertext_verified") ||
    lower.includes("decryption_verified") ||
    lower.includes("14 unavailable") ||
    lower.includes("network_encryption_key")
  ) {
    return "encrypt";
  }

  if (
    lower.includes("ika_") ||
    lower.includes("dwallet") ||
    lower.includes("dkg_") ||
    lower.includes("presign_") ||
    lower.includes("signature_committed")
  ) {
    return "ika";
  }

  if (
    lower.includes("blockhash not found") ||
    lower.includes("transaction was not confirmed") ||
    lower.includes("transactionexpiredtimeouterror") ||
    lower.includes("rpc") ||
    lower.includes("429") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("node is behind")
  ) {
    return "solana_rpc";
  }

  if (lower.includes("umbra_") || lower.includes("settlement_umbra_")) {
    return "umbra";
  }

  if (
    lower.includes("awaiting_settlement_plan_approvals") ||
    lower.includes("buyer approval active") ||
    lower.includes("seller approval active")
  ) {
    return "approval_gate";
  }

  if (
    lower.includes("deal_pipeline") ||
    lower.includes("confidential_execution") ||
    lower.includes("release_approval") ||
    lower.includes("private_handoff_proof") ||
    lower.includes("pipeline")
  ) {
    return "internal_pipeline";
  }

  return "unknown";
}

function isTransientClassification(classification: FailureClass): boolean {
  return (
    classification === "magicblock_tee" ||
    classification === "magicblock_auth" ||
    classification === "encrypt" ||
    classification === "ika" ||
    classification === "solana_rpc" ||
    classification === "umbra"
  );
}

function terminateChildTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function runScenario(
  scenario: Scenario,
  iteration: number
): Promise<RunResult> {
  let attempt = 0;
  let lastResult: RunResult | null = null;

  while (attempt < maxTransientRetries) {
    attempt += 1;
    const startedAt = Date.now();
    let combinedOutput = "";
    let timedOut = false;

    const exit = await new Promise<{ code: number | null; successBySentinel: boolean }>((resolve, reject) => {
      const child = spawn("npx", ["ts-node", "test/full_diagram_live_e2e.ts", ...scenario.args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        detached: true,
      });
      let sawSuccessSentinel = false;
      let settled = false;
      let forcedKillHandle: NodeJS.Timeout | null = null;
      const clearForcedKill = () => {
        if (forcedKillHandle) {
          clearTimeout(forcedKillHandle);
          forcedKillHandle = null;
        }
      };
      const requestShutdown = () => {
        terminateChildTree(child.pid!, "SIGTERM");
        clearForcedKill();
        forcedKillHandle = setTimeout(() => {
          terminateChildTree(child.pid!, "SIGKILL");
        }, 5000);
      };
      const resolveSuccessBySentinel = () => {
        if (settled || !sawSuccessSentinel) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        requestShutdown();
        resolve({ code: 0, successBySentinel: true });
      };
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        combinedOutput += `\n[SOAK] scenario_timeout_after_ms=${scenarioTimeoutMs}\n`;
        if (sawSuccessSentinel) {
          resolveSuccessBySentinel();
          return;
        }
        requestShutdown();
      }, scenarioTimeoutMs);

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        combinedOutput += text;
        if (text.includes(SUCCESS_SENTINEL)) {
          sawSuccessSentinel = true;
          resolveSuccessBySentinel();
        }
        process.stdout.write(text);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        combinedOutput += text;
        if (text.includes(SUCCESS_SENTINEL)) {
          sawSuccessSentinel = true;
          resolveSuccessBySentinel();
        }
        process.stderr.write(text);
      });

      child.on("exit", (code) => {
        clearTimeout(timeoutHandle);
        clearForcedKill();
        if (settled) {
          return;
        }
        settled = true;
        resolve({ code, successBySentinel: sawSuccessSentinel });
      });
      child.on("error", reject);
    });

    const durationMs = Date.now() - startedAt;
    if (exit.code === 0 || exit.successBySentinel) {
      const reportPath = path.join(
        reportDir,
        `${timestampSlug()}-${scenario.id}-iter${iteration}-attempt${attempt}.log`
      );
      fs.writeFileSync(reportPath, combinedOutput, "utf8");
      return {
        scenario: scenario.id,
        label: scenario.label,
        tags: scenario.tags,
        iteration,
        attempt,
        success: true,
        durationMs,
        reportPath,
      };
    }

    const classification = timedOut ? classifyFailure(`${combinedOutput}\ntimeout`) : classifyFailure(combinedOutput);
    const reportPath = path.join(
      reportDir,
      `${timestampSlug()}-${scenario.id}-iter${iteration}-attempt${attempt}-failed.log`
    );
    fs.writeFileSync(reportPath, combinedOutput, "utf8");

    lastResult = {
      scenario: scenario.id,
      label: scenario.label,
      tags: scenario.tags,
      iteration,
      attempt,
      success: false,
      durationMs,
      classification,
      exitCode: exit.code,
      reportPath,
    };

    if (!isTransientClassification(classification) || attempt >= maxTransientRetries) {
      return lastResult;
    }

    const delayMs = retryBaseDelayMs * 2 ** (attempt - 1);
    console.warn(
      `[SOAK] ${scenario.label} hit ${classification}${timedOut ? " (timeout)" : ""} on iteration ${iteration}, attempt ${attempt}/${maxTransientRetries}. Retrying in ${delayMs}ms...`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return (
    lastResult ?? {
      scenario: scenario.id,
      label: scenario.label,
      tags: scenario.tags,
      iteration,
      attempt,
      success: false,
      durationMs: 0,
      classification: "unknown",
    }
  );
}

function printSummary(results: RunResult[]): void {
  const total = results.length;
  const passed = results.filter((result) => result.success).length;
  const failed = total - passed;

  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("  Diagram Soak Summary");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Total runs:  ${total}`);
  console.log(`  Passed:      ${passed}`);
  console.log(`  Failed:      ${failed}`);

  const byScenario = new Map<ScenarioId, RunResult[]>();
  for (const result of results) {
    const list = byScenario.get(result.scenario) ?? [];
    list.push(result);
    byScenario.set(result.scenario, list);
  }

  for (const scenario of Object.values(ALL_SCENARIOS)) {
    const scenarioResults = byScenario.get(scenario.id) ?? [];
    if (scenarioResults.length === 0) continue;

    const scenarioPasses = scenarioResults.filter((result) => result.success).length;
    const avgDurationMs =
      scenarioResults.reduce((sum, result) => sum + result.durationMs, 0) /
      scenarioResults.length;
    console.log(
      `  ${scenario.label}: ${scenarioPasses}/${scenarioResults.length} passed, avg ${(avgDurationMs / 1000).toFixed(1)}s`
    );
  }

  const failedResults = results.filter((result) => !result.success);
  if (failedResults.length > 0) {
    console.log("\n  Failures:");
    for (const result of failedResults) {
      console.log(
        `  - ${result.label} iteration ${result.iteration} attempt ${result.attempt}: ${result.classification} (log: ${result.reportPath})`
      );
    }
  }
}

async function main() {
  ensureReportDir();
  const scenarios = selectedScenarios();
  const results: RunResult[] = [];

  console.log(
    `Running full diagram soak test for ${runs} iteration(s) across ${scenarios.length} scenario(s)...`
  );

  for (let iteration = 1; iteration <= runs; iteration++) {
    console.log(`\n=== Diagram soak iteration ${iteration}/${runs} ===`);
    for (const scenario of scenarios) {
      console.log(`\n--- ${scenario.label} ---`);
      const result = await runScenario(scenario, iteration);
      results.push(result);
      if (!result.success) {
        printSummary(results);
        throw new Error(
          `${scenario.label} failed on iteration ${iteration} with ${result.classification}`
        );
      }
    }
  }

  const summaryPath = path.join(reportDir, `${timestampSlug()}-summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2), "utf8");
  printSummary(results);
  console.log(`\nDiagram soak reports written to ${reportDir}`);
  console.log(`Summary JSON: ${summaryPath}`);
}

main().catch((error) => {
  console.error("Diagram soak test failed:", error.message);
  process.exit(1);
});
