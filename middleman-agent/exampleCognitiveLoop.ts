import { CognitiveEngine } from "./src/services/cognitiveEngine";
import path from "path";

const config = {
    cognitiveIntervalMs: 2000,
    enableCognitiveLoop: true,
    cognitiveMemoryDepth: 5,
    cognitiveEventDepth: 10,
    socialPostAnnoyanceThreshold: 7,
};

// Mock LLM Caller returning a JSON payload
const llmCaller = async () => {
    return JSON.stringify({
        thought: "I just saw three deposits successfully clear. This is satisfying.",
        currentMood: "satisfied",
        internalAnnoyanceLevel: 0,
        postToSocial: true,
        proposedPost: "The network is humming today. Three clean blocks, three clean deals."
    });
};

const engine = new CognitiveEngine(config, llmCaller, path.join(__dirname, "SOUL.md"));

engine.on("thought", (thought) => {
    console.log("\n------------------------");
    console.log("🤔 [COGNITIVE CYCLE COMPLETE]");
    console.log("   Mood:", thought.currentMood);
    console.log("   Annoyance (0-10):", thought.internalAnnoyanceLevel);
    console.log("   Thought:", thought.thought);
});

engine.on("spontaneous_post", (thought) => {
    console.log("\n💬 [SPONTANEOUS POST TRIGGERED]");
    console.log("   Proposed Tweet:", thought.proposedPost);
    console.log("------------------------\n");

    // Stop the engine cleanly after one successful run
    engine.stopLoop();
    process.exit(0);
});

console.log("\nStarting Cognitive Engine isolated test run...");
engine.startLoop();
