import { spawn } from "child_process";
import * as path from "path";

const cwd = path.join(__dirname, "..");
const runs = Number(process.env.ROLLUP_SOAK_RUNS || "2");
const maxTransientRetries = Number(process.env.ROLLUP_SOAK_TRANSIENT_RETRIES || "3");
const retryBaseDelayMs = Number(process.env.ROLLUP_SOAK_RETRY_BASE_MS || "1500");

const TRANSIENT_PATTERNS = [
  "fetch failed",
  "get recent blockhash",
  "failed to get balance",
  "429",
  "timed out",
  "timeout",
  "socket hang up",
  "econnreset",
  "ecanceled",
  "service unavailable",
  "temporarily unavailable",
  "failed to fetch",
];

async function runCommand(label: string, args: string[]): Promise<void> {
  let attempt = 0;

  while (attempt < maxTransientRetries) {
    attempt += 1;
    const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let output = "";
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        output += text;
        process.stdout.write(text);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        output += text;
        process.stderr.write(text);
      });

      child.on("exit", (code) => resolve({ code, output }));
      child.on("error", reject);
    });

    if (code === 0) {
      return;
    }

    const normalizedOutput = output.toLowerCase();
    const isTransient = TRANSIENT_PATTERNS.some((pattern) => normalizedOutput.includes(pattern));
    if (!isTransient || attempt >= maxTransientRetries) {
      throw new Error(`${label} failed with exit code ${code ?? "unknown"}`);
    }

    const delayMs = retryBaseDelayMs * 2 ** (attempt - 1);
    console.warn(
      `[SOAK] ${label} hit transient RPC/network noise on attempt ${attempt}/${maxTransientRetries}. Retrying in ${delayMs}ms...`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function main() {
  console.log(`Running rollup soak test for ${runs} iteration(s)...`);

  for (let i = 1; i <= runs; i++) {
    console.log(`\n=== Iteration ${i}/${runs}: ER E2E ===`);
    await runCommand("ER E2E", ["npx", "ts-node", "test/magicblock_e2e_test.ts"]);

    console.log(`\n=== Iteration ${i}/${runs}: PER E2E ===`);
    await runCommand("PER E2E", ["npx", "ts-node", "test/per_redaction_e2e_test.ts"]);
  }

  console.log(`\nRollup soak test complete: ${runs} ER run(s), ${runs} PER run(s).`);
}

main().catch((error) => {
  console.error("Rollup soak test failed:", error.message);
  process.exit(1);
});
