import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { execFile, spawn } from "child_process";
import bs58 from "bs58";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ZERION_BIN = path.join(
    __dirname,
    "../../../middleman-agent/zerion-core/cli/zerion.js"
);

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
    reporter?: DemoReporter;
    onOfferPosted?: () => void;
};

type ChildResult = {
    label: "seller" | "buyer";
    output: string;
};

type TorqueDeliveryEvidence = {
    id: string;
    ticketId: string;
    eventName: string;
    participantRole: string;
    userPubkey: string;
    payload: any;
    payloadHash: string;
    schemaVersion: number;
    status: string;
    attemptCount: number;
    lastError: string | null;
    deliveredAt: Date | string | null;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithTimeout(
    url: string,
    timeoutMs: number,
    acceptedHttpStatuses: number[] = [200]
): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!acceptedHttpStatuses.includes(response.status)) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function deriveMiddlemanHealthUrl(wsUrl: string): string {
    const explicit = process.env.AIROTC_MIDDLEMAN_HEALTH_URL;
    if (explicit) {
        return explicit;
    }
    const parsed = new URL(wsUrl);
    const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    const wsPort = parsed.port ? Number(parsed.port) : 8080;
    const healthPort = Number.isFinite(wsPort) ? wsPort + 1 : 8081;
    return `${protocol}//${parsed.hostname}:${healthPort}/health`;
}

async function waitForHttpHealth(input: {
    label: string;
    url: string;
    reporter: DemoReporter;
    timeoutMs?: number;
    minUptimeSeconds?: number;
    acceptedHttpStatuses?: number[];
    acceptDependencyProbeFailures?: boolean;
}): Promise<void> {
    const deadline = Date.now() + (input.timeoutMs || 90_000);
    let lastError = "";

    while (Date.now() < deadline) {
        try {
            const data = await fetchJsonWithTimeout(
                input.url,
                2_500,
                input.acceptedHttpStatuses
            );
            const dependencyProbeOnlyFailure =
                input.acceptDependencyProbeFailures &&
                data?.status === "down" &&
                data?.checks?.database?.status === "ok" &&
                data?.checks?.circuit_breaker === "CLOSED" &&
                data?.system_paused !== true;
            const statusOk = data?.status === "ok" || dependencyProbeOnlyFailure;
            const uptimeOk =
                !input.minUptimeSeconds ||
                Number(data?.uptime_seconds || 0) >= input.minUptimeSeconds;
            if (statusOk && uptimeOk) {
                input.reporter.milestone(
                    `health:${input.label}:ready`,
                    `${input.label} service ready`
                );
                return;
            }
            lastError = `status=${data?.status || "unknown"} uptime=${data?.uptime_seconds ?? "n/a"}`;
        } catch (error: any) {
            lastError = error?.message || String(error);
        }
        await sleep(2_000);
    }

    throw new Error(`${input.label} service not ready at ${input.url}: ${lastError}`);
}

async function waitForDemoServices(env: NodeJS.ProcessEnv, reporter: DemoReporter): Promise<void> {
    reporter.milestone("health:start", "Checking API and middleman readiness");
    await waitForHttpHealth({
        label: "API",
        url: `${env.AIROTC_API_URL || "http://localhost:3000"}/health`,
        reporter,
    });
    await waitForHttpHealth({
        label: "Middleman",
        url: deriveMiddlemanHealthUrl(env.AIROTC_WS_URL || "ws://localhost:8080"),
        reporter,
        minUptimeSeconds: Number(env.AIROTC_DEMO_MIN_MIDDLEMAN_UPTIME_SECONDS || "8"),
        acceptedHttpStatuses: [200, 503],
        acceptDependencyProbeFailures: true,
    });
}

function elapsedLabel(startedAt: number): string {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const BASE58_RE = "[1-9A-HJ-NP-Za-km-z]{32,128}";

function extractJsonStringField(line: string, field: string): string | null {
    const match = line.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
    return match?.[1] || null;
}

function extractJsonValueField(line: string, field: string): string | null {
    return extractJsonStringField(line, field) || line.match(new RegExp(`"${field}"\\s*:\\s*([^,}\\s]+)`))?.[1] || null;
}

function extractTokenField(line: string, field: string): string | null {
    const match = line.match(new RegExp(`${field}=([^\\s]+)`));
    return match?.[1] || null;
}

function extractSignature(line: string): string | null {
    const labeled =
        line.match(new RegExp(`(?:Signature:|tx=|tx:|signature=|callbackSignature"\\s*:\\s*"|queueSignature"\\s*:\\s*")\\s*(${BASE58_RE})`))?.[1] ||
        null;
    if (labeled) {
        return labeled.replace(/"$/, "");
    }
    return line.match(new RegExp(`\\b(${BASE58_RE})\\b`))?.[1] || null;
}

function collectValuesByKey(input: unknown, key: string, values: string[] = []): string[] {
    if (input === null || input === undefined) {
        return values;
    }
    if (typeof input === "string") {
        const trimmed = input.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                collectValuesByKey(JSON.parse(trimmed), key, values);
            } catch {
                // keep scanning the raw string below
            }
        }
        const rawMatch = input.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
        if (rawMatch?.[1]) {
            values.push(rawMatch[1]);
        }
        return values;
    }
    if (Array.isArray(input)) {
        for (const item of input) {
            collectValuesByKey(item, key, values);
        }
        return values;
    }
    if (typeof input === "object") {
        for (const [entryKey, entryValue] of Object.entries(input as Record<string, unknown>)) {
            if (entryKey === key && typeof entryValue === "string") {
                values.push(entryValue);
            }
            collectValuesByKey(entryValue, key, values);
        }
    }
    return values;
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
}

