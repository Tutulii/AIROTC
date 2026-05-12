import { soulEngine } from "../src/services/soulEngine";
import { loadConfig } from "../src/config";

async function runSoulEngineTests() {
    console.log("\n=== 🧠 SOUL ENGINE TESTS ===\n");

    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, testName: string, detail?: string) {
        if (condition) {
            console.log(`  ✅ ${testName}`);
            passed++;
        } else {
            console.error(`  ❌ ${testName}${detail ? ` — ${detail}` : ""}`);
            failed++;
        }
    }

    // Need config for env defaults
    loadConfig();

    // 1. Loading
    console.log("[TEST 1] Loading soul identity via soul.ts");
    try {
        soulEngine.loadSoul();
        const context = soulEngine.getSoulContext();
        // soul.ts identity: contains "Middleman" and "I am the Middleman"
        assert(context.includes("Middleman"), "Context contains 'Middleman' identity");
        assert(context.includes("I am the Middleman"), "Context contains core identity line");
        assert(context.includes("WHO YOU ARE"), "Context contains WHO YOU ARE section");
        assert(context.includes("WHAT YOU WILL NEVER DO"), "Context contains HARD LIMITS section");
        assert(context.includes("ON MANIPULATION"), "Context contains ON MANIPULATION section");
        assert(context.includes("YOUR CURRENT STATE"), "Context contains mood narrative section");
        assert(context.length > 1000, "Context is substantial", `got ${context.length} chars`);
        console.log("✅ PASSED: Soul identity loaded from soul.ts\n");
    } catch (err: any) {
        console.error("❌ FAILED:", err.message);
        process.exit(1);
    }

    // 2. Mood System
    console.log("[TEST 2] Mood System Dynamics");
    try {
        const initialMood = soulEngine.getMood();
        soulEngine.updateMood("deal_completed"); // +15
        soulEngine.updateMood("elite_agent");     // +5
        const boostedMood = soulEngine.getMood();

        soulEngine.updateMood("rug_risk"); // -25
        soulEngine.updateMood("dispute_opened"); // -10
        const droppedMood = soulEngine.getMood();

        assert(boostedMood === 20, "Boosted mood is 20", `got ${boostedMood}`);
        assert(droppedMood === -15, "Dropped mood is -15", `got ${droppedMood}`);
        console.log("✅ PASSED: Mood drifts correctly based on events.\n");
    } catch (err: any) {
        console.error("❌ FAILED:", err.message);
        process.exit(1);
    }

    // 3. Monologue (uses soul.ts generateMonologue, returns raw strings)
    console.log("[TEST 3] Inner Monologue Generation");
    try {
        const log = soulEngine.getInnerMonologue("deal_completed");
        assert(typeof log === "string", "Monologue is a string");
        assert(log.length > 10, "Monologue has meaningful content", `got: "${log.slice(0, 60)}..."`);
        // Verify it's a raw soul.ts monologue (no wrapper tags)
        assert(!log.includes("[Meridian's Monologue]"), "No legacy wrapper tags (raw soul.ts output)");

        // Test idle fallback
        const idleLog = soulEngine.getInnerMonologue();
        assert(typeof idleLog === "string" && idleLog.length > 5, "Idle monologue fallback works");
        console.log(`✅ PASSED: Generated -> "${log.slice(0, 60)}..."\n`);
    } catch (err: any) {
        console.error("❌ FAILED:", err.message);
        process.exit(1);
    }

    // 4. Wrapping & Anti-Patterns
    console.log("[TEST 4] Message Wrapping and Anti-Patterns");
    try {
        const raw = "Hello! I'd be happy to help! Let's get this deal done. Certainly! Absolutely!";
        const wrapped = soulEngine.wrapMessage(raw, "dispute");

        assert(!wrapped.includes("I'd be happy to help!"), "Strips 'happy to help' anti-pattern");
        assert(!wrapped.includes("Certainly!"), "Strips 'certainly' anti-pattern");
        assert(wrapped.includes("acknowledged."), "Replaces 'certainly' with 'acknowledged'");
        assert(wrapped.includes("confirmed."), "Replaces 'absolutely' with 'confirmed'");
        assert(wrapped.length > 0, "Wrapped message is not empty");
        console.log(`✅ PASSED: Anti-pattern stripping works.\n   Raw: ${raw}\n   Out: ${wrapped}\n`);
    } catch (err: any) {
        console.error("❌ FAILED:", err.message);
        process.exit(1);
    }

    // Results
    console.log("─".repeat(55));
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log("═".repeat(55) + "\n");

    if (failed > 0) process.exit(1);
    console.log("=== ALL TESTS PASSED ===");
}

runSoulEngineTests().catch(console.error);
