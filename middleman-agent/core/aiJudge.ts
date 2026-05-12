/**
 * Autonomous AI Judge (Level 4 Autonomy)
 *
 * This module evaluates deals that enter the "disputed" phase.
 * Instead of relying on manual human intervention, the LLM requests evidence
 * (like transaction hashes or chat logs) and renders a deterministic 
 * cryptographic verdict, either forcibly releasing funds or refunding via cancellation.
 */

import { loadConfig } from "../src/config";
import OpenAI from "openai";
import { dealPhaseManager } from "./dealPhaseManager";
import { MiddlemanAction } from "./middlemanBrain";
import { DealTerms } from "./outboundMessenger";
import { logger } from "../src/utils/logger";
import { vectorMemoryStore } from "../src/state/vectorMemoryStore";
import { getConnection } from "../src/solana/connection";
import { appendAuditLog } from "../src/services/auditTrail";

const MIN_CONFIDENCE_FOR_ACTION = 60; // Below this → deterministic CANCEL fallback

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const config = loadConfig();
    // Use the same LLM backend as the rest of the system (Groq/llama by default)
    // Falls back to OpenAI if LLM_BASE_URL is not set
    _client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.llmBaseUrl || undefined,
    });
  }
  return _client;
}

export interface AdjudicationResult {
  action: MiddlemanAction;
  verdictReasoning: string;
  confidence: number;
  splitRatios?: {
    buyerRefundPercent: number;
    sellerReleasePercent: number;
  };
}

