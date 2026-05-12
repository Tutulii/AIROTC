import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import { loadConfig } from '../src/config';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();
const config = loadConfig();
const openai = new OpenAI({ apiKey: config.openaiApiKey });

interface MemoryRow {
    ticketId: string;
    content: string;
    createdAt: Date;
}

async function runReflection() {
    console.log("Starting Nightly Reflection Loop...");

    // 1. Get the most recent 300 vector memories directly using raw SQL
    const recentMemories = await prisma.$queryRaw<MemoryRow[]>`
    SELECT "ticketId", content, "createdAt"
    FROM "VectorMemory"
    ORDER BY "createdAt" DESC
    LIMIT 300
  `;

    if (!recentMemories || recentMemories.length === 0) {
        console.log("No recent events to reflect upon. Exiting.");
        process.exit(0);
    }

    // 2. Group by ticket
    const grouped: Record<string, string[]> = {};
    for (const m of recentMemories) {
        if (!grouped[m.ticketId]) grouped[m.ticketId] = [];
        grouped[m.ticketId].push(m.content);
    }

    let contextStr = "";
    for (const [ticketId, messages] of Object.entries(grouped)) {
        // Reverse because we queried DESC (newest first), so we want chronological context per ticket
        contextStr += `\n--- Ticket ${ticketId} ---\n`;
        contextStr += messages.reverse().join("\n");
    }

    // 3. Query LLM to propose new beliefs
    const prompt = `You are Meridian's continuous reflection engine. This runs nightly (offline).
Review the recent interaction logs across multiple deals below.

Your job is to propose new "trust", "preferences", or "dislikes" to append to the agent's Beliefs.json file, but ONLY based on repeating patterns of annoyance or friction in these logs.
Do not invent anything. If everything went smoothly, you can propose trust adjustments like "smooth_operators".

Output strictly valid JSON proposing NEW beliefs to be merged. Follow this structure:
{
  "proposedUpdate": {
     "trust": { "pattern_name": { "score": -0.5, "reason": "Detailed reason observed in logs." } },
     "preferences": {},
     "dislikes": {}
  }
}`;

    console.log("Sending recent context (", contextStr.length, "bytes) to LLM for reflection...");

    const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: prompt },
            { role: "user", content: `[RECENT DEAL CONTEXT]:\n${contextStr.substring(0, 50000)}` }
        ],
        response_format: { type: "json_object" }
    });

    const output = res.choices[0].message.content;
    console.log("\n==================================");
    console.log("🧠 [PROPOSED BELIEF UPDATES]");
    console.log("==================================\n");
    console.log(output);

    // 4. Write to ProposedBeliefs.json for human review
    const outPath = path.join(__dirname, "../../ProposedBeliefs.json");
    fs.writeFileSync(outPath, output || "{}");
    console.log(`\n✅ Safely wrote proposals to: ${outPath}`);
    console.log("Human must review and copy approved additions to Beliefs.json.");

    process.exit(0);
}

runReflection().catch(e => {
    console.error("Reflection Error:", e);
    process.exit(1);
});
