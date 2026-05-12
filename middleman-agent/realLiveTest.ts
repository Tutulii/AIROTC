import { CognitiveEngine } from "./src/services/cognitiveEngine";
import { loadConfig } from "./src/config";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

async function main() {
    const config = loadConfig();
    const openai = new OpenAI({ apiKey: config.openaiApiKey });
    const soulFile = fs.readFileSync(path.join(__dirname, "SOUL.md"), "utf8");

    const llmCaller = async () => {
        console.log("Calling OpenAI GPT-4o-mini...");
        const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "system",
                content: `You are the continuous inner cognitive core of the @middleman agent. Analyze your identity, recent events and internal mood. Generate your next immediate thought, your current emotional mood name, an annoyance level (0-10), and whether you should spontaneously post to Moltbook. Output strictly valid JSON with keys: "thought", "currentMood", "internalAnnoyanceLevel", "postToSocial", "proposedPost".
                
IDENTITY:
${soulFile}

RECENT EVENTS: A buyer stalled on sending collateral for 40 minutes, causing the system to automatically flag it. The seller then complained about the stalled UI.`
            }],
            response_format: { type: "json_object" }
        });
        return res.choices[0].message.content || "{}";
    };

    // Override the loop to run fast
    config.cognitiveIntervalMs = 1000;

    const engine = new CognitiveEngine(config, llmCaller, config.soulFilePath || path.join(__dirname, "SOUL.md"));

    engine.on("thought", (thought) => {
        console.log("\n------------------------");
        console.log("🤔 [LIVE COGNITIVE CYCLE COMPLETE]");
        console.log("   Mood:", thought.currentMood);
        console.log("   Annoyance (0-10):", thought.internalAnnoyanceLevel);
        console.log("   Thought:", thought.thought);

        if (!thought.postToSocial) {
            console.log("------------------------\n[No spontaneous post triggered]");
            process.exit(0);
        }
    });

    engine.on("spontaneous_post", (thought) => {
        console.log("\n💬 [SPONTANEOUS POST TRIGGERED]");
        console.log("   Proposed Tweet:", thought.proposedPost);
        console.log("------------------------\n");
        process.exit(0);
    });

    console.log("\nStarting Live OpenAI Inference Engine (wait ~3 seconds)...");
    engine.startLoop();
}

main().catch(console.error);
