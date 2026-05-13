import dotenv from "dotenv";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

for (const candidate of [
    path.join(__dirname, "../.env.local"),
    path.join(__dirname, "../.env"),
    path.join(__dirname, "../../../middleman-agent/.env.local"),
    path.join(__dirname, "../../../middleman-agent/.env"),
    path.join(__dirname, "../../../api-server/.env.local"),
    path.join(__dirname, "../../../api-server/.env"),
    path.join(__dirname, "../../../.env.local"),
    path.join(__dirname, "../../../.env"),
]) {
    dotenv.config({ path: candidate, override: false });
}

function parseRunCount(): number {
    const raw = process.env.AIROTC_FULL_PIPELINE_SOAK_RUNS || "3";
    const count = Number(raw);
    if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error("AIROTC_FULL_PIPELINE_SOAK_RUNS must be a positive integer");
    }
    return count;
}

function runOnce(iteration: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            AIROTC_FULL_PIPELINE_SOAK_ITERATION: String(iteration),
        };
        const child = execFile(
            "npx",
            ["tsx", "proof/fullPipelineProof.ts"],
            {
                cwd: path.join(__dirname, ".."),
                env,
                timeout: Number(process.env.AIROTC_FULL_PIPELINE_SOAK_TIMEOUT_MS || 900_000),
                maxBuffer: 20 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                if (stdout.trim()) {
                    process.stdout.write(stdout);
                }
                if (stderr.trim()) {
                    process.stderr.write(stderr);
                }
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            }
        );
        child.stdin?.end();
    });
}

async function main(): Promise<void> {
    const runs = parseRunCount();
    for (let iteration = 1; iteration <= runs; iteration += 1) {
        console.log(`[ELIZA-FULL-PIPELINE-SOAK] run ${iteration}/${runs} starting`);
        await runOnce(iteration);
        console.log(`[ELIZA-FULL-PIPELINE-SOAK] run ${iteration}/${runs} passed`);
    }
    console.log(`[ELIZA-FULL-PIPELINE-SOAK] ✅ ${runs}/${runs} full-pipeline runs passed`);
}

void main().catch((error) => {
    console.error(`[ELIZA-FULL-PIPELINE-SOAK] fatal: ${error?.message || String(error)}`);
    if (error?.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