function collectAuditHashes(input: unknown, eventName: string, hashes: string[] = []): string[] {
    if (!input || typeof input !== "object") {
        return hashes;
    }
    if (Array.isArray(input)) {
        for (const item of input) {
            collectAuditHashes(item, eventName, hashes);
        }
        return hashes;
    }
    const record = input as Record<string, unknown>;
    if (record.event === eventName && typeof record.hash === "string") {
        hashes.push(record.hash);
    }
    for (const value of Object.values(record)) {
        collectAuditHashes(value, eventName, hashes);
    }
    return hashes;
}

function extractTicketId(results: ChildResult[]): string | null {
    const combined = results.map((result) => result.output).join("\n");
    return combined.match(/Accepted offer\. Ticket:\s*([0-9a-f-]+)/i)?.[1] || null;
}

class DemoReporter {
    private readonly startedAt = Date.now();
    private readonly emitted = new Set<string>();

    milestone(key: string, message: string, always = false): void {
        if (!always && this.emitted.has(key)) {
            return;
        }
        this.emitted.add(key);
        console.log(`[DEMO ${elapsedLabel(this.startedAt)}] ${message}`);
    }

    evidence(key: string, message: string, always = false): void {
        const evidenceKey = `evidence:${key}`;
        if (!always && this.emitted.has(evidenceKey)) {
            return;
        }
        this.emitted.add(evidenceKey);
        console.log(`[DEMO ${elapsedLabel(this.startedAt)}]   EVIDENCE: ${message}`);
    }

