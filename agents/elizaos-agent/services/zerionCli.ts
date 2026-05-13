import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AgentRole } from "./dealTracker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ZERION_BIN = path.join(
    __dirname,
    "../../../middleman-agent/zerion-core/cli/zerion.js"
);

interface ZerionResult {
    stdout: string;
    stderr: string;
    json: any;
}

function parseNumberishEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function requiresZerion(): boolean {
    return process.env.AIROTC_REQUIRE_ZERION === "true";
}

function allowOfflineZerion(): boolean {
    return process.env.AIROTC_ZERION_ALLOW_OFFLINE === "true";
}

function parseJson(stdout: string): any {
    try {
        return JSON.parse(stdout);
    } catch {
        return null;
    }
}

function runZerion(args: string[], timeoutMs = 45_000): Promise<ZerionResult> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            "node",
            [ZERION_BIN, ...args, "--json"],
            {
                env: process.env,
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024,
            },
            (error, stdout, stderr) => {
                const json = parseJson(stdout);
                if (error) {
                    const parsedError = parseJson(stderr);
                    const message =
                        parsedError?.error?.message ||
                        parsedError?.error?.code ||
                        stderr.trim() ||
                        error.message;
                    reject(new Error(`Zerion CLI failed: ${message}`));
                    return;
                }
                resolve({ stdout, stderr, json });
            }
        );
        child.stdin?.end();
    });
}

function basePolicyArgs(role: AgentRole, wallet: string): string[] {
    const maxSpendUsd = String(parseNumberishEnv("AIROTC_ZERION_MAX_SPEND_USD", 1));
    return [
        "airotc",
        "policy-check",
        "--wallet",
        wallet,
        "--role",
        role,
        "--chain",
        process.env.AIROTC_ZERION_CHAIN || "solana",
        "--max-spend-usd",
        maxSpendUsd,
        "--actions",
        process.env.AIROTC_ZERION_ACTIONS || "verify,swap",
    ];
}

function offlineArgs(): string[] {
    return allowOfflineZerion() ? ["--allow-offline"] : [];
}

function shouldVerifyTradeWallets(): boolean {
    return process.env.AIROTC_ZERION_VERIFY_TRADE_WALLETS === "true";
}

function getZerionProofWallet(fallbackWallet: string): string {
    return (
        process.env.AIROTC_ZERION_PROOF_WALLET ||
        process.env.AIROTC_ZERION_ONLINE_WALLET ||
        process.env.AIROTC_ZERION_ANALYSIS_WALLET ||
        fallbackWallet
    );
}

function getZerionOnlineCheckMode(): string {
    return process.env.AIROTC_ZERION_ONLINE_CHECK_MODE || "light";
}

class ZerionCliService {
    async verifyPreTrade(role: AgentRole, wallet: string): Promise<void> {
        if (!requiresZerion()) {
            return;
        }

        const policy = await runZerion(basePolicyArgs(role, wallet));
        const policyHash = policy.json?.airotc?.policyHash;
        if (policyHash) {
            process.env.AIROTC_LAST_ZERION_POLICY_HASH = policyHash;
        }

        if (!shouldVerifyTradeWallets()) {
            const proofWallet = getZerionProofWallet(wallet);
            const onlineCheck = await runZerion([
                "airotc",
                "online-check",
                "--wallet",
                proofWallet,
                "--chain",
                process.env.AIROTC_ZERION_CHAIN || "solana",
                "--mode",
                getZerionOnlineCheckMode(),
                ...offlineArgs(),
            ]);
            if (onlineCheck.json?.airotc?.online !== true && !allowOfflineZerion()) {
                throw new Error("Zerion online-check did not return online=true");
            }
            const snapshotHash = onlineCheck.json?.airotc?.snapshotHash;
            if (snapshotHash) {
                process.env.AIROTC_LAST_ZERION_ONLINE_SNAPSHOT_HASH = snapshotHash;
            }
            return;
        }

        if (role === "seller") {
            const args = [
                "airotc",
                "verify-seller",
                "--wallet",
                wallet,
                "--asset",
                process.env.AIROTC_ZERION_ASSET || process.env.AIROTC_TRADE_ASSET || "SOL",
                "--min-amount",
                String(parseNumberishEnv("AIROTC_TRADE_AMOUNT", 1)),
                "--chain",
                process.env.AIROTC_ZERION_CHAIN || "solana",
                ...offlineArgs(),
            ];
            const verification = await runZerion(args);
            if (verification.json?.airotc?.verified !== true && !allowOfflineZerion()) {
                throw new Error("Zerion seller verification did not return verified=true");
            }
            return;
        }

        const minValueUsd = parseNumberishEnv("AIROTC_ZERION_BUYER_MIN_VALUE_USD", 1);
        const args = [
            "airotc",
            "verify-buyer",
            "--wallet",
            wallet,
            "--min-value-usd",
            String(minValueUsd),
            "--chain",
            process.env.AIROTC_ZERION_CHAIN || "solana",
            ...offlineArgs(),
        ];
        const verification = await runZerion(args);
        if (verification.json?.airotc?.verified !== true && !allowOfflineZerion()) {
            throw new Error("Zerion buyer verification did not return verified=true");
        }

    }

    async attestRealTxOnce(): Promise<void> {
        if (!requiresZerion()) {
            return;
        }
        if (process.env.AIROTC_ZERION_TX_ATTESTED === "true") {
            return;
        }

        const externalTx = process.env.AIROTC_ZERION_EXTERNAL_TX;
        if (externalTx) {
            await runZerion(["airotc", "execute-demo-tx", "--external-tx", externalTx]);
            process.env.AIROTC_ZERION_TX_ATTESTED = "true";
            return;
        }

        if (process.env.AIROTC_ZERION_EXECUTE_REAL_TX === "true") {
            const fromToken = process.env.AIROTC_ZERION_FROM_TOKEN || "SOL";
            const toToken = process.env.AIROTC_ZERION_TO_TOKEN || "USDC";
            const amount = process.env.AIROTC_ZERION_TX_AMOUNT || "0.0001";
            const chain = process.env.AIROTC_ZERION_CHAIN || "solana";
            await runZerion([
                "airotc",
                "execute-demo-tx",
                "--execute",
                fromToken,
                toToken,
                amount,
                "--chain",
                chain,
            ], parseNumberishEnv("AIROTC_ZERION_TX_TIMEOUT_MS", 180_000));
            process.env.AIROTC_ZERION_TX_ATTESTED = "true";
            return;
        }

        throw new Error(
            "AIROTC_REQUIRE_ZERION=true requires AIROTC_ZERION_EXTERNAL_TX or AIROTC_ZERION_EXECUTE_REAL_TX=true"
        );
    }
}

export const zerionCli = new ZerionCliService();
