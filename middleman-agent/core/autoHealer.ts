/**
 * Auto Healer (Level 5 Autonomy)
 *
 * Catches on-chain Solana/Anchor execution errors and uses an LLM to dynamically
 * interpret the hex codes or RPC failures.
 * It determines if the error is transient (e.g. blockhash not found) or 
 * requires user action (e.g. 0x1 - Insufficient Funds).
 *
 * Level 5 Enhancement: Checks the autoHealerMemory cache before calling
 * OpenAI. Known error patterns are resolved instantly without LLM latency/cost.
 */

import { loadConfig } from "../src/config";
import OpenAI from "openai";
import { logger } from "../src/utils/logger";
import { getCachedStrategy, cacheStrategy } from "./autoHealerMemory";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const config = loadConfig();
    _client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.llmBaseUrl || undefined,
    });
  }
  return _client;
}

export type HealStrategyType =
  | "RETRY_IMMEDIATE"        // Transient network issue
  | "RETRY_WITH_HIGHER_FEE"  // Block congestion or slippage
  | "RESUME_FROM_STEP"       // Account already exists (transaction succeeded previously)
  | "RE_DERIVE_PDA"          // Account not found (PDA mismatch)
  | "ABORT_USER_ACTION"      // Bad state, user needs to fund wallet or fix inputs
  | "FATAL";                 // Unrecoverable contract panic

export interface AutoHealStrategy {
  strategy: HealStrategyType;
  userMessage: string;
}

export async function interpretExecutionError(
  actionName: string,
  rawErrorMesssage: string
): Promise<AutoHealStrategy> {
  // Level 5: Check memory cache first (instant, no LLM cost)
  const cached = await getCachedStrategy(actionName, rawErrorMesssage);
  if (cached) {
    logger.info("auto_healer_cache_hit", {
      action: actionName,
      strategy: cached.strategy,
    });
    return cached;
  }

  try {
    const openai = getClient();

    // The prompt acts as a Senior Solana Systems Engineer
    const prompt = `You are an expert Solana Blockchain Systems Engineer diagnosing a failed Anchor smart contract transaction.
The agent attempted to execute the action: "${actionName}".
The raw RPC error thrown by Web3.js / Anchor is:
"${rawErrorMesssage}"

Analyze the error. Return a JSON object with your suggested healing strategy.

Allowed strategies:
- "RETRY_IMMEDIATE"       : Use for "Blockhash not found", Node timeouts, or rate limits.
- "RETRY_WITH_HIGHER_FEE" : Use if the error indicates compute budget exceeded or heavy network congestion.
- "RESUME_FROM_STEP"      : Use if the error indicates "already in use" or "account already initialized". This implies the step actually succeeded previously.
- "RE_DERIVE_PDA"         : Use if the error is "AccountNotFound" or a PDA mismatch, indicating we lost the correct derivation seed.
- "ABORT_USER_ACTION"     : Use for Custom Anchor Error Codes indicating invalid state, "Insufficient Funds", or Rent Exemption failures. Provide an exact, friendly message telling the user how to fix it.
- "FATAL"                 : Use for internal program mismatches or unrecoverable panics.

Respond ONLY in valid JSON with this structure:
{
  "strategy": "RETRY_IMMEDIATE" | "RETRY_WITH_HIGHER_FEE" | "RESUME_FROM_STEP" | "RE_DERIVE_PDA" | "ABORT_USER_ACTION" | "FATAL",
  "userMessage": string // What to tell the user. e.g., "The network is congested, retrying..." or "You need 0.002 SOL for rent to create this escrow."
}`;

    const client = getClient();
    const config = loadConfig();
    const response = await client.chat.completions.create({
      model: config.llmModel,
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const outputString = response.choices[0].message.content;
    if (!outputString) throw new Error("Empty response from OpenAI");

    const parsed = JSON.parse(outputString);

    // GUARDRAIL 1: Validate strategy against whitelist
    const SAFE_STRATEGIES: HealStrategyType[] = ["RETRY_IMMEDIATE", "RETRY_WITH_HIGHER_FEE", "RESUME_FROM_STEP", "RE_DERIVE_PDA", "ABORT_USER_ACTION", "FATAL"];
    let finalStrategy = parsed.strategy as HealStrategyType || "FATAL";
    if (!SAFE_STRATEGIES.includes(finalStrategy)) {
      logger.warn("auto_healer_unknown_strategy_forced_fatal", {
        action: actionName,
        original_strategy: parsed.strategy,
      });
      finalStrategy = "FATAL";
    }

    const result: AutoHealStrategy = {
      strategy: finalStrategy,
      userMessage: parsed.userMessage || "Unknown fatal error occurred.",
    };

    // Level 5: Cache the LLM result for future reuse
    cacheStrategy(actionName, rawErrorMesssage, result).catch(() => { });

    return result;

  } catch (error: any) {
    logger.error("auto_healer_failed", { action: actionName }, error);
    return {
      strategy: "FATAL",
      userMessage: `A critical system execution error occurred: ${rawErrorMesssage}`,
    };
  }
}