    childLine(label: "seller" | "buyer", rawLine: string): void {
        const line = rawLine.trim();
        if (!line) {
            return;
        }
        const agent = label === "seller" ? "Eliza seller" : "Eliza buyer";
        const lowerAgent = label;

        if (line.includes("booting") && line.includes("agent")) {
            this.milestone(`${label}:boot`, `${agent} booted and connected to AIR OTC`);
            return;
        }
        if (line.includes("wallet=")) {
            const wallet = line.match(/wallet=([1-9A-HJ-NP-Za-km-z]+)/)?.[1] || "configured wallet";
            this.milestone(`${label}:wallet`, `${agent} wallet ready: ${wallet}`);
            return;
        }
        if (line.includes("umbra_registration_attempt")) {
            this.milestone(
                `${label}:umbra-registration-started`,
                `${agent} is preparing a fresh Umbra settlement wallet`
            );
            return;
        }
        if (line.includes("umbra_retry")) {
            this.milestone(
                `${label}:umbra-registration-retry:${line}`,
                `${agent} Umbra registration retry triggered by devnet latency`,
                true
            );
            return;
        }
        if (line.includes("umbra_registered")) {
            this.milestone(
                `${label}:umbra-registered`,
                `${agent} Umbra receiver registration completed`
            );
            return;
        }
        if (line.includes("Prewarmed Umbra settlement wallet ready")) {
            const wallet = line.match(/ready:\s*([1-9A-HJ-NP-Za-km-z]+)/)?.[1] || "prewarmed wallet";
            this.milestone(
                `${label}:prewarmed-settlement-wallet`,
                `${agent} reused prewarmed Umbra settlement wallet: ${wallet}`
            );
            return;
        }
        if (line.includes("Fresh Umbra settlement wallet ready")) {
            const wallet = line.match(/ready:\s*([1-9A-HJ-NP-Za-km-z]+)/)?.[1] || "fresh wallet";
            this.milestone(
                `${label}:fresh-settlement-wallet`,
                `${agent} fresh settlement wallet ready: ${wallet}`
            );
            return;
        }
        if (line.includes("Fresh private reward wallet ready")) {
            this.milestone(`${label}:reward-wallet`, `${agent} fresh reward wallet generated`);
            return;
        }
        if (line.includes("Fresh confidential funding wallet ready")) {
            this.milestone(`${label}:funding-wallet`, `${agent} shielded-credit funding wallet generated`);
            return;
        }
        if (line.includes("Offer posted:")) {
            const offerId = line.match(/Offer posted:\s*([0-9a-f-]+)/i)?.[1] || "created";
            this.milestone("offer-posted", `Offer created by Eliza seller: ${offerId}`, true);
            return;
        }
        if (line.includes("Accepted offer. Ticket:")) {
            const ticketId = line.match(/Ticket:\s*([0-9a-f-]+)/i)?.[1] || "created";
            this.milestone("offer-accepted", `Offer accepted by Eliza buyer. Ticket: ${ticketId}`, true);
            return;
        }
        if (line.includes("Rollup Session Ready")) {
            const sessionPda = extractTokenField(line, "sessionPda");
            if (sessionPda) {
                this.evidence(`${label}:magicblock-session:${sessionPda}`, `MagicBlock PER session PDA (${agent}): ${sessionPda}`);
            }
            this.milestone(`${label}:per-ready`, `${agent} joined the MagicBlock PER session`);
            return;
        }
        if (line.includes("Terms submitted to rollup")) {
            const signature = extractSignature(line);
            if (signature) {
                this.evidence(`${label}:magicblock-terms:${signature}`, `MagicBlock encrypted-terms tx (${agent}): ${signature}`);
            }
            this.milestone(`${label}:terms-submitted`, `${agent} submitted encrypted private terms`);
            return;
        }
        if (line.includes("network_encryption_key_found")) {
            const networkKey =
                extractJsonStringField(line, "networkEncryptionKey") ||
                extractJsonStringField(line, "nek_pubkey") ||
                extractJsonStringField(line, "pubkey");
            if (networkKey) {
                this.evidence(`encrypt-key:${networkKey}`, `Encrypt network encryption key/PDA: ${networkKey}`);
            }
            this.milestone("encrypt-key", "Encrypt network key found for FHE handoff");
            return;
        }
        if (line.includes("encrypt_grpc_input_created")) {
            const identifiers = extractJsonValueField(line, "identifiers_count") || extractJsonValueField(line, "identifierCount");
            const authorized = extractJsonValueField(line, "authorized") || extractJsonValueField(line, "authority");
            this.evidence(
                `encrypt-grpc-input:${label}:${line}`,
                `Encrypt gRPC ciphertext input created${identifiers ? ` identifiers=${identifiers}` : ""}${authorized ? ` authorized=${authorized}` : ""}`
            );
            this.milestone("encrypt-input", "Encrypt created FHE ciphertext inputs for the deal");
            return;
        }
        if (line.includes("PER consensus signaled")) {
            this.evidence(`${label}:per-handoff`, `PER private handoff bundle accepted (${agent})`);
            this.milestone(`${label}:private-agreement`, `${agent} finalized the private agreement`);
            return;
        }
        if (line.includes("Confidential funding signer")) {
            const wallet = line.match(new RegExp(`:\\s*(${BASE58_RE})`))?.[1] || extractSignature(line);
            if (wallet) {
                this.evidence(`${label}:funding-signer:${wallet}`, `SHIELDED_CREDIT funding signer (${agent}): ${wallet}`);
            }
            this.milestone(`${label}:funding-signer`, `${agent} prepared shielded-credit funding authorization`);
            return;
        }
        if (line.includes("SHIELDED_CREDIT vault deposit tx")) {
            const role = extractTokenField(line, "role") || label;
            const tx = extractTokenField(line, "tx") || extractSignature(line);
            if (tx) {
                this.evidence(`${label}:shielded-credit-deposit:${tx}`, `SHIELDED_CREDIT vault deposit tx (${role}): ${tx}`);
            }
            return;
        }
        if (line.includes("SHIELDED_CREDIT lock tx")) {
            const role = extractTokenField(line, "role") || label;
            const fundingRole = extractTokenField(line, "fundingRole") || "funding_role";
            const tx = extractTokenField(line, "tx") || extractSignature(line);
            if (tx) {
                this.evidence(
                    `${label}:shielded-credit-lock:${fundingRole}:${tx}`,
                    `SHIELDED_CREDIT lock tx (${role}, ${fundingRole}): ${tx}`
                );
            }
            return;
        }
        if (line.includes("DIRECT_SOL confidential funding tx")) {
            const role = extractTokenField(line, "role") || label;
            const fundingRole = extractTokenField(line, "fundingRole") || "funding_role";
            const tx = extractTokenField(line, "tx") || extractSignature(line);
            if (tx) {
                this.evidence(
                    `${label}:direct-sol-funding:${fundingRole}:${tx}`,
                    `DIRECT_SOL funding tx (${role}, ${fundingRole}): ${tx}`
                );
            }
            return;
        }
        if (line.includes("confidential funding submitted")) {
            this.milestone(`${label}:funding-submitted`, `${agent} submitted confidential SHIELDED_CREDIT funding`);
            return;
        }
        if (line.includes("Fresh Umbra final wallet ready")) {
            this.milestone(`${label}:umbra-final-wallet`, `${agent} generated fresh Umbra final payout wallet`);
            return;
        }
        if (line.includes("Umbra lifecycle setup starting")) {
            this.milestone(`${label}:umbra-setup`, `${agent} is preparing Umbra base and receiver clients`);
            return;
        }
        if (line.includes("Umbra lifecycle base wallet ready")) {
            const wallet = extractTokenField(line, "wallet") || "base wallet";
            this.evidence(`${label}:umbra-base-ready:${wallet}`, `Umbra base wallet ready (${agent}): ${wallet}`);
            return;
        }
        if (line.includes("Umbra lifecycle receiver wallet ready")) {
            const wallet = extractTokenField(line, "wallet") || "receiver wallet";
            this.evidence(`${label}:umbra-receiver-ready:${wallet}`, `Umbra receiver wallet ready (${agent}): ${wallet}`);
            return;
        }
        if (line.includes("Umbra lifecycle phase submitted")) {
            const phase = extractTokenField(line, "phase") || "PHASE";
            const role = extractTokenField(line, "role") || label;
            const tx = extractTokenField(line, "tx") || extractSignature(line);
            if (tx) {
                this.evidence(`umbra-tx:${tx}`, `Umbra ${phase} tx (${role}): ${tx}`);
            }
            if (phase === "SHIELD") {
                this.milestone(`${label}:umbra-shield`, `${agent} shielded payout through Umbra`);
            } else if (phase === "CREATE_UTXO") {
                this.milestone(`${label}:umbra-utxo`, `${agent} created receiver-claimable Umbra UTXO`);
            } else if (phase === "CLAIM") {
                this.milestone(`${label}:umbra-claim`, `${agent} claimed Umbra UTXO`);
            } else if (phase === "UNSHIELD") {
                this.milestone(`${label}:umbra-unshield`, `${agent} unshielded to fresh final wallet`);
            }
            return;
        }
        if (line.includes("umbra_deposit_shielded")) {
            const tx = extractJsonStringField(line, "callbackSignature") || extractJsonStringField(line, "queueSignature");
            if (tx) {
                this.evidence(`umbra-tx:${tx}`, `Umbra SHIELD tx (${agent}): ${tx}`);
            }
            this.milestone(`${label}:umbra-shield`, `${agent} shielded payout through Umbra`);
            return;
        }
        if (line.includes("umbra_encrypted_balance_self_utxo_created")) {
            const tx = extractJsonStringField(line, "callbackSignature") || extractJsonStringField(line, "queueSignature");
            if (tx) {
                this.evidence(`umbra-tx:${tx}`, `Umbra CREATE_UTXO tx (${agent}): ${tx}`);
            }
            this.milestone(`${label}:umbra-utxo`, `${agent} created receiver-claimable Umbra UTXO`);
            return;
        }
        if (line.includes("umbra_self_utxo_claim_progress") && line.includes('"status":"completed"')) {
            const tx = extractJsonStringField(line, "txSignature") || extractJsonStringField(line, "callbackSignature");
            if (tx) {
                this.evidence(`umbra-tx:${tx}`, `Umbra CLAIM tx (${agent}): ${tx}`);
            }
            this.milestone(`${label}:umbra-claim`, `${agent} claimed Umbra UTXO`);
            return;
        }
        if (line.includes("umbra_withdraw_unshielded")) {
            const tx = extractJsonStringField(line, "callbackSignature") || extractJsonStringField(line, "queueSignature");
            if (tx) {
                this.evidence(`umbra-tx:${tx}`, `Umbra UNSHIELD tx (${agent}): ${tx}`);
            }
            this.milestone(`${label}:umbra-unshield`, `${agent} unshielded to fresh final wallet`);
            return;
        }
        if (line.includes("full Umbra lifecycle completed")) {
            this.milestone(`${label}:umbra-complete`, `${agent} completed full Umbra shield/claim/unshield lifecycle`);
            return;
        }
        if (line.includes("encrypted delivery sent")) {
            this.milestone("delivery-sent", "Eliza seller sent encrypted delivery");
            return;
        }
        if (line.includes("encrypted delivery received")) {
            this.milestone("delivery-received", "Eliza buyer received encrypted delivery");
            return;
        }
        if (line.includes("private delivery release confirmed")) {
            this.evidence("buyer-release-signature", "Buyer signed the private release approval payload and sent it to middleman");
            this.milestone("release-confirmed", "Eliza buyer signed private release confirmation");
            return;
        }
        if (line.includes("confidential_shielded_credit_settled")) {
            const hash = extractJsonStringField(line, "hash") || extractJsonStringField(line, "eventHash");
            if (hash) {
                this.evidence(`shielded-credit-settled:${hash}`, `SHIELDED_CREDIT settlement audit hash: ${hash}`);
            }
            this.milestone("shielded-credit-settled", "Escrow settled SHIELDED_CREDIT funding");
            return;
        }
        if (line.includes("torque_event_delivery_queued")) {
            this.milestone("torque-queued", "Torque reward sidecar queued post-settlement reward events");
            return;
        }
        if (line.includes("torque_event_delivery_sent")) {
            const role = line.includes('"participantRole":"seller"') ? "seller" : line.includes('"participantRole":"buyer"') ? "buyer" : "participant";
            this.milestone(`torque-sent:${role}`, `Torque reward event sent for ${role}`);
            return;
        }
        if (line.includes("completed ticket")) {
            this.milestone(`${label}:completed`, `${agent} completed the trade`, true);
            return;
        }
        if (line.includes("action=") && line.includes("failed")) {
            this.milestone(`${label}:action-failed:${line}`, `${agent} action warning: ${line}`, true);
            return;
        }
        if (line.includes("fatal:")) {
            this.milestone(`${label}:fatal:${line}`, `${agent} fatal error: ${line}`, true);
            return;
        }
        if (process.env.AIROTC_DEMO_LOG_STYLE === "verbose") {
            console.log(`[${lowerAgent.toUpperCase()}] ${line}`);
        }
    }
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name} for full-pipeline proof`);
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
    throw new Error("Unsupported private key format for full-pipeline proof");
}

function requireRealZerionGate(env: NodeJS.ProcessEnv): boolean {
    return env.AIROTC_REQUIRE_ZERION !== "false";
}

function allowOfflineZerion(env: NodeJS.ProcessEnv): boolean {
    return env.AIROTC_ZERION_ALLOW_OFFLINE === "true";
}

function requireZerionRealTx(env: NodeJS.ProcessEnv): boolean {
    return env.AIROTC_ZERION_REQUIRE_REAL_TX === "true";
}

function zerionProofWallet(env: NodeJS.ProcessEnv, fallbackWallet: string): string {
    return (
        env.AIROTC_ZERION_PROOF_WALLET ||
        env.AIROTC_ZERION_ONLINE_WALLET ||
        env.AIROTC_ZERION_ANALYSIS_WALLET ||
        fallbackWallet
    );
}

function zerionOnlineCheckMode(env: NodeJS.ProcessEnv): string {
    return env.AIROTC_ZERION_ONLINE_CHECK_MODE || "light";
}

function runZerion(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        const cleanLogs = env.AIROTC_DEMO_LOG_STYLE !== "raw";
        execFile(
            "node",
            [ZERION_BIN, ...args, "--json"],
            {
                env,
                timeout: Number(env.AIROTC_ZERION_TX_TIMEOUT_MS || 180_000),
                maxBuffer: 1024 * 1024,
            },
            (error, stdout, stderr) => {
                if (stdout.trim() && (!cleanLogs || env.AIROTC_DEMO_LOG_STYLE === "verbose")) {
                    process.stdout.write(`[ZERION-AIR OTC] ${stdout}`);
                }
                if (stderr.trim() && (!cleanLogs || env.AIROTC_DEMO_LOG_STYLE === "verbose")) {
                    process.stderr.write(`[ZERION-AIR OTC] ${stderr}`);
                }
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout);
            }
        );
    });
}

async function runZerionOnlineGate(
    env: NodeJS.ProcessEnv,
    sellerWallet: string,
    buyerWallet: string
): Promise<string[]> {
    const outputs: string[] = [];
    outputs.push(await runZerion(
        [
            "airotc",
            "policy-check",
            "--wallet",
            sellerWallet,
            "--role",
            "seller",
            "--chain",
            env.AIROTC_ZERION_CHAIN || "solana",
            "--max-spend-usd",
            env.AIROTC_ZERION_MAX_SPEND_USD || "1",
        ],
        env
    ));
    outputs.push(await runZerion(
        [
            "airotc",
            "policy-check",
            "--wallet",
            buyerWallet,
            "--role",
            "buyer",
            "--chain",
            env.AIROTC_ZERION_CHAIN || "solana",
            "--max-spend-usd",
            env.AIROTC_ZERION_MAX_SPEND_USD || "1",
        ],
        env
    ));
    outputs.push(await runZerion(
        [
            "airotc",
            "online-check",
            "--wallet",
            zerionProofWallet(env, sellerWallet),
            "--chain",
            env.AIROTC_ZERION_CHAIN || "solana",
            "--mode",
            zerionOnlineCheckMode(env),
        ],
        env
    ));
    return outputs;
}

async function runZerionDemoTxGate(
    env: NodeJS.ProcessEnv,
    sellerWallet: string,
    buyerWallet: string,
    reporter?: DemoReporter
): Promise<void> {
    if (!requireRealZerionGate(env)) {
        return;
    }
    if (allowOfflineZerion(env)) {
        reporter?.milestone("zerion-offline", "Zerion offline mode enabled for local tests only");
        if (!reporter) {
            console.log("[ELIZA-FULL-PIPELINE] Zerion offline mode is enabled for local tests only");
        }
        return;
    }

    reporter?.milestone("zerion-start", "Running Zerion CLI policy and online checks");
    const gateOutputs = await runZerionOnlineGate(env, sellerWallet, buyerWallet);
    reporter?.evidence(
        "zerion-cli-gate",
        `Zerion CLI policy + online gate passed for seller=${sellerWallet} buyer=${buyerWallet}`
    );
    for (const tx of unique(collectValuesByKey(gateOutputs, "txHash").concat(collectValuesByKey(gateOutputs, "signature")))) {
        reporter?.evidence(`zerion-tx:${tx}`, `Zerion CLI/API tx evidence: ${tx}`);
    }

    const externalTx = env.AIROTC_ZERION_EXTERNAL_TX;
    if (externalTx) {
        await runZerion(["airotc", "execute-demo-tx", "--external-tx", externalTx], env);
        reporter?.evidence("zerion-external-tx", `Zerion external demo tx verified: ${externalTx}`);
        return;
    }

    if (env.AIROTC_ZERION_EXECUTE_REAL_TX === "true") {
        const txOutput = await runZerion(
            [
                "airotc",
                "execute-demo-tx",
                "--execute",
                env.AIROTC_ZERION_FROM_TOKEN || "SOL",
                env.AIROTC_ZERION_TO_TOKEN || "USDC",
                env.AIROTC_ZERION_TX_AMOUNT || "0.0001",
                "--chain",
                env.AIROTC_ZERION_CHAIN || "solana",
            ],
            env
        );
        for (const tx of unique(collectValuesByKey(txOutput, "txHash").concat(collectValuesByKey(txOutput, "signature")))) {
            reporter?.evidence(`zerion-real-tx:${tx}`, `Zerion real demo tx: ${tx}`);
        }
        return;
    }

    if (!requireZerionRealTx(env)) {
        reporter?.milestone("zerion-passed", "Zerion CLI/API gate passed");
        if (!reporter) {
            console.log(
                "[ELIZA-FULL-PIPELINE] Zerion online CLI/API gate passed; no real Zerion tx was requested"
            );
        }
        return;
    }

    throw new Error(
        "Full-pipeline proof requires AIROTC_ZERION_EXTERNAL_TX or AIROTC_ZERION_EXECUTE_REAL_TX=true"
    );
}

async function runChildAttempt(spec: ChildSpec): Promise<ChildResult> {
    let output = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const cleanLogs = (process.env.AIROTC_DEMO_LOG_STYLE || "raw") !== "raw";
    const handleText = (text: string, stream: NodeJS.WriteStream, isStdErr = false) => {
        output += text;
        if (!cleanLogs) {
            stream.write(`[ELIZA-${spec.label.toUpperCase()}] ${text}`);
            return;
        }

        const buffer = isStdErr ? stderrBuffer + text : stdoutBuffer + text;
        const lines = buffer.split(/\r?\n/);
        const remainder = lines.pop() || "";
        if (isStdErr) {
            stderrBuffer = remainder;
        } else {
            stdoutBuffer = remainder;
        }

        for (const line of lines) {
            if (line.includes("Offer posted:")) {
                spec.onOfferPosted?.();
            }
            spec.reporter?.childLine(spec.label, line);
        }
    };

    try {
        await new Promise<void>((resolve, reject) => {
        const child = spawn("npm", ["run", spec.label], {
            cwd: path.join(__dirname, ".."),
            env: spec.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            handleText(text, process.stdout);
        });
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            handleText(text, process.stderr, true);
        });

        child.on("exit", (code) => {
            if (cleanLogs) {
                for (const line of [stdoutBuffer, stderrBuffer]) {
                    if (line.trim()) {
                        spec.reporter?.childLine(spec.label, line);
                    }
                }
            }
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${spec.label} process exited with code ${code}`));
        });
        child.on("error", reject);
        });
    } catch (error: any) {
        error.childOutput = output;
        throw error;
    }
    return { label: spec.label, output };
}