export async function adjudicateDispute(
  ticket_id: string,
  terms: DealTerms | null
): Promise<AdjudicationResult> {
  if (!terms) {
    const result: AdjudicationResult = {
      action: "CANCEL_DEAL",
      verdictReasoning: "Cannot judge a dispute without established deal terms. Refunding both parties.",
      confidence: 100
    };
    appendAuditLog(ticket_id, "ai_judge_verdict", { ...result, reason: "no_terms" });
    return result;
  }

  try {
    const openai = getClient();

    // 1. Semantic Search for Dispute Evidence (RAG)
    const evidenceMemories = await vectorMemoryStore.searchSimilar({
      ticketId: ticket_id,
      query: "proof of payment transaction hash sent delivered link auth completion",
      limit: 15
    });

    const messagesContext = evidenceMemories.length > 0
      ? evidenceMemories.map(m => m.content).join("\n")
      : "[No semantic context found]";

    // 2. Extract potential Solana transaction signatures (Base58, ~88 chars)
    const txRegex = /[1-9A-HJ-NP-Za-km-z]{87,88}/g;
    const extractedHashes = messagesContext.match(txRegex) || [];
    const uniqueHashes = [...new Set(extractedHashes)];

    let txVerificationText = "";
    if (uniqueHashes.length > 0) {
      txVerificationText = "\n\nON-CHAIN EVIDENTIARY VERIFICATION:\n";
      const connection = getConnection();
      for (const hash of uniqueHashes) {
        try {
          // 5-second timeout to prevent hanging during Solana congestion
          const txPromise = connection.getTransaction(hash, { maxSupportedTransactionVersion: 0 });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TX_VERIFICATION_TIMEOUT')), 5000)
          );
          const tx = await Promise.race([txPromise, timeoutPromise]) as any;
          if (tx && !tx.meta?.err) {
            txVerificationText += `- Verified tx: ${hash} (Found and Confirmed on chain)\n`;
          } else if (tx && tx.meta?.err) {
            txVerificationText += `- Failed tx: ${hash} (Found but FAILED execution)\n`;
          } else {
            txVerificationText += `- Unverified tx: ${hash} (Not found on chain)\n`;
          }
        } catch (e: any) {
          if (e.message === 'TX_VERIFICATION_TIMEOUT') {
            txVerificationText += `- Timeout tx: ${hash} (Verification timed out — network congestion suspected, NOT equivalent to unverified)\n`;
          } else {
            txVerificationText += `- Unverified tx: ${hash} (Query error or not confirmed)\n`;
          }
        }
      }
    }

    // The strict prompt forcing the LLM to act as a cryptographic arbitrator.
    const prompt = `You are a strict, impartial AI crypto arbitrator adjudicating a disputed OTC deal on Solana.
The Deal terms were: Price: ${terms.price} SOL, Buyer Collateral: ${terms.collateral_buyer} SOL, Seller Collateral: ${terms.collateral_seller} SOL.

Review the following recent chat context (including claims and provided transaction hashes or proofs).
Determine if the seller successfully and provably delivered the goods/credentials to the buyer.
${txVerificationText}

Allowed Verdicts:
- "RELEASE_FUNDS" : The seller clearly provided proof of delivery (valid link, API key, or tx hash), or the buyer is maliciously refusing to release despite evidence. We must force payout to the seller.
- "CANCEL_DEAL"   : The seller failed to deliver, delivered invalid/fake goods, or no conclusive proof exists. We must refund both parties.
- "FRACTIONAL_SPLIT": The seller delivered a partial portion of the expected goods, or both parties share the fault in a misunderstood transaction. Distribute the payment accordingly.

You MUST choose one of the three verdicts. You cannot request more evidence.
Parse any URLs or transaction hashes carefully. If the seller provided a link/hash but the buyer claims it is fake, weigh the conversational evidence. If in absolute doubt, favor CANCEL_DEAL to safely refund both parties.

CONVERSATION LOG:
${messagesContext}

Respond ONLY in valid JSON with this structure:
{
  "verdict": "RELEASE_FUNDS" | "CANCEL_DEAL" | "FRACTIONAL_SPLIT",
  "reasoning": string, // Extremely concise legal reasoning
  "confidence": number, // 0-100 certainty
  "buyerRefundPercent": 0, // 0-100 (If FRACTIONAL_SPLIT is chosen, ensure the sum is 100)
  "sellerReleasePercent": 0 // 0-100 (If FRACTIONAL_SPLIT is chosen, ensure the sum is 100)
}`;

    const client = getClient();
    const config = loadConfig();
    const response = await client.chat.completions.create({
      model: config.llmModelJudge || config.llmModel,
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const outputString = response.choices[0].message.content;
    if (!outputString) throw new Error("Empty response from OpenAI");

    const parsed = JSON.parse(outputString);
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 50;

    // ── GUARDRAIL 3: Confidence Threshold ──
    // LOW CONFIDENCE → deterministic fallback: CANCEL and refund both
    if (confidence < MIN_CONFIDENCE_FOR_ACTION) {
      logger.warn("ai_judge_low_confidence_fallback", {
        ticket_id,
        confidence,
        llm_verdict: parsed.verdict,
      });
      const safeResult: AdjudicationResult = {
        action: "CANCEL_DEAL",
        verdictReasoning: `AI Judge confidence too low (${confidence}%). Safety fallback: cancelling deal and refunding both parties to prevent unjust outcome. Original LLM verdict was: ${parsed.verdict}`,
        confidence,
      };
      appendAuditLog(ticket_id, "ai_judge_verdict", { ...safeResult, guardrail: "low_confidence" });
      return safeResult;
    }

    // ── GUARDRAIL: FRACTIONAL_SPLIT ratios must sum to 100 ──
    if (parsed.verdict === "FRACTIONAL_SPLIT") {
      const buyerPct = typeof parsed.buyerRefundPercent === "number" ? parsed.buyerRefundPercent : 50;
      const sellerPct = typeof parsed.sellerReleasePercent === "number" ? parsed.sellerReleasePercent : 50;
      const sum = buyerPct + sellerPct;
      if (sum !== 100) {
        logger.warn("ai_judge_invalid_split_fallback", { ticket_id, buyerPct, sellerPct, sum });
        const safeResult: AdjudicationResult = {
          action: "CANCEL_DEAL",
          verdictReasoning: `Split ratios invalid (sum=${sum}%). Safety fallback: full refund to both parties.`,
          confidence: 0,
        };
        appendAuditLog(ticket_id, "ai_judge_verdict", { ...safeResult, guardrail: "invalid_split" });
        return safeResult;
      }
    }

    const result: AdjudicationResult = {
      action: parsed.verdict as MiddlemanAction,
      verdictReasoning: parsed.reasoning || "Ruled by AI Arbiter.",
      confidence,
      splitRatios: parsed.verdict === "FRACTIONAL_SPLIT" ? {
        buyerRefundPercent: typeof parsed.buyerRefundPercent === "number" ? parsed.buyerRefundPercent : 50,
        sellerReleasePercent: typeof parsed.sellerReleasePercent === "number" ? parsed.sellerReleasePercent : 50
      } : undefined
    };

    appendAuditLog(ticket_id, "ai_judge_verdict", result);
    return result;

  } catch (error: any) {
    logger.error("ai_judge_adjudication_failed", { ticket_id }, error);
    const failResult: AdjudicationResult = {
      action: "CANCEL_DEAL",
      verdictReasoning: `System failure during arbitration: ${error.message}. Safeguarding funds by cancelling.`,
      confidence: 0
    };
    appendAuditLog(ticket_id, "ai_judge_verdict", { ...failResult, guardrail: "system_failure" });
    return failResult;
  }
}
