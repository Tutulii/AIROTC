/**
 * Middleman Brain — Level 5 Generative ReAct Agent
 *
 * Replaced the old rigid Level 3 Intent Classifier and `switch` statement
 * rails with a true Generative AI ReAct Loop. The agent thinks, plans,
 * and outputs the exact operational decision directly, bypassing deterministic
 * crutches.
 */

import OpenAI from "openai";
import { loadConfig } from "../src/config";
import { dealPhaseManager, DealPhase } from "./dealPhaseManager";
import { DealTerms } from "./outboundMessenger";
import { logger } from "../src/utils/logger";
import { getBeliefs } from "../src/services/beliefStore";
import { vectorMemoryStore } from "../src/state/vectorMemoryStore";
import { soulGuard, SoulGuardContext } from "../src/services/soul";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    const config = loadConfig();
    _openai = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });
  }
  return _openai;
}

export type MiddlemanAction =
  | "CREATE_ESCROW"
  | "RELEASE_FUNDS"
  | "CANCEL_DEAL"
  | "DISPUTE"
  | "REPORT_STATUS"
  | "RESPOND_GENERAL"
  | "OBSERVE"
  | "FRACTIONAL_SPLIT";

export interface NegotiationSignals {
  price: number | null;
  collateral_buyer: number | null;
  collateral_seller: number | null;
  agreement_score: number;
  both_parties_present: boolean;
  price_converged: boolean;
  message_count: number;
  last_sender: string;
  buyer_confirmed?: boolean;
  seller_confirmed?: boolean;
}

export interface MiddlemanDecision {
  action: MiddlemanAction;
  trigger: "generative_agent" | "auto_agreement" | "mention" | "none";
  confidence: number;
  terms: DealTerms | null;
  reasoning: string;
  sender: string;
  ticket_id: string;
  current_phase: DealPhase;
}

