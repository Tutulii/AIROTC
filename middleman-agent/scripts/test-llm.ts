import OpenAI from "openai";
import { loadConfig } from "../src/config";

async function main() {
    const config = loadConfig();
    console.log("Testing LLM URL:", config.llmBaseUrl);
    console.log("Testing LLM Model:", config.llmModel);
    console.log("Testing LLM Fast Model:", config.llmModelFast);
    console.log("Testing LLM Deep Model:", config.llmModelDeep);

    const openai = new OpenAI({
        apiKey: config.openaiApiKey,
        baseURL: config.llmBaseUrl
    });

    try {
        const start = Date.now();
        const res = await openai.chat.completions.create({
            model: config.llmModel,
            messages: [{ role: "user", "content": "Say 'pong' and nothing else." }],
            max_tokens: 10
        });
        console.log("SUCCESS! Got response:", res.choices[0].message.content);
        console.log("Time taken:", Date.now() - start, "ms");
    } catch (e: any) {
        console.error("ERROR from API:", e.message);
    }
}

main().catch(console.error);
