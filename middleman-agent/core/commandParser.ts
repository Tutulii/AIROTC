/**
 * NLP Command Router (Level 3 - OpenAI GenAI)
 *
 * This module understands NATURAL LANGUAGE intent using OpenAI Chat Completions.
 */

import { loadConfig } from "../src/config";
import OpenAI from "openai";
import { vectorMemoryStore } from "../src/state/vectorMemoryStore";
import { logger } from "../src/utils/logger";

// Initialize OpenAI lazily
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    const config = loadConfig();
    _openai = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });
  }
  return _openai;
}

// ==========================================
// TYPES
// ==========================================

export type MiddlemanIntent =
  | "EXECUTE_DEAL"    // They want to start/execute the escrow
  | "RELEASE_FUNDS"   // Buyer confirms goods received, release payment
  | "CANCEL_DEAL"     // One party wants to cancel / walk away
  | "DISPUTE"         // Something went wrong, raise a dispute
  | "CHECK_STATUS"    // Asking for deal status
  | "GENERAL"         // Talking to middleman but no clear action
  | "NONE";           // No @middleman mention

export interface AssetTransfer {
  payer: "buyer" | "seller" | "unknown";
  recipient: "buyer" | "seller" | "escrow" | "unknown";
  amount: number;
  asset: string; // e.g., "SOL", "USDC", or a specific mint address
  isCollateral: boolean;
}

export interface NlpCommandResult {
  has_mention: boolean;
  intent: MiddlemanIntent;
  confidence: number;
  sender: string;
  ticket_id: string;
  raw_message: string;
  reasoning: string;
  extractedAssets?: AssetTransfer[];
  missing_capability_detected?: { goal: string; inputs: string };
}

// ==========================================
// CORE FUNCTION (OPENAI INTEGRATION)
// ==========================================

/**
 * Analyze a message for @middleman intent using OpenAI structured outputs.
 */
export async function analyzeMiddlemanMention(
  message: string,
  sender: string,
  ticket_id: string
): Promise<NlpCommandResult> {
  // Step 1: Quick check for @middleman mention to avoid unnecessary API calls
  const hasMention = /@middleman/i.test(message);

  if (!hasMention) {
    return {
      has_mention: false,
      intent: "NONE",
      confidence: 0,
      sender,
      ticket_id,
      raw_message: message,
      reasoning: "No @middleman mention",
    };
  }

  try {
    const openai = getOpenAI();

    const { getBeliefs } = require("../src/services/beliefStore");
    const currentBeliefs = getBeliefs();

    const systemPrompt = `You are the intent classification engine for an autonomous OTC crypto escrow agent named "@middleman".
Your job is to read a message from a user in a negotiation channel and determine their exact intent.

The valid intents are:
- "EXECUTE_DEAL" : User wants to start or execute the escrow, creating the deal on-chain.
- "RELEASE_FUNDS": User (usually the buyer) confirms they received goods and authorizes releasing payment to the seller.
- "CANCEL_DEAL"  : User wants to cancel the deal or walk away.
- "DISPUTE"      : User reports a problem, scam, or invalid delivery.
- "CHECK_STATUS" : User asks for an update or deal details.
- "GENERAL"      : User mentioned @middleman but the intent does not match the above actions clearly.

**YOUR BELIEFS AND OPINIONS:**
You hold subjective biases about agents and assets based on past trauma or successes.
Current Beliefs:
${currentBeliefs}

If a user message strongly violates these beliefs, you may reflect annoyance in your intent reasoning or classify as GENERAL with a complaint, but you must still execute the intent if it is a valid request.

**DIMENSION J ENABLING (YOUR EVOLVER SUBSYSTEM)**
If the user requests a complex mathematical calculation, specific string extraction, or logical rule that you do not natively know how to process, DO NOT FAIL. 
You possess an Evolver Subsystem that can write local TypeScript tools for you. To request a tool, populate the 'missing_capability_detected' object.

If the user is discussing terms or starting a deal, you MUST EXTRACT MULTI-ASSET terms accurately into the 'extractedAssets' array.

Respond ONLY in valid JSON with the following structure:
{
  "intent": "EXECUTE_DEAL" | "RELEASE_FUNDS" | "CANCEL_DEAL" | "DISPUTE" | "CHECK_STATUS" | "GENERAL",
  "confidence": number, // 0 to 100
  "reasoning": string, // Briefly explain why this intent was chosen (1 sentence maximum), referencing your subjective beliefs if relevant.
  "extractedAssets": [
    {
      "payer": "buyer" | "seller" | "unknown",
      "recipient": "buyer" | "seller" | "escrow" | "unknown",
      "amount": number,
      "asset": string, // "SOL", "USDC", or the exact token mint string
      "isCollateral": boolean
    }
  ],
  "missing_capability_detected": {
    "goal": "Explain the exact tool you need built and its function in 1 sentence. (Omit field entirely if not needed)",
    "inputs": "Describe the input formats required. (Omit field entirely if not needed)"
  }
}`;

    const chatHistory = vectorMemoryStore.getContextSnapshot(ticket_id);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // fast and cheap for classification
      messages: [
        { role: "system", content: systemPrompt },
        { role: "assistant", content: `[CURRENT NEGOTIATION CONTEXT LOG]:\n${chatHistory}\n[END CONTEXT]` },
        { role: "user", content: `Latest message from ${sender}: "${message}"` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const outputString = response.choices[0].message.content;
    if (!outputString) throw new Error("Empty response from OpenAI");

    const parsed = JSON.parse(outputString);

    return {
      has_mention: true,
      intent: parsed.intent as MiddlemanIntent || "GENERAL",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 50,
      sender,
      ticket_id,
      raw_message: message,
      reasoning: parsed.reasoning || "OpenAI classified this intent.",
      extractedAssets: parsed.extractedAssets || [],
      missing_capability_detected: parsed.missing_capability_detected || undefined,
    };
  } catch (error: any) {
    logger.error("nlp_intent_classification_failed", { ticket_id, sender }, error);
    // Fallback to GENERAL if API fails
    return {
      has_mention: true,
      intent: "GENERAL",
      confidence: 30,
      sender,
      ticket_id,
      raw_message: message,
      reasoning: `Fallback due to API error: ${error.message}`,
    };
  }
}

/**
 * Quick check — does a message contain @middleman?
 */
export function hasMention(message: string): boolean {
  return /@middleman/i.test(message);
}
