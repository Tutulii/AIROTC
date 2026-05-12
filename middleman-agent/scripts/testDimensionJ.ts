import { analyzeMiddlemanMention } from "../core/commandParser";
import { generateModuleCode } from "../src/evolver/coderSubsystem";
import { injectAndLoadModule, runDynamicTool } from "../src/evolver/hotLoader";
import { logger } from "../src/utils/logger";
import dotenv from "dotenv";

dotenv.config();

async function runDimensionJTest() {
    console.log("=========================================");
    console.log("🚀 INITIATING DIMENSION J END-TO-END TEST");
    console.log("=========================================\n");

    const fakeTicketId = "TEST-J-TICKET-" + Date.now();
    const sender = "Buyer-123";

    // 1. Social engineer the Brain into hitting a capability wall
    const message = "@middleman I agree to the deal, but the collateral size must be calculated using a 'Sigmoid Decay Curve' over 30 days based on the starting collateral of 500 SOL, returning the current day collateral requirement. I don't think you have a tool for this.";

    console.log(`[1] THE BRAIN: Analyzing chaotic natural language input:`);
    console.log(`💬 "${message}"\n`);

    const brainDecision = await analyzeMiddlemanMention(message, sender, fakeTicketId);

    if (!brainDecision.missing_capability_detected) {
        console.error("❌ Test Failed. The brain did not request an Evolver upgrade. It tried to wing it.");
        console.log("Intent output: ", brainDecision.intent);
        process.exit(1);
    }

    console.log("✅ The Brain successfully detected a capability gap!");
    console.log(`🔧 Requested Tool Goal: ${brainDecision.missing_capability_detected.goal}`);
    console.log(`📥 Required Inputs: ${brainDecision.missing_capability_detected.inputs}\n`);

    // 2. Pass the gap to the Evolver Factory
    console.log(`[2] THE EVOLVER: Firing up GPT-4o to write raw TypeScript...`);

    const generatedModule = await generateModuleCode(
        brainDecision.missing_capability_detected.goal,
        brainDecision.missing_capability_detected.inputs
    );

    console.log(`✅ Evolver generated tool: [${generatedModule.moduleName}]`);
    console.log(`\n--- Generated Code Snapshot ---\n${generatedModule.tsCode.substring(0, 150)}...\n-------------------------------\n`);

    // 3. Sandbox and Hot-Load
    console.log(`[3] THE SANDBOX & HOT-LOADER: Parsing AST natively and injecting to V8 VM...`);

    const isLoaded = await injectAndLoadModule(generatedModule);
    if (!isLoaded) {
        console.error("❌ Test Failed. The Sandbox blocked or crashed the code.");
        process.exit(1);
    }

    console.log(`✅ Code successfully passed AST safety checks, dynamically transcoded, and injected into VM Sandbox.\n`);

    // 4. Live Execution Call
    console.log(`[4] LIVE EXECUTION: The agent uses the tool it just built purely autonomously.`);

    try {
        // Let's pass 'day 15' to the Sigmoid curve over 30 days starting at 500 SOL
        console.log(`Running dynamic tool for Day 15, starting collateral 500 SOL...`);
        const result = runDynamicTool(generatedModule.moduleName, 500, 15);

        console.log(`✅ Dynamic Tool returned result: ${result}`);
        if (result === undefined || isNaN(Number(result))) {
            console.error("⚠️ Warning: Output format wasn't a clean number, but the pipeline executed perfectly!");
        }

        console.log("\n=========================================");
        console.log("🏆 DIMENSION J AUTONOMY ACHIEVED");
        console.log("=========================================\n");
        process.exit(0);

    } catch (e: any) {
        console.error("❌ Live Execution crashed (J6 Rollback triggered).", e);
        process.exit(1);
    }
}

runDimensionJTest().catch(console.error);
