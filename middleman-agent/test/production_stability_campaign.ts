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
  | "proof_pack"
  | "unknown";

type SuiteId = "phase7_proof" | "per_strict_live" | "diagram_live";

type Suite = {
  id: SuiteId;
  label: string;
  command: string;
  args: string[];
  successSentinel?: string;
  timeoutMs: number;
};

type CampaignResult = {
  suite: SuiteId;
  label: string;
  iteration: number;
  success: boolean;
  durationMs: number;
  exitCode?: number | null;
  classification?: FailureClass;
  reportPath: string;
};

const cwd = path.join(__dirname, "..");
const reportDir = path.join(cwd, "artifacts", "stability-campaign");
const runs = Number(process.env.STABILITY_CAMPAIGN_RUNS || "3");
const warmupEnabled = (process.env.STABILITY_CAMPAIGN_WARMUP || "true").toLowerCase() !== "false";

const SUITES: Record<SuiteId, Suite> = {
  phase7_proof: {
    id: "phase7_proof",
    label: "Phase 7 proof pack",
    command: "npm",
    args: ["run", "test:phase7:proof"],
    timeoutMs: 600_000,
  },
  per_strict_live: {
    id: "per_strict_live",
    label: "PER strict live gate",
    command: "npm",
    args: ["run", "test:per:strict:live"],
    successSentinel: "✅ PER strict opaque E2E passed.",
    timeoutMs: 900_000,
  },
  diagram_live: {
    id: "diagram_live",
    label: "Harness-backed full diagram live gate",
    command: "npx",
    args: ["ts-node", "test/full_diagram_live_e2e.ts"],
    successSentinel: "✅ Full diagram live E2E passed.",
    timeoutMs: 900_000,
  },
};

function ensureReportDir(): void {
  fs.mkdirSync(reportDir, { recursive: true });
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function classifyFailure(output: string): FailureClass {
  const lower = output.toLowerCase();

  if (
    lower.includes("phase 7 proof pack failed") ||
    lower.includes("marketplace + observatory per proof pack failed") ||
    lower.includes("strict per regression suite")
  ) {
    return "proof_pack";
  }
  if (
    lower.includes("devnet-tee.magicblock.app") ||
    lower.includes("per_tee_integrity_error") ||
    lower.includes("permission did not become active on tee") ||
    lower.includes("tee integrity verification failed")
  ) {
    return "magicblock_tee";
  }
  if (
    lower.includes("failed to authenticate") ||
    lower.includes("scorechain client") ||
    lower.includes("no native root ca certificates") ||
    lower.includes("per_auth_failed")
  ) {
    return "magicblock_auth";
  }
  if (
    lower.includes("encrypt_grpc") ||
    lower.includes("decryption_verified") ||
    lower.includes("network_encryption_key") ||
    lower.includes("14 unavailable")
  ) {
    return "encrypt";
  }
  if (
    lower.includes("dwallet") ||
    lower.includes("ika_") ||
    lower.includes("presign_") ||
    lower.includes("approve_message")
  ) {
    return "ika";
  }
  if (
    lower.includes("rpc") ||
    lower.includes("fetch failed") ||
    lower.includes("transaction was not confirmed") ||
    lower.includes("blockhash not found") ||
    lower.includes("node is behind") ||
    lower.includes("429") ||
    lower.includes("503") ||
    lower.includes("504")
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

function terminateChildTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already exited
    }
  }
}