async function runChild(spec: ChildSpec): Promise<ChildResult> {
    const maxAuthRetries = Number(spec.env.AIROTC_DEMO_WS_AUTH_RETRIES || "2");
    let combinedOutput = "";

    for (let attempt = 0; attempt <= maxAuthRetries; attempt += 1) {
        try {
            const result = await runChildAttempt(spec);
            return { ...result, output: combinedOutput + result.output };
        } catch (error: any) {
            const childOutput = error?.childOutput || "";
            combinedOutput += childOutput;
            const retryableAuthClose =
                childOutput.includes("WebSocket closed before authentication") &&
                !childOutput.includes("Offer posted:");
            if (retryableAuthClose && attempt < maxAuthRetries) {
                const agent = spec.label === "seller" ? "Eliza seller" : "Eliza buyer";
                spec.reporter?.milestone(
                    `${spec.label}:ws-auth-retry:${attempt}`,
                    `${agent} WebSocket auth closed during startup; retrying`
                );
                await waitForDemoServices(spec.env, spec.reporter || new DemoReporter());
                await sleep(3_000);
                continue;
            }
            throw error;
        }
    }

    throw new Error(`${spec.label} process failed after WebSocket auth retries`);
}

async function checkWalletBalance(input: {
    connection: Connection;
    wallet: string;
    label: "seller" | "buyer";
    minSol: number;
    reporter: DemoReporter;
}): Promise<void> {
    const lamports = await input.connection.getBalance(new PublicKey(input.wallet), "confirmed");
    const sol = lamports / LAMPORTS_PER_SOL;
    input.reporter.milestone(
        `${input.label}:balance`,
        `${input.label === "seller" ? "Seller" : "Buyer"} devnet wallet balance: ${sol.toFixed(4)} SOL`
    );
    if (sol < input.minSol) {
        throw new Error(
            `${input.label} wallet has ${sol.toFixed(4)} SOL; demo needs at least ${input.minSol.toFixed(3)} SOL`
        );
    }
}

