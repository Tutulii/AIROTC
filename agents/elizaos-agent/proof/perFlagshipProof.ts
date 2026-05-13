import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { spawn } from "child_process";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

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

type ChildSpec = {
    label: "seller" | "buyer";
    env: NodeJS.ProcessEnv;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name} for Eliza PER proof`);
    }
    return value;
}

function parseSecretKey(raw: string): Uint8Array {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
        return Uint8Array.from(JSON.parse(trimmed) as number[]);
    }
    try {
        const decoded = bs58.decode(trimmed);
        if (decoded.length >= 32) {
            return decoded;
        }
    } catch {
        // ignore and try base64 below
    }
    const base64 = Buffer.from(trimmed, "base64");
    if (base64.length >= 32) {
        return new Uint8Array(base64);
    }
    throw new Error("Unsupported private key format for PER proof");
}

async function runChild(spec: ChildSpec): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("npm", ["run", spec.label], {
            cwd: path.join(__dirname, ".."),
            env: spec.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout.on("data", (chunk) => {
            process.stdout.write(`[ELIZA-${spec.label.toUpperCase()}] ${chunk}`);
        });
        child.stderr.on("data", (chunk) => {
            process.stderr.write(`[ELIZA-${spec.label.toUpperCase()}] ${chunk}`);
        });

        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${spec.label} process exited with code ${code}`));
        });
        child.on("error", reject);
    });
}

async function main(): Promise<void> {
    const sellerPrivateKey = requiredEnv("SELLER_PRIVATE_KEY");
    const buyerPrivateKey = requiredEnv("BUYER_PRIVATE_KEY");
    const sellerWallet = Keypair.fromSecretKey(parseSecretKey(sellerPrivateKey)).publicKey.toBase58();
    const buyerWallet = Keypair.fromSecretKey(parseSecretKey(buyerPrivateKey)).publicKey.toBase58();

    const baseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "development",
        AIROTC_AGENT_LLM_PROVIDER:
            process.env.AIROTC_AGENT_LLM_PROVIDER || "groq",
        AIROTC_API_URL: process.env.AIROTC_PROOF_API_URL || "http://localhost:3000",
        AIROTC_WS_URL: process.env.AIROTC_PROOF_WS_URL || "ws://localhost:8080",
        AIROTC_TRADE_ASSET: process.env.AIROTC_TRADE_ASSET || "SOL",
        AIROTC_TRADE_AMOUNT: process.env.AIROTC_TRADE_AMOUNT || "1",
        AIROTC_TRADE_PRICE_SOL: process.env.AIROTC_TRADE_PRICE_SOL || "0.1",
        AIROTC_TRADE_COLLATERAL_SOL: process.env.AIROTC_TRADE_COLLATERAL_SOL || "0.02",
        ENCRYPTED_DELIVERY_PAYLOAD:
            process.env.ENCRYPTED_DELIVERY_PAYLOAD || "ACCESS_TOKEN=ACCESS_TOKEN_12345",
        AGENT_LOOP_DELAY_MS: process.env.AGENT_LOOP_DELAY_MS || "2500",
        AGENT_MAX_LOOPS: process.env.AGENT_MAX_LOOPS || "240",
    };

    const sellerEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        SELLER_PRIVATE_KEY: sellerPrivateKey,
        AIROTC_EXPECTED_BUYER_WALLET: buyerWallet,
    };
    const buyerEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        BUYER_PRIVATE_KEY: buyerPrivateKey,
        AIROTC_EXPECTED_SELLER_WALLET: sellerWallet,
    };

    console.log("[ELIZA-PROOF] starting seller");
    const sellerPromise = runChild({ label: "seller", env: sellerEnv });
    await sleep(5_000);
    console.log("[ELIZA-PROOF] starting buyer");
    const buyerPromise = runChild({ label: "buyer", env: buyerEnv });

    await Promise.all([sellerPromise, buyerPromise]);
    console.log("[ELIZA-PROOF] ✅ buyer and seller external Eliza agents completed the PER flagship flow");
}

void main().catch((error) => {
    console.error(`[ELIZA-PROOF] fatal: ${error?.message || String(error)}`);
    if (error?.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