async function runSuite(suite: Suite, iteration: number): Promise<CampaignResult> {
  const startedAt = Date.now();
  let combinedOutput = "";

  const exit = await new Promise<{ code: number | null; successBySentinel: boolean }>((resolve, reject) => {
    const child = spawn(suite.command, suite.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: true,
    });

    let settled = false;
    let sawSuccessSentinel = false;
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
      if (settled || !sawSuccessSentinel) return;
      settled = true;
      clearTimeout(timeoutHandle);
      requestShutdown();
      resolve({ code: 0, successBySentinel: true });
    };

    const timeoutHandle = setTimeout(() => {
      combinedOutput += `\n[CAMPAIGN] suite_timeout_after_ms=${suite.timeoutMs}\n`;
      requestShutdown();
    }, suite.timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      combinedOutput += text;
      if (suite.successSentinel && text.includes(suite.successSentinel)) {
        sawSuccessSentinel = true;
        resolveSuccessBySentinel();
      }
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      combinedOutput += text;
      if (suite.successSentinel && text.includes(suite.successSentinel)) {
        sawSuccessSentinel = true;
        resolveSuccessBySentinel();
      }
      process.stderr.write(text);
    });

    child.on("exit", (code) => {
      clearTimeout(timeoutHandle);
      clearForcedKill();
      if (settled) return;
      settled = true;
      resolve({ code, successBySentinel: sawSuccessSentinel });
    });
    child.on("error", reject);
  });

  const durationMs = Date.now() - startedAt;
  const success = exit.code === 0 || exit.successBySentinel;
  const reportPath = path.join(
    reportDir,
    `${timestampSlug()}-${suite.id}-iter${iteration}${success ? "" : "-failed"}.log`
  );
  fs.writeFileSync(reportPath, combinedOutput, "utf8");

  return {
    suite: suite.id,
    label: suite.label,
    iteration,
    success,
    durationMs,
    exitCode: exit.code,
    classification: success ? undefined : classifyFailure(combinedOutput),
    reportPath,
  };
}

function printSummary(results: CampaignResult[]): void {
  const passed = results.filter((result) => result.success).length;
  const failed = results.length - passed;

  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("  Production Stability Campaign Summary");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Total suite runs: ${results.length}`);
  console.log(`  Passed:          ${passed}`);
  console.log(`  Failed:          ${failed}`);

  for (const suite of Object.values(SUITES)) {
    const suiteResults = results.filter((result) => result.suite === suite.id);
    if (suiteResults.length === 0) continue;
    const suitePasses = suiteResults.filter((result) => result.success).length;
    const avgSeconds =
      suiteResults.reduce((sum, result) => sum + result.durationMs, 0) / suiteResults.length / 1000;
    console.log(`  ${suite.label}: ${suitePasses}/${suiteResults.length} passed, avg ${avgSeconds.toFixed(1)}s`);
  }

  const failureCounts = new Map<FailureClass, number>();
  for (const result of results) {
    if (!result.success && result.classification) {
      failureCounts.set(result.classification, (failureCounts.get(result.classification) || 0) + 1);
    }
  }

  if (failureCounts.size > 0) {
    console.log("\n  Failure classes:");
    for (const [classification, count] of failureCounts.entries()) {
      console.log(`  - ${classification}: ${count}`);
    }
  }
}

async function main() {
  ensureReportDir();
  const suites = [SUITES.per_strict_live, SUITES.diagram_live];
  const results: CampaignResult[] = [];

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  Production Stability Campaign");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Iterations: ${runs}`);
  console.log(`  Warmup proof pack: ${warmupEnabled ? "enabled" : "disabled"}`);

  if (warmupEnabled) {
    console.log(`\n--- Warmup: ${SUITES.phase7_proof.label} ---`);
    const warmup = await runSuite(SUITES.phase7_proof, 0);
    results.push(warmup);
    if (!warmup.success) {
      printSummary(results);
      throw new Error(`${SUITES.phase7_proof.label} failed with ${warmup.classification}`);
    }
  }

  for (let iteration = 1; iteration <= runs; iteration++) {
    console.log(`\n=== Stability campaign iteration ${iteration}/${runs} ===`);
    for (const suite of suites) {
      console.log(`\n--- ${suite.label} ---`);
      const result = await runSuite(suite, iteration);
      results.push(result);
      if (!result.success) {
        printSummary(results);
        throw new Error(`${suite.label} failed on iteration ${iteration} with ${result.classification}`);
      }
    }
  }

  const summaryPath = path.join(reportDir, `${timestampSlug()}-summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2), "utf8");
  printSummary(results);
  console.log(`\nStability campaign reports written to ${reportDir}`);
  console.log(`Summary JSON: ${summaryPath}`);
}

main().catch((error) => {
  console.error("Production stability campaign failed:", error.message);
  process.exit(1);
});