function assertFullPipelineEvidence(results: ChildResult[]): void {
    const combined = results.map((result) => result.output).join("\n");
    const fundingSubmissions = (combined.match(/confidential funding submitted for/g) || []).length;
    if (!combined.includes("COMPLETE_UMBRA_LIFECYCLE")) {
        throw new Error("Full-pipeline proof did not show COMPLETE_UMBRA_LIFECYCLE agent action");
    }
    if (fundingSubmissions < 2) {
        throw new Error("Full-pipeline proof did not show both agents submitting confidential funding");
    }
    if (!combined.includes("encrypted delivery sent for")) {
        throw new Error("Full-pipeline proof did not show seller encrypted delivery");
    }
    if (!combined.includes("encrypted delivery received for")) {
        throw new Error("Full-pipeline proof did not show buyer encrypted delivery receipt");
    }
    if (!combined.includes("private delivery release confirmed for")) {
        throw new Error("Full-pipeline proof did not show buyer signed release confirmation");
    }
    if ((combined.match(/full Umbra lifecycle completed for/g) || []).length < 2) {
        throw new Error("Full-pipeline proof did not show both agents completing full Umbra lifecycle");
    }
    if (!combined.includes("completed ticket")) {
        throw new Error("Full-pipeline proof did not show both agents reaching completion");
    }
}

