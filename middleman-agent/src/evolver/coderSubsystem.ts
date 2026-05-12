import OpenAI from "openai";
import { loadConfig } from "../config";
import { logger } from "../utils/logger";

// Initialize OpenAI lazily
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
    if (!_openai) {
        const config = loadConfig();
        _openai = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });
    }
    return _openai;
}

export interface GeneratedModule {
    moduleName: string;
    tsCode: string;
    testCode: string;
    readme: string;
}

/**
 * Dimension J: The Coder Subsystem
 * 
 * Takes a declared capability gap from the MiddlemanBrain and physically writes
 * TypeScript code to solve the problem.
 * 
 * @param goal What the tool needs to achieve
 * @param inputs Expected input formats
 * @returns GeneratedModule containing raw code strings
 */
export async function generateModuleCode(goal: string, inputs: string): Promise<GeneratedModule> {
    const openai = getOpenAI();

    const systemPrompt = `You are the Evolver Subsystem (Dimension J) for the AgentOTC autonomous Middleman.
The main brain has encountered a task it cannot solve and is requesting you to build a TypeScript module to extend its capabilities.

You MUST follow these strict rules to ensure the code survives the Sandboxing Engine:
1. NO EXTERNAL IMPORTS: You may NOT import 'fs', 'child_process', 'os', 'net', 'axios', 'http', or any external networking or file-system libraries.
2. NO DOM: You are running in Node.js. No window or document.
3. SINGLE EXPORT: You must export a single function named 'execute'. 
4. DETERMINISTIC: The code must be purely functional. Data in -> Processing -> Data out.
5. NO CONSOLE.LOGS: Use return values.

YOUR OUTPUT FORMAT:
You must return a raw JSON object containing exact strings for the following fields:
- "moduleName": A camelCase name for the tool (e.g., "exponentialDecayHelper").
- "tsCode": The pure TypeScript code containing the 'execute' function.
- "testCode": A TypeScript unit test snippet. Just the test cases assuming 'execute' is imported.
- "readme": A brief markdown explanation of what the tool does and its math/logic.

GOAL: ${goal}
INPUTS: ${inputs}

Always respond explicitly following this JSON format:
{
  "moduleName": "string",
  "tsCode": "string",
  "testCode": "string",
  "readme": "string"
}`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o", // Use standard GPT-4o for complex coding tasks instead of mini
            messages: [
                { role: "system", content: systemPrompt }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
        });

        const outputString = response.choices[0].message.content;
        if (!outputString) throw new Error("Empty response from Evolver Coder LLM");

        const parsed = JSON.parse(outputString);

        logger.info("evolver_code_generated", { module: parsed.moduleName, goal });

        return {
            moduleName: parsed.moduleName,
            tsCode: parsed.tsCode,
            testCode: parsed.testCode,
            readme: parsed.readme
        };

    } catch (error: any) {
        logger.error("evolver_code_generation_failed", { goal }, error);
        throw error;
    }
}
