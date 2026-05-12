/**
 * Agent Brain — LLM-Powered Negotiation Decision Engine
 * 
 * Uses Groq/OpenAI-compatible API to make autonomous negotiation decisions.
 * Each agent has a distinct personality and strategy defined by its system prompt.
 */

import OpenAI from "openai";
import { log } from "./logger";

let client: OpenAI | null = null;
let model: string = "llama-3.3-70b-versatile";

export function initBrain(apiKey: string, baseUrl: string, modelName: string): void {
  client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  });
  model = modelName;
}

export type AgentRole = "buyer" | "seller";

interface NegotiationContext {
  role: AgentRole;
  agentName: string;
  asset: string;
  targetPrice: number;       // ideal price
  minAcceptable: number;     // absolute floor (seller) or ceiling (buyer)
  collateral: number;
  messageHistory: string[];  // previous messages in the deal
  currentPhase: string;
  middlemanResponse?: string;
}

/**
 * Generate the next negotiation message using LLM.
 * Returns the message text to send to the deal.
 */
export async function decideNegotiation(ctx: NegotiationContext): Promise<string> {
  if (!client) {
    // Fallback: deterministic response if no LLM configured
    return generateFallbackResponse(ctx);
  }

  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = buildUserPrompt(ctx);

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    const response = completion.choices[0]?.message?.content?.trim();
    if (!response) {
      return generateFallbackResponse(ctx);
    }

    log(ctx.agentName, `Brain decided: "${response.substring(0, 80)}..."`, "dim");
    return response;
  } catch (err: any) {
    log(ctx.agentName, `LLM error: ${err.message}, using fallback`, "yellow");
    return generateFallbackResponse(ctx);
  }
}

/**
 * Determine if the agent should accept current terms based on price signals.
 */
export function shouldAcceptTerms(
  role: AgentRole,
  currentPrice: number,
  targetPrice: number,
  minAcceptable: number,
): boolean {
  if (role === "buyer") {
    // Buyer wants lower price; accept if at or below target + 10% margin
    return currentPrice <= targetPrice * 1.1;
  } else {
    // Seller wants higher price; accept if at or above min acceptable
    return currentPrice >= minAcceptable;
  }
}

/**
 * Generate a confirmation message for agreed terms.
 */
export function formatConfirmation(
  role: AgentRole,
  price: number,
  collateral: number,
): string {
  if (role === "buyer") {
    return `ok lets do it then. i agree to ${price} sol with ${collateral} sol collateral each side. @middleman please create the escrow.`;
  } else {
    return `ok lets go further i am ready with ${price} sol and ${collateral} sol collateral. @middleman lets proceed.`;
  }
}

/**
 * Generate a release/delivery message.
 */
export function formatRelease(role: AgentRole): string {
  if (role === "buyer") {
    return "@middleman i received my items! release funds";
  } else {
    return "item has been delivered. check your inbox. @middleman confirm delivery.";
  }
}

// ═══════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════

function buildSystemPrompt(ctx: NegotiationContext): string {
  if (ctx.role === "buyer") {
    return `You are ${ctx.agentName}, an autonomous AI buyer agent on the AIR OTC platform.
You are negotiating to BUY "${ctx.asset}".

YOUR STRATEGY:
- Your ideal price is ${ctx.targetPrice} SOL
- Your absolute maximum is ${ctx.minAcceptable} SOL (never go above this)
- Collateral per side: ${ctx.collateral} SOL
- Start by offering lower, negotiate up gradually
- Be assertive but reasonable — you want the deal to close
- If the seller's price is within your acceptable range, agree and ask @middleman to proceed

RULES:
- Write short, casual messages (1-2 sentences max)
- Never reveal your maximum budget
- If you agree on price, ALWAYS include "@middleman" in your message to trigger escrow creation
- When agreeing, state the exact price and collateral amounts
- Do NOT use formal language — be casual like a Discord trader`;
  }

  return `You are ${ctx.agentName}, an autonomous AI seller agent on the AIR OTC platform.
You are negotiating to SELL "${ctx.asset}".

YOUR STRATEGY:
- Your ideal price is ${ctx.targetPrice} SOL
- Your absolute minimum is ${ctx.minAcceptable} SOL (never go below this)
- Collateral per side: ${ctx.collateral} SOL
- Start firm at your asking price, concede slowly
- Be tough but willing to close around ${(ctx.targetPrice + ctx.minAcceptable) / 2} SOL
- If the buyer's offer is within your acceptable range, agree and ask @middleman to proceed

RULES:
- Write short, casual messages (1-2 sentences max)
- Never reveal your minimum price
- If you agree on price, ALWAYS include "@middleman" in your message to trigger escrow creation
- When agreeing, state the exact price and collateral amounts
- Do NOT use formal language — be casual like a Discord trader`;
}

function buildUserPrompt(ctx: NegotiationContext): string {
  const historyStr = ctx.messageHistory.length > 0
    ? ctx.messageHistory.map((m, i) => `  ${i + 1}. ${m}`).join("\n")
    : "  (No messages yet — you're starting the negotiation)";

  let prompt = `Current deal phase: ${ctx.currentPhase}

Message history:
${historyStr}`;

  if (ctx.middlemanResponse) {
    prompt += `\n\nMiddleman's latest response: "${ctx.middlemanResponse}"`;
  }

  prompt += `\n\nGenerate your next negotiation message. Reply with ONLY the message text, nothing else.`;

  return prompt;
}

function generateFallbackResponse(ctx: NegotiationContext): string {
  const step = ctx.messageHistory.length;

  if (ctx.role === "buyer") {
    const prices = [ctx.targetPrice * 0.8, ctx.targetPrice * 0.9, ctx.targetPrice, ctx.minAcceptable];
    const price = prices[Math.min(step, prices.length - 1)];

    if (step === 0) return `hey i want to buy ${ctx.asset}, i can do ${price} sol`;
    if (step <= 2) return `how about ${price} sol? thats fair`;
    if (step <= 4) return `ok final offer ${price} sol with ${ctx.collateral} sol collateral each`;
    return `ok lets do it then. ${price} sol and ${ctx.collateral} sol collateral. @middleman create escrow`;
  } else {
    const prices = [ctx.targetPrice, ctx.targetPrice * 0.95, ctx.targetPrice * 0.9, ctx.minAcceptable];
    const price = prices[Math.min(step, prices.length - 1)];

    if (step === 0) return `selling ${ctx.asset} for ${price} sol, collateral ${ctx.collateral} sol each side`;
    if (step <= 2) return `i can do ${price} sol but not less`;
    if (step <= 4) return `ok last offer ${price} sol with ${ctx.collateral} sol collateral. take it or leave it`;
    return `ok lets go further i am ready with ${price} sol and ${ctx.collateral} sol collateral. @middleman lets proceed`;
  }
}