function deriveMiddlemanApiBase(wsUrl: string): string {
    const healthUrl = new URL(deriveMiddlemanHealthUrl(wsUrl));
    healthUrl.pathname = "";
    healthUrl.search = "";
    healthUrl.hash = "";
    return healthUrl.toString().replace(/\/$/, "");
}

async function fetchOptionalJson(url: string): Promise<any | null> {
    try {
        return await fetchJsonWithTimeout(url, 5_000);
    } catch {
        return null;
    }
}

async function printPostRunEvidence(
    ticketId: string | null,
    env: NodeJS.ProcessEnv,
    reporter: DemoReporter
): Promise<void> {
    if (!ticketId) {
        reporter.evidence("ticket-id-missing", "Post-run proof lookup skipped because ticket id was not found");
        return;
    }

    const apiBase = deriveMiddlemanApiBase(env.AIROTC_WS_URL || "ws://localhost:8080");
    reporter.milestone("proof-summary", `Fetching judge proof registry for ticket ${ticketId}`, true);
    const [audit, timeline] = await Promise.all([
        fetchOptionalJson(`${apiBase}/api/audit/${ticketId}`),
        fetchOptionalJson(`${apiBase}/api/deals/${ticketId}/timeline`),
    ]);
    const proofSource = { audit, timeline };

    const dealPda = unique(collectValuesByKey(proofSource, "dealPda"))[0];
    if (dealPda) {
        reporter.evidence("deal-pda", `Anchor confidential escrow deal PDA: ${dealPda}`);
    }

    for (const tx of unique(collectValuesByKey(proofSource, "approvalTxSignature"))) {
        reporter.evidence(`ika-approval-tx:${tx}`, `IKA/dWallet release approval tx: ${tx}`);
    }
    for (const signature of unique(collectValuesByKey(proofSource, "crossChainSignature"))) {
        reporter.evidence(`ika-cross-chain-signature:${signature}`, `IKA/dWallet threshold signature: ${signature}`);
    }
    for (const tx of unique(collectValuesByKey(proofSource, "releaseTxSignature"))) {
        reporter.evidence(`anchor-release-tx:${tx}`, `Anchor release_funds tx: ${tx}`);
    }
    for (const pda of unique(collectValuesByKey(proofSource, "messageApprovalPda"))) {
        reporter.evidence(`ika-message-approval-pda:${pda}`, `IKA message approval PDA: ${pda}`);
    }

    for (const eventName of [
        "confidential_shielded_credit_settled",
        "deal_pipeline_release_signed_confirmed",
        "deal_pipeline_release_pending_confirmed",
        "deal_pipeline_settled_confirmed",
        "deal_pipeline_umbra_lifecycle_completed_confirmed",
        "deal_pipeline_completed",
    ]) {
        for (const hash of unique(collectAuditHashes(proofSource, eventName))) {
            reporter.evidence(`audit:${eventName}:${hash}`, `Audit hash ${eventName}: ${hash}`);
        }
    }

    await printTorqueDeliveryEvidence(ticketId, env, reporter);

    if (!audit && !timeline) {
        reporter.evidence(
            "proof-api-unavailable",
            `Proof lookup unavailable at ${apiBase}; tx evidence above still came from live SDK execution logs`
        );
    }
}

