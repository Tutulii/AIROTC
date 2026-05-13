import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import bs58 from "bs58";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

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

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name} for Umbra prewarm`);
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
    throw new Error("Unsupported private key format for Umbra prewarm");
}

async function assertBalance(input: {
    connection: Connection;
    wallet: PublicKey;
    label: string;
    minSol: number;
}): Promise<void> {
    const sol = (await input.connection.getBalance(input.wallet, "confirmed")) / LAMPORTS_PER_SOL;
    console.log(`[PREWARM] ${input.label} balance: ${sol.toFixed(4)} SOL`);
    if (sol < input.minSol) {
        throw new Error(
            `${input.label} has ${sol.toFixed(4)} SOL; prewarm needs at least ${input.minSol.toFixed(3)} SOL`
        );
    }
}

async function withTimeout<T>(label: string, timeoutMs: number, task: () => Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            task(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
                    timeoutMs
                );
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

async function prewarmBaseWallet(input: {
    keypair: Keypair;
    role: "seller" | "buyer";
    rpcUrl: string;
}): Promise<void> {
    const umbraModulePath = new URL(
        "../../../middleman-agent/src/services/umbraService.ts",
        import.meta.url
    ).href;
    const { UmbraService } = await import(umbraModulePath);
    const network = input.rpcUrl.includes("mainnet") ? "mainnet" : "devnet";
    const timeoutMs = Number(process.env.AIROTC_PREWARM_UMBRA_TIMEOUT_MS || "180000");
    const umbra = new UmbraService(input.keypair.secretKey, input.rpcUrl, network);
    const wallet = input.keypair.publicKey.toBase58();

    console.log(`[PREWARM] ${input.role} base Umbra wallet registration check: ${wallet}`);
    await withTimeout(`${input.role} base Umbra registration`, timeoutMs, async () => {
        await umbra.initClient();
        await umbra.ensureRegistered();
    });
    console.log(`[PREWARM] ${input.role} base Umbra wallet ready: ${wallet}`);
}

async function prewarmOne(input: {
    keypair: Keypair;
    role: "seller" | "buyer";
    referenceKind: "offer_creator" | "offer_accepter";
    apiUrl: string;
    wsUrl: string;
    rpcUrl: string;
}): Promise<string> {
    const meridianModulePath = new URL(
        "../../../middleman-agent/agents/sdk/MeridianClient.ts",
        import.meta.url
    ).href;
    const { MeridianClient } = await import(meridianModulePath);
    const client = new MeridianClient({
        apiUrl: input.apiUrl,
        wsUrl: input.wsUrl,
        rpcUrl: input.rpcUrl,
        keypair: input.keypair,
        privateMode: true,
        strictOpaquePerMode: true,
    });
    const previous = process.env.AIROTC_PREWARM_UMBRA_SETTLEMENT_WALLET;
    process.env.AIROTC_PREWARM_UMBRA_SETTLEMENT_WALLET = "true";
    try {
        const address = await (client as any).createFreshSettlementWallet(input.referenceKind);
        console.log(`[PREWARM] ${input.role} prewarmed Umbra settlement wallet: ${address}`);
        return address;
    } finally {
        if (previous === undefined) {
            delete process.env.AIROTC_PREWARM_UMBRA_SETTLEMENT_WALLET;
        } else {
            process.env.AIROTC_PREWARM_UMBRA_SETTLEMENT_WALLET = previous;
        }
    }
}

async function main(): Promise<void> {
    const sellerKeypair = Keypair.fromSecretKey(parseSecretKey(requiredEnv("SELLER_PRIVATE_KEY")));
    const buyerKeypair = Keypair.fromSecretKey(parseSecretKey(requiredEnv("BUYER_PRIVATE_KEY")));
    const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.devnet.solana.com";
    const apiUrl = process.env.AIROTC_PROOF_API_URL || "http://localhost:3000";
    const wsUrl = process.env.AIROTC_PROOF_WS_URL || "ws://localhost:8080";
    const connection = new Connection(rpcUrl, "confirmed");
    const minSol = Number(process.env.AIROTC_PREWARM_MIN_WALLET_SOL || "0.05");

    await assertBalance({
        connection,
        wallet: sellerKeypair.publicKey,
        label: "seller",
        minSol,
    });
    await assertBalance({
        connection,
        wallet: buyerKeypair.publicKey,
        label: "buyer",
        minSol,
    });

    console.log("[PREWARM] registering fresh Umbra wallets before the video run");
    await prewarmBaseWallet({
        keypair: sellerKeypair,
        role: "seller",
        rpcUrl,
    });
    await prewarmBaseWallet({
        keypair: buyerKeypair,
        role: "buyer",
        rpcUrl,
    });
    await prewarmOne({
        keypair: sellerKeypair,
        role: "seller",
        referenceKind: "offer_creator",
        apiUrl,
        wsUrl,
        rpcUrl,
    });
    await prewarmOne({
        keypair: buyerKeypair,
        role: "buyer",
        referenceKind: "offer_accepter",
        apiUrl,
        wsUrl,
        rpcUrl,
    });
    console.log("[PREWARM] ready. Run npm run proof:demo next.");
    process.exit(0);
}

void main().catch((error) => {
    console.error(`[PREWARM] fatal: ${error?.message || String(error)}`);
    if (error?.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