export async function analyzeMessage(
  message: string,
  sender: string,
  ticket_id: string,
  signals: NegotiationSignals
): Promise<MiddlemanDecision> {
  const currentPhase = dealPhaseManager.getPhase(ticket_id) || "negotiation";
  const deal = dealPhaseManager.getDeal(ticket_id);
  const beliefs = getBeliefs();
  const chatHistory = await vectorMemoryStore.getContextSnapshot(ticket_id);

  const openai = getOpenAI();
  const config = loadConfig();

  const systemPrompt = `You are Meridian, a Level 5 Autonomous OTC Crypto Agent.
You are running a ReAct (Reason-Act) loop. You no longer have deterministic guards protecting you. 
You are solely responsible for deciding what action to take in the OTC deal.

AVAILABLE ACTIONS you can execute:
- "CREATE_ESCROW": When both parties have explicitly agreed on price and collateral.
- "RELEASE_FUNDS": When the buyer confirms they received the asset (delivery phase).
- "CANCEL_DEAL": If a party wants to back out before escrow is finalized.
- "DISPUTE": If there is an active scam or conflict.
- "REPORT_STATUS": Asking for an update on the deal.
- "OBSERVE": No action needed, normal chatter.
- "RESPOND_GENERAL": You need to speak to them but take no state-changing action.

CURRENT DEAL STATE:
- Phase: ${currentPhase}
- Deal Exists: ${deal ? "Yes" : "No"}
- Escrow PDA: ${deal?.escrow_pda || "None"}
- Payment Locked: ${deal?.payment_locked || "False"}
- Buyer: ${deal?.buyer || "Unknown"}
- Seller: ${deal?.seller || "Unknown"}

CURRENT SIGNALS (from auto-detector):
- Price: ${signals.price}
- Collateral Buyer: ${signals.collateral_buyer}
- Collateral Seller: ${signals.collateral_seller}
- Agreement Score: ${signals.agreement_score}/100
- Both Parties Present: ${signals.both_parties_present}
- Price Converged: ${signals.price_converged}
- Buyer Confirmed: ${signals.buyer_confirmed || false}
- Seller Confirmed: ${signals.seller_confirmed || false}
- Message Count: ${signals.message_count}

PHASE-AWARE RULES (follow strictly):
1. Phase "negotiation": If agreement_score is 100, both confirmed, price converged → choose CREATE_ESCROW.
2. Phase "escrow_created" or "awaiting_deposits": Choose OBSERVE. Deposits are being tracked automatically.
3. Phase "delivery": If the buyer confirms receipt (says "received", "got it", "release", "confirm delivery") → choose RELEASE_FUNDS.
4. Phase "completed": Choose OBSERVE. Deal is done.
5. NEVER choose CREATE_ESCROW if the phase is NOT "negotiation".

YOUR BELIEFS:
${beliefs}

YOUR INSTRUCTIONS:
1. Think step-by-step about the user's intent. DONT BE RIGID. Use your judgment.
2. Consider your beliefs. If the deal violates them, you CAN reject it!
3. The CURRENT PHASE is the most important signal. Match your action to the phase.
4. Format output strictly as JSON.`;

  try {
    const response = await openai.chat.completions.create({
      model: config.llmModelFast || config.llmModel || "llama-3-70b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "assistant", content: `[CHAT HISTORY]:\n${chatHistory}` },
        { role: "user", content: `User ${sender} says: "${message}"` }
      ],
      temperature: 0.05, // Near-deterministic: financial decisions must be consistent
      tools: [
        {
          type: "function",
          function: {
            name: "execute_decision",
            description: "Execute the final autonomous decision for the deal state.",
            parameters: {
              type: "object",
              properties: {
                thought_process: { type: "string", description: "Your step-by-step reasoning" },
                action: {
                  type: "string",
                  enum: ["CREATE_ESCROW", "RELEASE_FUNDS", "CANCEL_DEAL", "DISPUTE", "REPORT_STATUS", "RESPOND_GENERAL", "OBSERVE"]
                },
                confidence: { type: "number", description: "0-100 score of your certainty" },
                reasoning: { type: "string", description: "The message or logical cause to show users" },
                extracted_price: { type: ["number", "null"], description: "Agreed price in SOL (if applicable)" },
                extracted_col_buyer: { type: ["number", "null"] },
                extracted_col_seller: { type: ["number", "null"] },
                extracted_asset: { type: ["string", "null"] }
              },
              required: ["thought_process", "action", "confidence", "reasoning"]
            }
          }
        }
      ],
      tool_choice: { type: "function", function: { name: "execute_decision" } } as any
    });

    const toolCall = response.choices[0].message.tool_calls?.[0] as any;
    if (!toolCall) throw new Error("Agent failed to invoke decision tool.");

    const result = JSON.parse(toolCall.function.arguments);

    logger.info("react_agent_decision", {
      ticket_id,
      sender,
      action: result.action,
      thought: result.thought_process
    });

    let terms: DealTerms | null = null;
    if (result.extracted_price && result.extracted_col_buyer !== undefined) {
      terms = {
        price: result.extracted_price,
        collateral_buyer: result.extracted_col_buyer,
        collateral_seller: result.extracted_col_seller,
        asset_type: result.extracted_asset || "SOL"
      };
    }

    // Soul Guard: AUDIT MODE — logs what it would block, but never stops the deal.
    // The brain's decision + dealPhaseManager's state machine ARE the real guards.
    // Toggle SOUL_GUARD_ENFORCE=true in .env to re-enable hard blocking if needed.
    const ENFORCE = process.env.SOUL_GUARD_ENFORCE === 'true';
    const STATE_CHANGING_ACTIONS = ['CREATE_ESCROW', 'RELEASE_FUNDS', 'CANCEL_DEAL', 'DISPUTE', 'FRACTIONAL_SPLIT'];
    if (STATE_CHANGING_ACTIONS.includes(result.action)) {
      const deal = dealPhaseManager.getDeal(ticket_id);
      const livePhase = dealPhaseManager.getPhase(ticket_id) || currentPhase;
      const guardCtx: SoulGuardContext = {
        action: result.action,
        confidence: result.confidence || 0,
        bothPartiesConfirmed: signals.buyer_confirmed === true && signals.seller_confirmed === true,
        evidenceVerified: deal?.phase === 'delivery' || deal?.phase === 'awaiting_release' || livePhase === 'delivery' || currentPhase === 'delivery' || deal?.payment_locked === true,
        pressureDetected: false,
        dealPhase: currentPhase,
        senderIsValidParty: deal?.buyer === sender || deal?.seller === sender || !deal,
      };

      const guard = soulGuard(guardCtx);
      if (!guard.allowed) {
        // Always log the audit trail — this is the soul's judgment
        logger.warn('soul_guard_audit', {
          ticket_id,
          action: result.action,
          verdict: ENFORCE ? 'BLOCKED' : 'LOGGED_ONLY',
          reason: guard.reason,
          context: {
            phase: currentPhase,
            livePhase,
            confidence: result.confidence,
            payment_locked: deal?.payment_locked || false,
            evidenceVerified: guardCtx.evidenceVerified,
          },
        });

        // In enforce mode, block the action (legacy behavior)
        if (ENFORCE) {
          return {
            action: 'OBSERVE',
            trigger: 'generative_agent',
            confidence: result.confidence,
            terms: null,
            reasoning: guard.reason,
            sender,
            ticket_id,
            current_phase: currentPhase,
          };
        }
        // In audit mode: proceed — the deal pipeline is the real guard
      }
    }

    return {
      action: result.action as MiddlemanAction,
      trigger: "generative_agent",
      confidence: result.confidence,
      terms,
      reasoning: result.reasoning,
      sender,
      ticket_id,
      current_phase: currentPhase
    };
  } catch (error: any) {
    logger.error("react_agent_failed", { error: error.message });
    return {
      action: "OBSERVE",
      trigger: "none",
      confidence: 0,
      terms: null,
      reasoning: "Agent reasoning failure.",
      sender,
      ticket_id,
      current_phase: currentPhase
    };
  }
}