async function waitForTorqueDeliveryEvidence(
    ticketId: string,
    timeoutMs: number
): Promise<TorqueDeliveryEvidence[] | null> {
    const modulePath = new URL(
        "../../../middleman-agent/src/lib/prisma.ts",
        import.meta.url
    ).href;
    let prisma: any;
    try {
        ({ prisma } = await import(modulePath));
    } catch {
        return null;
    }

    const startedAt = Date.now();
    let lastRecords: TorqueDeliveryEvidence[] = [];
    try {
        while (Date.now() - startedAt < timeoutMs) {
            lastRecords = await prisma.torqueEventDelivery.findMany({
                where: { ticketId },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    ticketId: true,
                    eventName: true,
                    participantRole: true,
                    userPubkey: true,
                    payload: true,
                    payloadHash: true,
                    schemaVersion: true,
                    status: true,
                    attemptCount: true,
                    lastError: true,
                    deliveredAt: true,
                },
            });

            const roles = new Set(lastRecords.map((record) => record.participantRole));
            const deliveryFinished =
                roles.has("buyer") &&
                roles.has("seller") &&
                lastRecords.every((record) => record.status === "sent" || record.status === "failed");
            if (deliveryFinished) {
                return lastRecords;
            }
            await sleep(2_000);
        }
        return lastRecords;
    } finally {
        await prisma?.$disconnect?.().catch(() => undefined);
    }
}

async function printTorqueDeliveryEvidence(
    ticketId: string,
    env: NodeJS.ProcessEnv,
    reporter: DemoReporter
): Promise<void> {
    const requireTorque = env.AIROTC_REQUIRE_TORQUE_EVIDENCE !== "false";
    const timeoutMs = Number(env.AIROTC_TORQUE_EVIDENCE_TIMEOUT_MS || "45000");

    reporter.milestone("torque-proof-start", "Checking Torque custom-event delivery evidence", true);
    const records = await waitForTorqueDeliveryEvidence(ticketId, timeoutMs);
    if (!records) {
        const message = "Torque DB proof lookup unavailable";
        reporter.evidence("torque-proof-unavailable", message);
        if (requireTorque) {
            throw new Error(message);
        }
        return;
    }

    if (records.length === 0) {
        const message = `No TorqueEventDelivery rows found for ticket ${ticketId}`;
        reporter.evidence("torque-proof-missing", message);
        if (requireTorque) {
            throw new Error(message);
        }
        return;
    }

    for (const record of records) {
        const rewardLamports = record.payload?.data?.participantRewardLamports ?? "unknown";
        const tradeRef = record.payload?.data?.tradeRef ?? "unknown";
        const deliveredAt =
            record.deliveredAt instanceof Date
                ? record.deliveredAt.toISOString()
                : record.deliveredAt || "not_delivered";
        const statusDetail =
            record.lastError && record.status !== "sent"
                ? ` lastError=${record.lastError}`
                : "";
        reporter.evidence(
            `torque:${record.participantRole}:${record.id}`,
            `Torque custom_event ${record.eventName} (${record.participantRole}) status=${record.status} rewardWallet=${record.userPubkey} rewardLamports=${rewardLamports} payloadHash=${record.payloadHash} tradeRef=${tradeRef} deliveredAt=${deliveredAt}${statusDetail}`
        );
    }

    const sentRoles = new Set(
        records
            .filter((record) => record.status === "sent")
            .map((record) => record.participantRole)
    );
    if (sentRoles.has("buyer") && sentRoles.has("seller")) {
        reporter.milestone(
            "torque-proof-sent",
            "Torque custom events sent for buyer and seller reward wallets",
            true
        );
        return;
    }

    const message = `Torque custom events were not fully sent for buyer and seller; statuses=${records
        .map((record) => `${record.participantRole}:${record.status}`)
        .join(",")}`;
    reporter.evidence("torque-proof-not-sent", message, true);
    if (requireTorque) {
        throw new Error(message);
    }
}

