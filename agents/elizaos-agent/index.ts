import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import {
    AgentRuntime,
    InMemoryDatabaseAdapter,
    type Character,
} from "@elizaos/core";
import { createAirotcTraderCharacter } from "./character.js";
import { buildAirotcProviderResult } from "./providers/airotcProvider.js";
import { airotcPlugin } from "./plugins/airotcPlugin.js";
import { meridianSDK } from "./services/meridianSDK.js";
import { dealTracker, type AgentLoopAction, type AgentRole } from "./services/dealTracker.js";
import { decideNextAction } from "./services/decisionEngine.js";
import { registerGroqTextModels } from "./services/groqModel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

for (const candidate of [
    path.join(__dirname, ".env.local"),
    path.join(__dirname, ".env"),
    path.join(__dirname, "../../middleman-agent/.env.local"),
    path.join(__dirname, "../../middleman-agent/.env"),
    path.join(__dirname, "../../api-server/.env.local"),
    path.join(__dirname, "../../api-server/.env"),
    path.join(__dirname, "../../.env.local"),
    path.join(__dirname, "../../.env"),
]) {
    dotenv.config({ path: candidate, override: false });
}

function parseRole(argv: string[]): AgentRole {
    const roleIndex = argv.indexOf("--role");
    if (roleIndex !== -1 && argv[roleIndex + 1] === "seller") {
        return "seller";
    }
    return "buyer";
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeAction(action: AgentLoopAction): Promise<void> {
    switch (action) {
        case "WAIT":
        case "STOP":
            return;
        case "POST_OFFER":
            await meridianSDK.postCanonicalOffer();
            return;
        case "BROWSE_AND_ACCEPT_OFFER":
            await meridianSDK.browseAndAcceptBestOffer();
            return;
        case "COMPLETE_PRIVATE_AGREEMENT":
            await meridianSDK.completeCanonicalPrivateAgreement();
            return;
        case "AUTO_FUND_PRIVATE_DEAL":
            await meridianSDK.autoFundCurrentDeal();
            return;
        case "SEND_ENCRYPTED_DELIVERY":
            await meridianSDK.sendCanonicalEncryptedDelivery();
            return;
        case "CHECK_ENCRYPTED_DELIVERY":
            await meridianSDK.checkEncryptedDelivery();
            return;
        case "CONFIRM_PRIVATE_DELIVERY":
            await meridianSDK.confirmCurrentPrivateDelivery();
            return;
        case "COMPLETE_UMBRA_LIFECYCLE":
            await meridianSDK.completeUmbraLifecycle();
            return;
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const role = parseRole(args);
    const privateMode = args.includes("--private");
    const loopDelayMs = Number(process.env.AGENT_LOOP_DELAY_MS || 2500);
    const maxLoops = Number(process.env.AGENT_MAX_LOOPS || 240);

    const character: Character = createAirotcTraderCharacter({
        role,
        privateMode,
    });

    const runtime = new AgentRuntime({
        character,
        plugins: [airotcPlugin],
        adapter: new InMemoryDatabaseAdapter(),
        disableBasicCapabilities: true,
        actionPlanning: false,
        checkShouldRespond: false,
        enableAutonomy: false,
        enableTrajectories: false,
        logLevel:
            (process.env.AIROTC_ELIZA_LOG_LEVEL as
                | "trace"
                | "debug"
                | "info"
                | "warn"
                | "error"
                | "fatal") || "info",
    });

    let stopping = false;
    const shutdown = async (code: number) => {
        if (stopping) {
            return;
        }
        stopping = true;
        await meridianSDK.shutdown().catch(() => undefined);
        await runtime.stop().catch(() => undefined);
        process.exit(code);
    };

    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));

    console.log(
        `[ELIZA-AIR OTC] booting ${role.toUpperCase()} agent in ${privateMode ? "PER" : "ER"} mode`
    );

    try {
        await runtime.initialize({ skipMigrations: true });
        const llmEnabled = registerGroqTextModels(runtime);

        await meridianSDK.initialize(role, privateMode);

        console.log(
            `[ELIZA-AIR OTC] wallet=${meridianSDK.getWalletAddress()} llm=${llmEnabled ? "enabled" : "deterministic-fallback"}`
        );

        for (let loop = 1; loop <= maxLoops; loop += 1) {
            await meridianSDK.refreshDynamicState();
            const snapshot = dealTracker.getSnapshot();

            if (snapshot.dealCompleted) {
                console.log(
                    `[ELIZA-AIR OTC] ${role.toUpperCase()} completed ticket ${snapshot.activeTicketId ?? "unknown"}`
                );
                await shutdown(0);
                return;
            }

            const provider = await buildAirotcProviderResult();
            const decision = await decideNextAction({
                runtime,
                character,
                provider,
                snapshot,
                useLlm: llmEnabled,
            });

            dealTracker.noteAction(decision.action, decision.reason);
            console.log(
                `[ELIZA-AIR OTC] loop=${loop} role=${role} phase=${snapshot.currentPhase} action=${decision.action} reason=${decision.reason}`
            );

            try {
                await executeAction(decision.action);
            } catch (error: any) {
                const message = error?.message || String(error);
                dealTracker.noteError(message);
                console.error(
                    `[ELIZA-AIR OTC] action=${decision.action} failed: ${message}`
                );
            }

            const latest = dealTracker.getSnapshot();
            if (latest.dealCompleted) {
                console.log(
                    `[ELIZA-AIR OTC] ${role.toUpperCase()} completed ticket ${latest.activeTicketId ?? "unknown"}`
                );
                await shutdown(0);
                return;
            }

            if (decision.action === "STOP") {
                await shutdown(latest.dealCompleted ? 0 : 1);
                return;
            }

            await sleep(loopDelayMs);
        }

        throw new Error(`Agent loop exceeded ${maxLoops} iterations without reaching settlement`);
    } catch (error: any) {
        console.error(`[ELIZA-AIR OTC] fatal: ${error?.message || String(error)}`);
        if (error?.stack) {
            console.error(error.stack);
        }
        await shutdown(1);
    }
}

void main();