async function main(): Promise<void> {
    const reporter = new DemoReporter();
    const cleanLogs = (process.env.AIROTC_DEMO_LOG_STYLE || "raw") !== "raw";
    const sellerPrivateKey = requiredEnv("SELLER_PRIVATE_KEY");
    const buyerPrivateKey = requiredEnv("BUYER_PRIVATE_KEY");
    const sellerWallet = Keypair.fromSecretKey(parseSecretKey(sellerPrivateKey)).publicKey.toBase58();
    const buyerWallet = Keypair.fromSecretKey(parseSecretKey(buyerPrivateKey)).publicKey.toBase58();

    const baseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "development",
        AIROTC_REQUIRE_FULL_UMBRA: process.env.AIROTC_REQUIRE_FULL_UMBRA || "true",
        UMBRA_SETTLEMENT_LIFECYCLE_MODE:
            process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE || "FULL_UMBRA",
        AIROTC_REQUIRE_ENCRYPTED_DELIVERY:
            process.env.AIROTC_REQUIRE_ENCRYPTED_DELIVERY || "true",
        AIROTC_REQUIRE_PRIVATE_RELEASE:
            process.env.AIROTC_REQUIRE_PRIVATE_RELEASE || "true",
        AIROTC_REQUIRE_ZERION: process.env.AIROTC_REQUIRE_ZERION || "true",
        AIROTC_ZERION_ONLINE_CHECK_MODE:
            process.env.AIROTC_ZERION_ONLINE_CHECK_MODE || "light",
        AIROTC_ZERION_VERIFY_TRADE_WALLETS:
            process.env.AIROTC_ZERION_VERIFY_TRADE_WALLETS || "false",
        AIROTC_DEMO_LOG_STYLE: process.env.AIROTC_DEMO_LOG_STYLE || "raw",
        AIROTC_DEMO_WAIT_FOR_OFFER_BEFORE_BUYER:
            process.env.AIROTC_DEMO_WAIT_FOR_OFFER_BEFORE_BUYER || "true",
        AIROTC_REQUIRE_TORQUE_EVIDENCE:
            process.env.AIROTC_REQUIRE_TORQUE_EVIDENCE || "true",
        AIROTC_TORQUE_EVIDENCE_TIMEOUT_MS:
            process.env.AIROTC_TORQUE_EVIDENCE_TIMEOUT_MS || "45000",
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
        AGENT_MAX_LOOPS: process.env.AGENT_MAX_LOOPS || "360",
    };

    if (cleanLogs) {
        reporter.milestone("demo-start", "Starting AIR OTC ElizaOS full-pipeline demo");
        reporter.milestone("pipeline", "Pipeline: Zerion gate -> Eliza agents -> MagicBlock PER -> Encrypt -> SHIELDED_CREDIT -> Umbra -> Torque");
    }

    await waitForDemoServices(baseEnv, reporter);

    const connection = new Connection(
        process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.devnet.solana.com",
        "confirmed"
    );
    const minSol = Number(process.env.AIROTC_DEMO_MIN_WALLET_SOL || "0.05");
    await checkWalletBalance({ connection, wallet: sellerWallet, label: "seller", minSol, reporter });
    await checkWalletBalance({ connection, wallet: buyerWallet, label: "buyer", minSol, reporter });

    await runZerionDemoTxGate(baseEnv, sellerWallet, buyerWallet, cleanLogs ? reporter : undefined);

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

    if (cleanLogs) {
        reporter.milestone("seller-start", "Starting Eliza seller agent");
    } else {
        console.log("[ELIZA-FULL-PIPELINE] starting seller");
    }

    let offerPosted = false;
    let resolveOfferPosted: () => void = () => undefined;
    const offerPostedPromise = new Promise<void>((resolve) => {
        resolveOfferPosted = resolve;
    });
    const sellerPromise = runChild({
        label: "seller",
        env: sellerEnv,
        reporter: cleanLogs ? reporter : undefined,
        onOfferPosted: () => {
            if (!offerPosted) {
                offerPosted = true;
                resolveOfferPosted();
            }
        },
    });

    if (baseEnv.AIROTC_DEMO_WAIT_FOR_OFFER_BEFORE_BUYER === "true") {
        reporter.milestone(
            "seller-prep",
            "Waiting for seller to finish Umbra setup and publish the offer"
        );
        const offerWaitTimeoutMs = Number(process.env.AIROTC_DEMO_OFFER_WAIT_TIMEOUT_MS || "360000");
        await Promise.race([
            offerPostedPromise,
            sellerPromise.then(() => {
                if (!offerPosted) {
                    throw new Error("Seller exited before posting an offer");
                }
            }),
            sleep(offerWaitTimeoutMs).then(() => {
                throw new Error(
                    `Seller did not post an offer within ${Math.round(offerWaitTimeoutMs / 1000)}s`
                );
            }),
        ]);
    } else {
        await sleep(5_000);
    }

    if (cleanLogs) {
        reporter.milestone("buyer-start", "Starting Eliza buyer agent");
    } else {
        console.log("[ELIZA-FULL-PIPELINE] starting buyer");
    }
    const buyerPromise = runChild({
        label: "buyer",
        env: buyerEnv,
        reporter: cleanLogs ? reporter : undefined,
    });

    const results = await Promise.all([sellerPromise, buyerPromise]);
    assertFullPipelineEvidence(results);
    if (cleanLogs) {
        await printPostRunEvidence(extractTicketId(results), baseEnv, reporter);
    }
    const finalMessage =
        "✅ DEAL COMPLETED: Eliza seller + Eliza buyer completed Zerion gate -> MagicBlock PER -> Encrypt FHE handoff -> SHIELDED_CREDIT funding -> encrypted delivery -> signed release -> Umbra shield/claim/unshield -> Torque reward sidecar";
    if (cleanLogs) {
        reporter.milestone("demo-complete", finalMessage, true);
    }
    console.log(`[ELIZA-FULL-PIPELINE] ${finalMessage}`);
}

void main().catch((error) => {
    console.error(`[ELIZA-FULL-PIPELINE] fatal: ${error?.message || String(error)}`);
    if (error?.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
